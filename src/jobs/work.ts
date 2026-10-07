import { partitionByAuthor } from '../github/authors.js'
import type { Issue, PullRequest } from '../github/client.js'
import { isUrgent, priorityOf } from '../github/labels.js'
import { tail } from '../exec/run.js'
import { build } from './build.js'
import { block } from './common.js'
import { propose } from './propose.js'
import { sync } from './sync.js'
import type { Deps, JobResult } from './types.js'

export interface Candidate {
  kind: 'build' | 'propose'
  issue: Issue
}

const openWith = (prs: PullRequest[], prefix: string) => prs.filter(p => p.state === 'OPEN' && p.headRefName.startsWith(prefix)).length

/**
 * Pure: the next item, honouring WIP limits. Order: urgent first, then builds before proposals
 * (finish work before starting new work), then priority, then age. Urgent never bypasses WIP.
 */
export function pickNext(
  approved: Issue[],
  ready: Issue[],
  prs: PullRequest[],
  wip: { proposalsInReview: number; prsInReview: number },
): Candidate | null {
  const cands: Candidate[] = [
    ...(openWith(prs, 'change/') < wip.prsInReview ? approved.map(issue => ({ kind: 'build' as const, issue })) : []),
    ...(openWith(prs, 'proposal/') < wip.proposalsInReview ? ready.map(issue => ({ kind: 'propose' as const, issue })) : []),
  ]
  cands.sort(
    (a, b) =>
      Number(isUrgent(b.issue)) - Number(isUrgent(a.issue)) ||
      Number(a.kind === 'propose') - Number(b.kind === 'propose') ||
      priorityOf(a.issue) - priorityOf(b.issue) ||
      a.issue.number - b.issue.number,
  )
  return cands[0] ?? null
}

/** Sync, then build or propose exactly one item if the window and budget allow. */
export async function work(d: Deps, o: { ignoreBudget: boolean }): Promise<JobResult> {
  await sync(d)
  const trusted = async (label: string) => partitionByAuthor(await d.gh.listIssues(label), d.project.allowedAuthors).allowed
  const approved = await trusted('state:approved')
  const ready = (await trusted('state:ready')).filter(i => !i.labels.includes('type:spike'))
  const next = pickNext(approved, ready, await d.gh.listPrs(), d.project.wip)
  if (!next) return { outcome: 'noop', detail: 'queue empty or WIP limits reached' }

  if (!o.ignoreBudget) {
    const decision = await d.gate.check(next.kind, isUrgent(next.issue))
    if (!decision.ok) return { outcome: 'skipped', detail: decision.reason }
    if (decision.note) d.digest.add('🚨', `${decision.note}: #${next.issue.number} ${next.issue.title}`, next.issue.url)
  }

  d.log.info({ kind: next.kind, issue: next.issue.number, title: next.issue.title }, 'work: starting')
  try {
    const r = next.kind === 'build' ? await build(d, next.issue, o) : await propose(d, next.issue, o)
    return { ...r, kind: next.kind }
  } catch (e) {
    d.log.error({ err: e, issue: next.issue.number }, 'work: failed')
    const r = await block(d, next.issue, '```\n' + tail(e instanceof Error ? e.message : String(e), 60) + '\n```')
    return { ...r, outcome: 'error', kind: next.kind }
  }
}

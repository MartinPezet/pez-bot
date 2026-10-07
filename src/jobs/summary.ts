import { partitionByAuthor } from '../github/authors.js'
import type { Issue, PullRequest } from '../github/client.js'
import { STATES, stateOf } from '../github/labels.js'
import type { Deps, JobResult } from './types.js'

export const BLOCK_HEADER = '🚧 **Runner blocked**'

export interface SummaryInput {
  issues: Issue[]
  prs: PullRequest[]
  /** Latest block reason and how many times the runner has blocked it, per blocked issue. */
  blocked: Map<number, { reason: string; times: number }>
  now: Date
}

const DAY = 24 * 60 * 60_000
const link = (i: { number: number; url: string }) => `[#${i.number}](${i.url})`

/** Deterministic morning summary. Null when nothing needs attention, shipped, or looks off. */
export function buildSummary(s: SummaryInput): string | null {
  const by = (state: string) => s.issues.filter(i => stateOf(i) === state)
  const openPr = (pred: (p: PullRequest) => boolean) => s.prs.find(p => p.state === 'OPEN' && pred(p))

  const needs: string[] = []
  for (const i of by('state:pr-review')) {
    const pr = openPr(p => p.headRefName === `change/issue-${i.number}`)
    needs.push(`- 🔍 PR to review: ${pr ? link(pr) : '(PR not found)'} ${i.title} (${link(i)})`)
  }
  for (const i of by('state:proposal-review')) {
    const pr = openPr(p => p.headRefName.startsWith(`proposal/issue-${i.number}-`))
    needs.push(`- 📝 Proposal to review: ${pr ? link(pr) : '(PR not found)'} ${i.title} (${link(i)})`)
  }
  for (const i of by('state:blocked')) needs.push(`- 🚧 Blocked: ${link(i)} ${i.title}: ${s.blocked.get(i.number)?.reason || 'see the latest comment'}`)
  for (const i of by('state:needs-decision')) needs.push(`- ❓ Waiting on you: ${link(i)} ${i.title}`)

  const shipped = s.prs
    .filter(p => p.mergedAt && s.now.getTime() - Date.parse(p.mergedAt) < DAY)
    .map(p => `- ✅ ${link(p)} ${p.title}`)

  const flags: string[] = []
  for (const [n, b] of s.blocked) if (b.times >= 2) flags.push(`- #${n} has been blocked ${b.times} times.`)
  for (const p of s.prs) {
    const days = Math.floor((s.now.getTime() - Date.parse(p.createdAt)) / DAY)
    if (p.state === 'OPEN' && /^(proposal|change)\//.test(p.headRefName) && days > 3) flags.push(`- ${link(p)} has been open for ${days} days.`)
  }
  if (by('state:ready').length === 0 && by('state:approved').length === 0) flags.push('- The ready queue is empty, so the runner is idle.')

  if (!needs.length && !shipped.length && !flags.length) return null
  const counts = STATES.map(st => `${st.slice(6)} ${by(st).length}`).join(' · ')
  return [
    '### 🌅 Morning summary',
    needs.length ? `**Needs you now**\n${needs.join('\n')}` : '',
    shipped.length ? `**Shipped in the last 24 h**\n${shipped.join('\n')}` : '',
    `**Pipeline**: ${counts}`,
    flags.length ? `**Flags**\n${flags.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** No LLM call: reads GitHub and posts one section to the digest. */
export async function summary(d: Deps): Promise<JobResult> {
  const issues = partitionByAuthor(await d.gh.listIssues(), d.project.allowedAuthors).allowed
  const prs = await d.gh.listPrs()
  const blocked = new Map<number, { reason: string; times: number }>()
  for (const i of issues.filter(x => stateOf(x) === 'state:blocked')) {
    const ours = (await d.gh.issueComments(i.number)).filter(c => c.author === d.botLogin && c.body.startsWith(BLOCK_HEADER))
    const last = ours.at(-1)
    const reason = last?.body.slice(BLOCK_HEADER.length).trim().split('\n').find(l => l.trim() && !l.startsWith('```'))?.slice(0, 160) ?? ''
    blocked.set(i.number, { reason, times: ours.length })
  }
  const md = buildSummary({ issues, prs, blocked, now: d.now() })
  if (!md) return { outcome: 'noop', detail: 'nothing to report' }
  d.digest.addSection(md)
  return { outcome: 'ok' }
}

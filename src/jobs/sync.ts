import { partitionByAuthor } from '../github/authors.js'
import type { Issue, PullRequest } from '../github/client.js'
import { setState, stateOf } from '../github/labels.js'
import { kv } from '../state/db.js'
import { block } from './common.js'
import type { Deps, JobResult } from './types.js'

/**
 * No Claude. Recovers issues left mid-job by a dead run (requeue, or block on the second time
 * in 24 h), promotes proposal PRs (merged → approved, closed → needs-decision), and notes
 * issues from authors outside the allowlist once. The default branch is fetched by the job runner.
 */
export async function sync(d: Deps): Promise<JobResult> {
  const { allowed, ignored } = partitionByAuthor(await d.gh.listIssues(), d.project.allowedAuthors)
  noteIgnored(d, ignored)

  let changed = 0
  for (const issue of allowed) {
    const s = stateOf(issue)
    if (s === 'state:proposing' || s === 'state:building') {
      await recover(d, issue, s)
      changed++
    }
  }
  const prs = await d.gh.listPrs()
  for (const issue of allowed.filter(i => stateOf(i) === 'state:proposal-review')) {
    if (await promote(d, issue, prs)) changed++
  }
  return { outcome: changed ? 'ok' : 'noop', detail: `${changed} issue(s) moved` }
}

const DAY_MS = 24 * 60 * 60_000

/** We hold the job lease, so anything still "in progress" died with a previous run. */
async function recover(d: Deps, issue: Issue, s: 'state:proposing' | 'state:building') {
  const key = `recovered.${issue.number}`
  const now = d.now()
  const recent = (kv.getJson<string[]>(d.db, key) ?? []).filter(t => now.getTime() - Date.parse(t) < DAY_MS)
  if (recent.length > 0) {
    kv.del(d.db, key)
    await block(d, issue, `The runner was interrupted twice in 24 hours while this issue was in \`${s}\`. Check the runner logs before retrying.`)
    return
  }
  kv.setJson(d.db, key, [...recent, now.toISOString()])
  const queue = s === 'state:proposing' ? 'state:ready' : 'state:approved'
  await setState(d.gh, issue, queue)
  await d.gh.comment(
    issue.number,
    `♻️ The runner stopped mid-job (restart or crash) while this was in \`${s}\`. Requeued to \`${queue}\`; ` +
      (queue === 'state:approved' ? `the next build resumes from \`change/issue-${issue.number}\` if it exists.` : 'it will be proposed again.'),
  )
  d.digest.add('♻️', `Requeued #${issue.number} ${issue.title} after an interrupted run`, issue.url)
}

/** The newest proposal PR for the issue decides: merged = approved, closed = needs a decision. */
export async function promote(d: Deps, issue: Issue, prs: PullRequest[]): Promise<boolean> {
  const latest = prs
    .filter(p => p.headRefName.startsWith(`proposal/issue-${issue.number}-`))
    .sort((a, b) => b.number - a.number)[0]
  if (!latest || latest.state === 'OPEN') return false
  if (latest.state === 'MERGED') {
    await setState(d.gh, issue, 'state:approved')
    d.digest.add('✅', `Proposal approved for #${issue.number} ${issue.title}`, latest.url)
  } else {
    await setState(d.gh, issue, 'state:needs-decision')
    await d.gh.comment(
      issue.number,
      `Proposal ${latest.url} was closed without merging. Comment on what should change, then relabel \`state:ready\` to re-propose.`,
    )
    d.digest.add('❌', `Proposal rejected for #${issue.number} ${issue.title}`, latest.url)
  }
  return true
}

/** Issues by other authors are never processed; say so once per issue. */
function noteIgnored(d: Deps, ignored: Issue[]) {
  for (const i of ignored) {
    if (!i.labels.some(l => l.startsWith('state:'))) continue
    const key = `ignored.${i.number}`
    if (kv.get(d.db, key)) continue
    kv.set(d.db, key, '1')
    d.digest.add('🙈', `Ignoring #${i.number}: @${i.author} is not in allowedAuthors`, i.url)
  }
}

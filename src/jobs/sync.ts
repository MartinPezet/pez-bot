import { partitionByAuthor } from '../github/authors.js'
import type { FailedCheck, Issue, PullRequest } from '../github/client.js'
import { setState, stateOf } from '../github/labels.js'
import { tail } from '../exec/run.js'
import { kv } from '../state/db.js'
import { block, CI_FIX_ATTEMPTS, CI_FIX_FAILURE } from './common.js'
import type { Deps, JobResult } from './types.js'

/**
 * No Claude. Recovers issues left mid-job by a dead run (requeue, or block on the second time
 * in 24 h), promotes proposal PRs (merged → approved, closed → needs-decision), handles review PRs
 * that failed CI (back to the build with the log, or blocked), and notes issues from authors outside the allowlist once. The default branch is fetched by the job runner.
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
  for (const issue of allowed.filter(i => stateOf(i) === 'state:proposal-review' || stateOf(i) === 'state:pr-review')) {
    if (await handleFailedCi(d, issue, prs)) changed++
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

/**
 * A review PR with failed CI isn't ready for review; pending or green CI leaves it alone.
 * An implementation PR goes back to the build with the CI log, up to `maxFixAttempts` times.
 * Everything else blocks: proposals (rarely their fault), no readable log (a fix would be blind).
 */
async function handleFailedCi(d: Deps, issue: Issue, prs: PullRequest[]): Promise<boolean> {
  const n = issue.number
  const pr = prs.find(p => p.state === 'OPEN' && (p.headRefName === `change/issue-${n}` || p.headRefName.startsWith(`proposal/issue-${n}-`)))
  if (!pr) return false
  // An App without the Checks/Commit statuses permission can't read CI; don't fail the whole sync over it.
  const failed = await d.gh.failedChecks(pr.number).catch(err => {
    d.log.warn({ err, pr: pr.number }, 'could not read CI status')
    return []
  })
  if (!failed.length) return false

  const names = failed.map(c => `\`${c.name}\``).join(', ')
  const failure = `CI failed on ${pr.url}: ${names}.`
  const stop = async (why: string) => {
    await block(d, issue, `${failure}${why} Fix it on \`${pr.headRefName}\`.`)
    return true
  }
  if (stateOf(issue) !== 'state:pr-review') return stop('')

  // ponytail: attempts count per issue until it blocks, so green CI in between doesn't reset them.
  const attempts = Number(kv.get(d.db, CI_FIX_ATTEMPTS(n)) ?? 0)
  if (attempts >= d.project.maxFixAttempts) return stop(` Gave up after ${attempts} fix attempt(s).`)
  const logs = await ciLogs(d, failed)
  if (!logs) return stop(' The runner could not read the CI log, so it did not try a fix.')

  kv.set(d.db, CI_FIX_ATTEMPTS(n), String(attempts + 1))
  kv.set(d.db, CI_FIX_FAILURE(n), `${failure} This ran on GitHub Actions, so it may not reproduce locally.\n\n${logs}`)
  await setState(d.gh, issue, 'state:approved')
  await d.gh.comment(n, `🔁 ${failure} Sending it back to the runner to fix (attempt ${attempts + 1} of ${d.project.maxFixAttempts}).`)
  d.digest.add('🔁', `CI failed on #${n} ${issue.title}; sent back to fix (${names.replace(/`/g, '')})`, pr.url)
  return true
}

/** Log tails of the failed jobs for the fix prompt, bounded so a noisy matrix can't flood it. */
async function ciLogs(d: Deps, failed: FailedCheck[]): Promise<string> {
  const parts: string[] = []
  for (const check of failed.slice(0, 3)) {
    const log = await d.gh.checkLog(check).catch(err => {
      d.log.warn({ err, check: check.name }, 'could not read CI log')
      return null
    })
    if (log) parts.push(`--- ${check.name} ---\n${tail(log, 200).slice(-20_000)}`)
  }
  return parts.join('\n\n')
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

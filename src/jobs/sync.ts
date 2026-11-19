import { isAllowedAuthor, partitionByAuthor, renderComments } from '../github/authors.js'
import type { FailedCheck, Issue, PullRequest } from '../github/client.js'
import { setState, stateOf } from '../github/labels.js'
import { tail } from '../exec/run.js'
import { kv } from '../state/db.js'
import { block, CI_FIX_ATTEMPTS, CI_FIX_FAILURE, CI_READ_PERMISSIONS, CI_UNREADABLE, REVIEW_FEEDBACK, REVIEW_SEEN } from './common.js'
import type { Deps, JobResult } from './types.js'

/**
 * No Claude. Recovers issues left mid-job by a dead run (requeue, or block on the second time
 * in 24 h), sends implementation PRs that failed CI or got review comments back to the build
 * (or blocks them), and notes issues from authors outside the allowlist once. The default branch is fetched by the job runner.
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
  for (const issue of allowed.filter(i => stateOf(i) === 'state:pr-review')) {
    if (await handleFailedCi(d, issue, prs)) changed++
    else if (await handleReviewFeedback(d, issue, prs)) changed++
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

/**
 * An implementation PR with failed CI isn't ready for review; pending or green CI leaves it alone.
 * It goes back to the build with the CI log, up to `maxFixAttempts` times. No readable log blocks
 * (a fix would be blind).
 */
async function handleFailedCi(d: Deps, issue: Issue, prs: PullRequest[]): Promise<boolean> {
  const n = issue.number
  const pr = prs.find(p => p.state === 'OPEN' && p.headRefName === `change/issue-${n}`)
  if (!pr) return false
  // Unreadable CI is unknown, not green: say so once per PR, or a red PR sits in review forever.
  // Don't fail the whole sync over it (an App without Checks/Commit statuses read can't see CI).
  const unreadable = CI_UNREADABLE(pr.number)
  const failed = await d.gh.failedChecks(pr.number).catch(async err => {
    d.log.error({ err, pr: pr.number }, 'could not read CI status')
    if (!kv.get(d.db, unreadable)) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 300)
      kv.set(d.db, unreadable, msg)
      await d.gh.comment(
        n,
        `❌ **Runner error**: couldn't read CI on ${pr.url}, so a failure there won't be sent back to fix. ${CI_READ_PERMISSIONS}\n\n\`\`\`\n${msg}\n\`\`\``,
      )
      d.digest.add('⚠️', `Can't read CI on #${n} ${issue.title}, so a failure there won't be fixed. ${CI_READ_PERMISSIONS}`, pr.url)
    }
    return null
  })
  if (!failed) return false
  kv.del(d.db, unreadable)
  if (!failed.length) return false

  const names = failed.map(c => `\`${c.name}\``).join(', ')
  const failure = `CI failed on ${pr.url}: ${names}.`
  const stop = async (why: string) => {
    await block(d, issue, `${failure}${why} Fix it on \`${pr.headRefName}\`.`)
    return true
  }

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

/**
 * New comments from allowed authors on an open implementation PR (conversation, review bodies,
 * inline) send the issue back to the build, which addresses them on the same branch.
 * The first sight of a PR counts every earlier comment, since none were ever handed over.
 */
async function handleReviewFeedback(d: Deps, issue: Issue, prs: PullRequest[]): Promise<boolean> {
  const n = issue.number
  if (stateOf(issue) !== 'state:pr-review') return false
  const pr = prs.find(p => p.state === 'OPEN' && p.headRefName === `change/issue-${n}`)
  if (!pr) return false
  const seen = kv.get(d.db, REVIEW_SEEN(pr.number)) ?? ''
  // Allowed authors only: these comments go into a prompt. The bot's own never count as feedback.
  const fresh = [...(await d.gh.issueComments(pr.number)), ...(await d.gh.prReviewComments(pr.number))]
    .filter(c => isAllowedAuthor(c.author, d.project.allowedAuthors) && c.createdAt > seen)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const newest = fresh.at(-1)
  if (!newest) return false

  const earlier = kv.get(d.db, REVIEW_FEEDBACK(n))
  kv.set(d.db, REVIEW_FEEDBACK(n), [earlier, renderComments(fresh)].filter(Boolean).join('\n\n---\n\n'))
  kv.set(d.db, REVIEW_SEEN(pr.number), newest.createdAt)
  await setState(d.gh, issue, 'state:approved')
  await d.gh.comment(n, `💬 ${fresh.length} new review comment(s) on ${pr.url}. Sending it back to the runner to address them.`)
  d.digest.add('💬', `Review feedback on #${n} ${issue.title}; sent back to address it`, pr.url)
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

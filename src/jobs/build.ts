import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { Issue } from '../github/client.js'
import { isUrgent, setState } from '../github/labels.js'
import { tail } from '../exec/run.js'
import {
  agentEnv, askClaude, block, CI_FIX_FAILURE, FATAL_CLAUDE_ERRORS, gatesText, gateJudge, isPause, type JudgedGates, pause, pushAndOpenPr,
  resetTestServices, REVIEW_FEEDBACK, runGates, stopSignal, sumCost, testServiceProblems,
} from './common.js'
import { kv } from '../state/db.js'
import type { Deps, JobResult } from './types.js'

/** The reviewed change for an issue, or an archived one (a resumed run that already archived). */
export function findChange(dir: string, n: number): { id: string; archived: boolean } | null {
  const changes = path.join(dir, 'openspec', 'changes')
  const list = (p: string) => (existsSync(p) ? readdirSync(p) : [])
  const live = list(changes).find(c => c.startsWith(`issue-${n}-`))
  if (live) return { id: live, archived: false }
  const archived = list(path.join(changes, 'archive')).find(c => new RegExp(`(^|-)issue-${n}-`).test(c))
  return archived ? { id: archived.replace(/^\d{4}-\d{2}-\d{2}-/, ''), archived: true } : null
}

function gateNote(d: Deps, gate: { preExisting?: boolean; log: string }): string {
  if (!gate.preExisting) return `✅ Gates passed: ${gatesText(d)}`
  return `⚠️ Gates failed only with errors already present on \`${d.branch}\`; this change adds none. Fix them in a separate change.

\`\`\`
${tail(gate.log, 30)}
\`\`\``
}

/**
 * Reviewed change (pushed to `change/issue-N` by propose) → apply → gates → fix loop → implementation PR. Resumes from an existing
 * `change/issue-N` branch (merging the default branch in first); paused runs are pushed there.
 * After failed CI or new review comments (sync records them) it skips apply and starts the fix
 * loop from the CI log, or else the comments.
 */
export async function build(d: Deps, issue: Issue, o: { ignoreBudget: boolean }): Promise<JobResult> {
  const n = issue.number
  const branch = `change/issue-${n}`
  const urgent = isUrgent(issue)

  // A sidecar on the wrong major version isn't the issue's fault: hold builds (no state change) and say so once.
  const problems = await testServiceProblems(d.run, d.env, d.project)
  const reported = kv.get(d.db, 'testservices.problem')
  if (problems.length) {
    const text = problems.join('; ')
    if (reported !== text) {
      kv.set(d.db, 'testservices.problem', text)
      d.log.error({ problems }, 'test services do not match the project config; builds are held')
      d.digest.add('🧪', `Builds held: ${text}`)
    }
    return { outcome: 'skipped', detail: text }
  }
  if (reported) kv.del(d.db, 'testservices.problem')

  await setState(d.gh, issue, 'state:building')

  const { dir, resumed } = await d.wt.resume(branch)
  if (resumed && (await d.wt.mergeDefault(dir)) === 'conflict') {
    return block(
      d, issue,
      `Merging \`${d.branch}\` into the paused branch \`${branch}\` conflicts. Resolve it on the branch (or delete the branch to start over), then relabel \`state:approved\`.`,
      dir,
    )
  }

  const change = findChange(dir, n)
  if (!change) return block(d, issue, `No \`openspec/changes/issue-${n}-*\` on \`${branch}\` or \`${d.branch}\`. Relabel \`state:ready\` to propose it again.`, dir)

  const [icmd = '', ...iargs] = d.project.install
  const inst = await d.run(icmd, iargs, { as: 'agent', cwd: dir, env: agentEnv(d, dir), timeoutMs: 30 * 60_000 })
  if (inst.exitCode !== 0) return block(d, issue, `Install failed:\n\`\`\`\n${tail(inst.all, 60)}\n\`\`\``, dir, branch)

  const vars = {
    PROJECT_NAME: d.project.displayName,
    ISSUE_NUMBER: String(n),
    ISSUE_TITLE: issue.title,
    CHANGE_ID: change.id,
    DEFAULT_BRANCH: d.branch,
    GATES: gatesText(d),
  }
  const ciFailure = kv.get(d.db, CI_FIX_FAILURE(n))
  // CI first: review feedback waits in kv and the next round picks it up.
  const feedback = ciFailure ? undefined : kv.get(d.db, REVIEW_FEEDBACK(n))
  const commitsBefore = await d.wt.commitsAhead(dir)
  let cost = { estCostUsd: 0, turns: 0 }
  let text = ''
  const applies = !change.archived && !ciFailure && !feedback
  if (applies) {
    const res = await askClaude(d, { model: 'build', tools: 'build', prompt: await d.prompt('apply', vars), cwd: dir, urgent, ignoreBudget: o.ignoreBudget })
    cost = sumCost(cost, res)
    if (isPause(res)) return { ...(await pause(d, issue, res, 'state:approved', dir, branch)), ...cost }
    if (!res.ok && res.error && FATAL_CLAUDE_ERRORS.includes(res.error)) {
      return { ...(await block(d, issue, `Claude Code failed: \`${res.error}\`. Check the runner's Claude credentials.`, dir, branch)), ...cost }
    }
    if (res.stopReason === 'timeout') {
      return { ...(await block(d, issue, `The implementation run timed out after ${d.project.claude.timeoutMin} minutes.`, dir, branch)), ...cost }
    }
    text = res.text
  }

  let sig = stopSignal(text)
  await resetTestServices(d)
  const judge = gateJudge(d)
  const first = ciFailure ?? feedback
  let gate: JudgedGates = sig ? { ok: false, log: '' } : first ? { ok: false, log: first } : await judge(await runGates(d, dir))
  for (let i = 0; !sig && !gate.ok && i < d.project.maxFixAttempts; i++) {
    d.log.info({ issue: n, attempt: i + 1 }, 'gates failed, fixing')
    const fix = await askClaude(d, {
      model: 'fix', tools: 'build', cwd: dir, urgent, ignoreBudget: o.ignoreBudget,
      // A CI log was never compared with the default branch, so it can't use the `fix` prompt's claims about that.
      prompt: ciFailure && i === 0
        ? await d.prompt('fix-ci', { ...vars, CI_OUTPUT: ciFailure })
        : feedback && i === 0
        ? await d.prompt('fix-review', { ...vars, FEEDBACK: feedback })
        : await d.prompt('fix', { ...vars, GATE_OUTPUT: gate.log, NEW_ERRORS: (gate.newErrors ?? []).join('\n') || '(none identified)' }),
    })
    cost = sumCost(cost, fix)
    if (isPause(fix)) return { ...(await pause(d, issue, fix, 'state:approved', dir, branch)), ...cost }
    if (fix.text) text = fix.text
    sig = stopSignal(fix.text)
    if (!sig) {
      await resetTestServices(d)
      gate = await judge(await runGates(d, dir))
    }
  }

  await d.wt.commit(dir, `chore: runner leftovers (#${n})`)
  if (sig) return { ...(await block(d, issue, `Agent stopped: **${sig.kind}**\n\n${sig.detail}`, dir, branch)), ...cost }
  if (!gate.ok) {
    return {
      ...(await block(d, issue, `Gates still failing after ${d.project.maxFixAttempts} fix attempts:\n\`\`\`\n${tail(gate.log, 60)}\n\`\`\``, dir, branch)),
      ...cost,
    }
  }
  // The branch starts with the spec commit, so count from where this run began.
  // ponytail: a resumed run whose earlier checkpoint already held every task also lands here; rare, and the block says why.
  if (applies && (await d.wt.commitsAhead(dir)) === commitsBefore) return { ...(await block(d, issue, 'Agent produced no commits.', dir)), ...cost }
  // Pushing nothing would leave the same red commit for sync to find again.
  if (ciFailure && (await d.wt.commitsAhead(dir)) === commitsBefore) {
    return { ...(await block(d, issue, `Agent made no commits to fix CI:\n\n${text.slice(0, 2000)}`, dir)), ...cost }
  }
  // Feedback can be a question, or ask for nothing in the code: reply and hand the PR back for review.
  if (feedback && (await d.wt.commitsAhead(dir)) === commitsBefore) {
    kv.del(d.db, REVIEW_FEEDBACK(n))
    await setState(d.gh, issue, 'state:pr-review')
    await d.gh.comment(n, `💬 Read the review comments but changed nothing:\n\n${text.slice(0, 4000)}`)
    return { outcome: 'ok', issue: n, detail: 'review feedback: no changes', worktree: dir, ...cost }
  }

  const url = await pushAndOpenPr(
    d, dir, branch, `${issue.title} (#${n})`,
    `Implements \`openspec/changes/${change.id}\`. The proposal, written and reviewed by agents, is part of this PR: review it first.\n\n${text.slice(0, 4000)}\n\n${gateNote(d, gate)}\n\nCloses #${n}`,
  )
  await setState(d.gh, issue, 'state:pr-review')
  kv.del(d.db, CI_FIX_FAILURE(n))
  if (feedback) kv.del(d.db, REVIEW_FEEDBACK(n))
  const done = ciFailure ? 'CI fix pushed' : feedback ? 'Review feedback addressed' : 'Implementation PR opened'
  await d.gh.comment(n, ciFailure ? `🔧 Pushed a CI fix: ${url}` : feedback ? `🔧 Addressed the review comments: ${url}` : `✅ Implementation PR ready: ${url}`)
  d.digest.add(ciFailure || feedback ? '🔧' : '🚀', `${done} for #${n} ${issue.title}`, url)
  return { outcome: 'ok', issue: n, detail: url, worktree: dir, ...cost }
}

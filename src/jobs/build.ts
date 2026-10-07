import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { Issue } from '../github/client.js'
import { isUrgent, setState } from '../github/labels.js'
import { tail } from '../exec/run.js'
import {
  agentEnv, askClaude, block, FATAL_CLAUDE_ERRORS, gatesText, isPause, pause, pushAndOpenPr,
  resetTestServices, runGates, stopSignal, sumCost,
} from './common.js'
import type { Deps, JobResult } from './types.js'

/** The approved change for an issue, or an archived one (a resumed run that already archived). */
export function findChange(dir: string, n: number): { id: string; archived: boolean } | null {
  const changes = path.join(dir, 'openspec', 'changes')
  const list = (p: string) => (existsSync(p) ? readdirSync(p) : [])
  const live = list(changes).find(c => c.startsWith(`issue-${n}-`))
  if (live) return { id: live, archived: false }
  const archived = list(path.join(changes, 'archive')).find(c => new RegExp(`(^|-)issue-${n}-`).test(c))
  return archived ? { id: archived.replace(/^\d{4}-\d{2}-\d{2}-/, ''), archived: true } : null
}

/**
 * Approved change → apply → gates → fix loop → implementation PR. Resumes from an existing
 * `change/issue-N` branch (merging the default branch in first); paused runs are pushed there.
 */
export async function build(d: Deps, issue: Issue, o: { ignoreBudget: boolean }): Promise<JobResult> {
  const n = issue.number
  const branch = `change/issue-${n}`
  const urgent = isUrgent(issue)
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
  if (!change) return block(d, issue, `No \`openspec/changes/issue-${n}-*\` on \`${d.branch}\`. Was the proposal merged?`, dir)

  const [icmd = '', ...iargs] = d.project.install
  const inst = await d.run(icmd, iargs, { as: 'agent', cwd: dir, env: agentEnv(d), timeoutMs: 30 * 60_000 })
  if (inst.exitCode !== 0) return block(d, issue, `Install failed:\n\`\`\`\n${tail(inst.all, 60)}\n\`\`\``, dir, branch)

  const vars = {
    PROJECT_NAME: d.project.displayName,
    ISSUE_NUMBER: String(n),
    ISSUE_TITLE: issue.title,
    CHANGE_ID: change.id,
    DEFAULT_BRANCH: d.branch,
    GATES: gatesText(d),
  }
  let cost = { estCostUsd: 0, turns: 0 }
  let text = ''
  if (!change.archived) {
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
  let gate = sig ? { ok: false, log: '' } : await runGates(d, dir)
  for (let i = 0; !sig && !gate.ok && i < d.project.maxFixAttempts; i++) {
    d.log.info({ issue: n, attempt: i + 1 }, 'gates failed, fixing')
    const fix = await askClaude(d, {
      model: 'fix', tools: 'build', prompt: await d.prompt('fix', { ...vars, GATE_OUTPUT: gate.log }), cwd: dir, urgent, ignoreBudget: o.ignoreBudget,
    })
    cost = sumCost(cost, fix)
    if (isPause(fix)) return { ...(await pause(d, issue, fix, 'state:approved', dir, branch)), ...cost }
    if (fix.text) text = fix.text
    sig = stopSignal(fix.text)
    if (!sig) {
      await resetTestServices(d)
      gate = await runGates(d, dir)
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
  if ((await d.wt.commitsAhead(dir)) === 0) return { ...(await block(d, issue, 'Agent produced no commits.', dir)), ...cost }

  const url = await pushAndOpenPr(
    d, dir, branch, `${issue.title} (#${n})`,
    `Implements \`openspec/changes/${change.id}\`.\n\n${text.slice(0, 4000)}\n\n✅ Gates passed: ${gatesText(d)}\n\nCloses #${n}`,
  )
  await setState(d.gh, issue, 'state:pr-review')
  await d.gh.comment(n, `✅ Implementation PR ready: ${url}`)
  d.digest.add('🚀', `Implementation PR opened for #${n} ${issue.title}`, url)
  return { outcome: 'ok', issue: n, detail: url, worktree: dir, ...cost }
}

import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Issue } from '../github/client.js'
import { isUrgent, setState } from '../github/labels.js'
import { tail } from '../exec/run.js'
import { agentEnv, askClaude, block, FATAL_CLAUDE_ERRORS, firstLine, isPause, pause, pushAndOpenPr, slug, stopSignal, sumCost, trustedThread } from './common.js'
import type { Deps, JobResult } from './types.js'

/** Issue → OpenSpec proposal → `openspec validate --strict` → proposal PR. */
export async function propose(d: Deps, issue: Issue, o: { ignoreBudget: boolean }): Promise<JobResult> {
  const n = issue.number
  const changeId = `issue-${n}-${slug(issue.title)}`
  const branch = `proposal/${changeId}`
  const urgent = isUrgent(issue)
  await setState(d.gh, issue, 'state:proposing')
  const dir = await d.wt.fresh(branch)
  let cost = { estCostUsd: 0, turns: 0 }

  const prompt = await d.prompt('propose', {
    PROJECT_NAME: d.project.displayName,
    ISSUE_NUMBER: String(n),
    ISSUE_TITLE: issue.title,
    ISSUE_BODY: issue.body,
    ISSUE_COMMENTS: await trustedThread(d, n),
    CHANGE_ID: changeId,
    DEFAULT_BRANCH: d.branch,
  })
  const res = await askClaude(d, { model: 'propose', tools: 'propose', prompt, cwd: dir, urgent, ignoreBudget: o.ignoreBudget })
  cost = sumCost(cost, res)
  // A proposal is cheap to redo, so a paused one is discarded rather than pushed.
  if (isPause(res)) return { ...(await pause(d, issue, res, 'state:ready', dir)), ...cost }
  if (!res.ok && res.error && FATAL_CLAUDE_ERRORS.includes(res.error)) {
    return { ...(await block(d, issue, `Claude Code failed: \`${res.error}\`. Check the runner's Claude credentials.`)), ...cost }
  }

  const sig = stopSignal(res.text)
  if (sig) {
    await setState(d.gh, issue, 'state:needs-decision')
    await d.gh.comment(n, `🤖 Couldn't write a proposal yet: **${sig.kind}**\n\n${sig.detail}`)
    d.digest.add('❓', `${sig.kind === 'NEEDS_SPLIT' ? 'Split suggested' : 'Question'} on #${n} ${issue.title}: ${firstLine(sig.detail)}`, issue.url)
    return { outcome: 'ok', issue: n, detail: sig.kind, worktree: dir, ...cost }
  }

  const changeDir = path.join(dir, 'openspec', 'changes', changeId)
  if (!existsSync(changeDir)) {
    return {
      ...(await block(d, issue, `Agent finished without creating \`openspec/changes/${changeId}\`${res.ok ? '' : ` (${res.stopReason}, ${res.error ?? 'no error'})`}.\n\n${tail(res.text, 30)}`)),
      ...cost,
    }
  }

  let v = await validate(d, dir, changeId)
  if (!v.ok) {
    const fix = await askClaude(d, {
      model: 'propose',
      tools: 'propose',
      prompt: await d.prompt('validate-fix', { CHANGE_ID: changeId, VALIDATE_OUTPUT: tail(v.log, 80) }),
      cwd: dir,
      urgent,
      ignoreBudget: o.ignoreBudget,
    })
    cost = sumCost(cost, fix)
    if (isPause(fix)) return { ...(await pause(d, issue, fix, 'state:ready', dir)), ...cost }
    v = await validate(d, dir, changeId)
    if (!v.ok) return { ...(await block(d, issue, `Proposal fails validation:\n\`\`\`\n${tail(v.log, 40)}\n\`\`\``)), ...cost }
  }

  // Only the change folder is committed; stray edits die with the worktree.
  await d.wt.commit(dir, `spec: propose ${changeId} (#${n})`, [`openspec/changes/${changeId}`])
  const url = await pushAndOpenPr(
    d, dir, branch, `Proposal: ${issue.title} (#${n})`,
    `OpenSpec proposal for #${n}.\n\n` +
      '> **Merge = approve for implementation.** Close without merging = back to `state:needs-decision`.\n\n' +
      `${res.text.slice(0, 4000)}\n\nRefs #${n}`,
  )
  await setState(d.gh, issue, 'state:proposal-review')
  await d.gh.comment(n, `📝 Proposal ready for review: ${url}`)
  d.digest.add('📝', `Proposal opened for #${n} ${issue.title}`, url)
  return { outcome: 'ok', issue: n, detail: url, worktree: dir, ...cost }
}

async function validate(d: Deps, dir: string, changeId: string) {
  const r = await d.run('openspec', ['validate', changeId, '--strict', '--no-interactive'], { as: 'agent', cwd: dir, env: agentEnv(d) })
  return { ok: r.exitCode === 0, log: r.all }
}

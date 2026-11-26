import { existsSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { Issue } from '../github/client.js'
import { isUrgent, setState } from '../github/labels.js'
import { tail } from '../exec/run.js'
import type { ClaudeResult } from '../exec/claude.js'
import {
  agentEnv, askClaude, block, cliJsonSchema, FATAL_CLAUDE_ERRORS, firstLine, isPause, pause, slug, stopSignal, sumCost, trustedThread,
} from './common.js'
import type { Deps, JobResult } from './types.js'

/** What the reviewer must return. The runner re-validates it; an unusable verdict is never a pass. */
export const proposalReviewSchema = z.object({
  verdict: z.enum(['pass', 'revise', 'needs-decision']),
  gaps: z.array(z.string()).default([]),
  questions: z.array(z.string()).default([]),
  notes: z.string().default(''),
})
export type ProposalReview = z.infer<typeof proposalReviewSchema>

/**
 * Issue → OpenSpec proposal → `openspec validate --strict` → review by a second agent with a
 * fresh context (revised up to `maxFixAttempts` times) → spec commit pushed to `change/issue-N`
 * and the issue approved. No PR: the owner reviews the spec inside the implementation PR.
 */
export async function propose(d: Deps, issue: Issue, o: { ignoreBudget: boolean }): Promise<JobResult> {
  const n = issue.number
  const changeId = `issue-${n}-${slug(issue.title)}`
  const branch = `change/issue-${n}`
  const urgent = isUrgent(issue)
  await setState(d.gh, issue, 'state:proposing')
  // Re-proposing starts over: the push replaces whatever `change/issue-N` held.
  const dir = await d.wt.fresh(branch)
  let cost = { estCostUsd: 0, turns: 0 }
  const ask = async (prompt: string) => {
    const r = await askClaude(d, { model: 'propose', tools: 'propose', prompt, cwd: dir, urgent, ignoreBudget: o.ignoreBudget })
    cost = sumCost(cost, r)
    return r
  }
  // A proposal is cheap to redo, so a paused one is discarded rather than pushed.
  const paused = async (r: ClaudeResult) => ({ ...(await pause(d, issue, r, 'state:ready', dir)), ...cost })
  const blocked = async (reason: string) => ({ ...(await block(d, issue, reason)), ...cost })
  const decision = async (kind: string, detail: string) => {
    await setState(d.gh, issue, 'state:needs-decision')
    await d.gh.comment(n, `🤖 Couldn't write a proposal yet: **${kind}**\n\n${detail}`)
    d.digest.add('❓', `${kind === 'NEEDS_SPLIT' ? 'Split suggested' : 'Question'} on #${n} ${issue.title}: ${firstLine(detail)}`, issue.url)
    return { outcome: 'ok' as const, issue: n, detail: kind, worktree: dir, ...cost }
  }

  const thread = await trustedThread(d, n)
  const issueVars = {
    PROJECT_NAME: d.project.displayName,
    ISSUE_NUMBER: String(n),
    ISSUE_TITLE: issue.title,
    ISSUE_BODY: issue.body,
    ISSUE_COMMENTS: thread,
    CHANGE_ID: changeId,
  }
  const res = await ask(await d.prompt('propose', { ...issueVars, DEFAULT_BRANCH: d.branch }))
  if (isPause(res)) return paused(res)
  if (!res.ok && res.error && FATAL_CLAUDE_ERRORS.includes(res.error)) {
    return blocked(`Claude Code failed: \`${res.error}\`. Check the runner's Claude credentials.`)
  }
  const sig = stopSignal(res.text)
  if (sig) return decision(sig.kind, sig.detail)

  if (!existsSync(path.join(dir, 'openspec', 'changes', changeId))) {
    return blocked(`Agent finished without creating \`openspec/changes/${changeId}\`${res.ok ? '' : ` (${res.stopReason}, ${res.error ?? 'no error'})`}.\n\n${tail(res.text, 30)}`)
  }

  /** Validate, with one fix round. A string is the reason to block. */
  const validated = async (): Promise<true | string | ClaudeResult> => {
    const v = await validate(d, dir, changeId)
    if (v.ok) return true
    const fix = await ask(await d.prompt('validate-fix', { CHANGE_ID: changeId, VALIDATE_OUTPUT: tail(v.log, 80) }))
    if (isPause(fix)) return fix
    const again = await validate(d, dir, changeId)
    return again.ok ? true : `Proposal fails validation:\n\`\`\`\n${tail(again.log, 40)}\n\`\`\``
  }

  let review: ProposalReview | undefined
  for (let round = 0; ; round++) {
    const v = await validated()
    if (typeof v === 'string') return blocked(v)
    if (v !== true) return paused(v)

    const r = await askClaude(d, {
      model: 'review', tools: 'review', cwd: dir, urgent, ignoreBudget: o.ignoreBudget, jsonSchema: cliJsonSchema(proposalReviewSchema),
      prompt: await d.prompt('review-proposal', issueVars),
    })
    cost = sumCost(cost, r)
    if (isPause(r)) return paused(r)
    const parsed = parseReview(r)
    // Unknown is not a pass: an unreadable verdict blocks rather than approving unreviewed work.
    if (typeof parsed === 'string') return blocked(`The proposal review returned no usable verdict: ${parsed}`)
    review = parsed
    if (review.verdict === 'pass') break
    if (review.verdict === 'needs-decision') return decision('NEEDS_DECISION', bullets(review.questions.length ? review.questions : review.gaps))
    if (round >= d.project.maxFixAttempts) {
      return blocked(`The proposal review still found gaps after ${round} revision(s):\n\n${bullets(review.gaps)}`)
    }
    d.log.info({ issue: n, round: round + 1, gaps: review.gaps.length }, 'proposal review found gaps, revising')
    const fix = await ask(await d.prompt('revise-proposal', { ...issueVars, GAPS: bullets(review.gaps) }))
    if (isPause(fix)) return paused(fix)
    const fsig = stopSignal(fix.text)
    if (fsig) return decision(fsig.kind, fsig.detail)
  }

  // Only the change folder is committed; stray edits die with the worktree.
  await d.wt.commit(dir, `spec: propose ${changeId} (#${n})`, [`openspec/changes/${changeId}`])
  await d.wt.push(dir, branch)
  await setState(d.gh, issue, 'state:approved')
  await d.gh.comment(
    n,
    `📝 **Proposal written and reviewed**: \`openspec/changes/${changeId}\` on \`${branch}\`. It will be built next and arrives in the implementation PR.\n\n` +
      `${res.text.slice(0, 3000)}${review.notes ? `\n\n**Reviewer:** ${review.notes.slice(0, 1000)}` : ''}`,
  )
  d.digest.add('📝', `Proposal written and reviewed for #${n} ${issue.title}`, issue.url)
  return { outcome: 'ok', issue: n, detail: branch, worktree: dir, ...cost }
}

const bullets = (xs: string[]) => xs.map(x => `- ${x}`).join('\n') || '- (none given)'

/** The structured output, or the text as JSON; a string says why neither works. */
export function parseReview(r: ClaudeResult): ProposalReview | string {
  let raw = r.structured
  if (raw === undefined) {
    try {
      raw = JSON.parse(r.text.replace(/^```(json)?\s*|\s*```$/g, ''))
    } catch {
      return `no structured output (${r.stopReason}${r.error ? `, ${r.error}` : ''})`
    }
  }
  const p = proposalReviewSchema.safeParse(raw)
  return p.success ? p.data : `invalid output: ${p.error.message.slice(0, 300)}`
}

async function validate(d: Deps, dir: string, changeId: string) {
  const r = await d.run('openspec', ['validate', changeId, '--strict', '--no-interactive'], { as: 'agent', cwd: dir, env: agentEnv(d, dir) })
  return { ok: r.exitCode === 0, log: r.all }
}

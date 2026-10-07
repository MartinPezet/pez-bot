import { z } from 'zod'
import { isAllowedAuthor, partitionByAuthor, trustedComments } from '../github/authors.js'
import type { Issue } from '../github/client.js'
import { PRIORITIES, setState, SIZES, stateOf, TYPES, URGENT } from '../github/labels.js'
import { askClaude, isPause } from './common.js'
import type { Deps, JobResult } from './types.js'

export const TRIAGE_LIMIT = 15

/** What Claude must return. The runner validates it again and applies it; Claude never writes to GitHub. */
export const triageOutputSchema = z.object({
  items: z.array(
    z.object({
      number: z.number().int(),
      labels: z
        .object({
          type: z.enum(TYPES),
          areas: z.array(z.string()).min(1),
          priority: z.enum(PRIORITIES),
          size: z.enum(SIZES),
        })
        .optional(),
      comment: z.string().min(1),
      state: z.enum(['ready', 'needs-decision']),
      children: z.array(z.object({ title: z.string().min(1).max(200), body: z.string() })).max(5).optional(),
    }),
  ),
  questions: z.array(z.object({ number: z.number().int(), question: z.string() })).default([]),
  summary: z.string().default(''),
})
export type TriageOutput = z.infer<typeof triageOutputSchema>
export type TriageEntry = TriageOutput['items'][number]

export interface TriageItem {
  kind: 'new' | 'answered'
  number: number
  title: string
  body: string
  labels: string[]
  comments: { author: string; body: string; at: string }[]
}

/** Inbox items (oldest first, at most 15) and needs-decision items whose latest comment is a maintainer's answer. */
export async function gatherTriage(d: Deps): Promise<{ items: TriageItem[]; issues: Issue[] }> {
  const issues = partitionByAuthor(await d.gh.listIssues(), d.project.allowedAuthors).allowed
  const items: TriageItem[] = []
  const toItem = async (i: Issue, kind: TriageItem['kind']): Promise<TriageItem> => ({
    kind,
    number: i.number,
    title: i.title,
    body: i.body,
    labels: i.labels,
    comments: trustedComments(await d.gh.issueComments(i.number), d.project.allowedAuthors, d.botLogin).map(c => ({
      author: c.author,
      body: c.body,
      at: c.createdAt,
    })),
  })
  for (const i of issues.filter(x => stateOf(x) === 'state:inbox').sort((a, b) => a.number - b.number).slice(0, TRIAGE_LIMIT)) {
    items.push(await toItem(i, 'new'))
  }
  for (const i of issues.filter(x => stateOf(x) === 'state:needs-decision')) {
    const latest = (await d.gh.issueComments(i.number)).at(-1)
    // Only a maintainer's answer re-opens an item; the bot's own comment or anyone else's leaves it alone.
    if (latest && isAllowedAuthor(latest.author, d.project.allowedAuthors)) items.push(await toItem(i, 'answered'))
  }
  return { items, issues }
}

/** Validates Claude's output against the input and the allowed label sets. Invalid entries are rejected, not repaired. */
export function validateTriage(
  raw: unknown,
  items: TriageItem[],
  areas: string[],
): { entries: TriageEntry[]; rejected: { number: number; reason: string }[]; output: TriageOutput } {
  const output = triageOutputSchema.parse(raw)
  const byNumber = new Map(items.map(i => [i.number, i]))
  const entries: TriageEntry[] = []
  const rejected: { number: number; reason: string }[] = []
  const seen = new Set<number>()
  for (const e of output.items) {
    const item = byNumber.get(e.number)
    const reject = (reason: string) => rejected.push({ number: e.number, reason })
    if (!item) {
      reject('not one of the issues given to triage')
      continue
    }
    if (seen.has(e.number)) {
      reject('duplicate entry')
      continue
    }
    seen.add(e.number)
    const badAreas = e.labels?.areas.filter(a => !areas.includes(a)) ?? []
    if (badAreas.length) {
      reject(`labels outside the allowed set: ${badAreas.map(a => `area:${a}`).join(', ')}`)
      continue
    }
    if (item.kind === 'new' && !e.labels) {
      reject('a new item needs type, area, priority and size labels')
      continue
    }
    if (item.kind === 'new' && e.children?.length) {
      reject('children can only be created for an approved split')
      continue
    }
    // Spikes and large items always need a decision, whatever the model said.
    const forced = e.labels && (e.labels.type === 'spike' || e.labels.size === 'l')
    entries.push(forced ? { ...e, state: 'needs-decision' } : e)
  }
  return { entries, rejected, output }
}

const MANAGED = /^(type|area|priority|size):/

export async function applyTriage(d: Deps, entries: TriageEntry[], issues: Issue[], items: TriageItem[]): Promise<{ ready: number; decision: number }> {
  const counts = { ready: 0, decision: 0 }
  for (const e of entries) {
    const issue = issues.find(i => i.number === e.number)
    if (!issue) continue
    if (e.labels) {
      const want = [`type:${e.labels.type}`, `priority:${e.labels.priority}`, `size:${e.labels.size}`, ...e.labels.areas.map(a => `area:${a}`)]
      // Never add or remove `urgent`: only a maintainer sets it.
      for (const l of issue.labels.filter(l => MANAGED.test(l) && !want.includes(l) && l !== URGENT)) await d.gh.removeLabel(issue.number, l)
      const add = want.filter(l => !issue.labels.includes(l))
      if (add.length) await d.gh.addLabels(issue.number, add)
      issue.labels = [...issue.labels.filter(l => !MANAGED.test(l) || want.includes(l)), ...add]
    }
    let comment = `🔎 **Triage**\n\n${e.comment}`
    if (e.children?.length && items.find(i => i.number === e.number)?.kind === 'answered') {
      const made: string[] = []
      for (const c of e.children) {
        const child = await d.gh.createIssue({ title: c.title, body: `${c.body}\n\nSplit from #${issue.number}.`, labels: ['state:inbox'] })
        made.push(`- #${child.number} ${c.title}`)
      }
      comment += `\n\nCreated from the approved split:\n${made.join('\n')}\n\nThis issue stays open for you to close.`
    }
    await d.gh.comment(issue.number, comment)
    await setState(d.gh, issue, e.state === 'ready' ? 'state:ready' : 'state:needs-decision')
    if (e.state === 'ready') counts.ready++
    else counts.decision++
  }
  return counts
}

/**
 * The schema for `--json-schema`. Claude Code's validator rejects zod's default
 * `"$schema": ".../draft/2020-12/schema"` ("no schema with key or ref"), so emit draft-07
 * keywords and leave `$schema` out, letting the CLI use its default meta-schema.
 */
export function triageJsonSchema(): object {
  const { $schema: _, ...schema } = z.toJSONSchema(triageOutputSchema, { io: 'input', target: 'draft-7' })
  return schema
}

export async function triage(d: Deps, o: { ignoreBudget: boolean }): Promise<JobResult> {
  const { items, issues } = await gatherTriage(d)
  if (!items.length) return { outcome: 'noop', detail: 'nothing to triage' }
  if (!o.ignoreBudget) {
    const g = await d.gate.check('triage', false)
    if (!g.ok) return { outcome: 'skipped', detail: g.reason }
  }

  const dir = await d.wt.fresh('triage/readonly')
  const prompt = await d.prompt('triage', {
    PROJECT_NAME: d.project.displayName,
    TYPES: TYPES.join(', '),
    AREAS: d.project.areas.join(', '),
    ITEMS: JSON.stringify(
      { items, openIssues: issues.map(i => ({ number: i.number, title: i.title, state: stateOf(i) ?? null })) },
      null,
      2,
    ),
  })
  const res = await askClaude(d, { model: 'triage', tools: 'triage', prompt, cwd: dir, urgent: false, ignoreBudget: o.ignoreBudget, jsonSchema: triageJsonSchema() })
  const cost = { estCostUsd: res.costUsd, turns: res.turns }
  if (isPause(res)) return { outcome: res.stopReason === 'deadline' ? 'checkpointed' : 'paused', detail: res.stopReason, worktree: dir, ...cost }

  let raw = res.structured
  if (raw === undefined) {
    try {
      raw = JSON.parse(res.text.replace(/^```(json)?\s*|\s*```$/g, ''))
    } catch {
      return { outcome: 'error', detail: `triage returned no structured output (${res.stopReason}${res.error ? `, ${res.error}` : ''})`, worktree: dir, ...cost }
    }
  }
  let v: ReturnType<typeof validateTriage>
  try {
    v = validateTriage(raw, items, d.project.areas)
  } catch (e) {
    return { outcome: 'error', detail: `triage output failed validation: ${e instanceof Error ? e.message.slice(0, 500) : String(e)}`, worktree: dir, ...cost }
  }
  for (const r of v.rejected) d.log.warn(r, 'triage entry rejected')

  const counts = await applyTriage(d, v.entries, issues, items)
  if (counts.ready + counts.decision === 0) return { outcome: 'noop', detail: 'triage moved nothing', worktree: dir, ...cost }
  d.digest.add('🔎', `Triage: ${counts.ready} → ready, ${counts.decision} → needs decision${v.rejected.length ? `, ${v.rejected.length} rejected` : ''}`)
  for (const q of v.output.questions) {
    const issue = issues.find(i => i.number === q.number)
    d.digest.add('❓', `#${q.number}: ${q.question}`, issue?.url)
  }
  return { outcome: 'ok', detail: `${counts.ready} ready, ${counts.decision} needs-decision`, worktree: dir, ...cost }
}

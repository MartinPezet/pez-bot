import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { PRIORITIES, TYPES } from '../github/labels.js'
import { formatIssues } from '../result.js'
import { askClaude, isPause } from './common.js'
import type { Deps, JobResult } from './types.js'

export const MIGRATION_DIR = '.backlog-runner/migration'
export const MIGRATION_BRANCH = 'migration/prd'

export const backlogSchema = z.array(
  z.object({
    title: z.string().min(1).max(256),
    body: z.string(),
    type: z.enum(TYPES),
    area: z.array(z.string()).min(1),
    priority: z.enum(PRIORITIES),
    source: z.string().optional(),
  }),
)
export type BacklogItem = z.infer<typeof backlogSchema>[number]

export function validateBacklog(raw: unknown, areas: string[]): { items: BacklogItem[]; errors: string[] } {
  const r = backlogSchema.safeParse(raw)
  if (!r.success) return { items: [], errors: formatIssues(r.error) }
  const errors: string[] = []
  r.data.forEach((it, i) => {
    const bad = it.area.filter(a => !areas.includes(a))
    if (bad.length) errors.push(`${i}.area: ${bad.join(', ')} not in the project's areas (${areas.join(', ')})`)
  })
  const titles = new Set<string>()
  r.data.forEach((it, i) => {
    if (titles.has(it.title)) errors.push(`${i}.title: duplicate "${it.title}"`)
    titles.add(it.title)
  })
  return { items: r.data, errors }
}

/** Step 1: Claude turns the PRD into backlog.json + skipped.md; the runner opens a PR with just those two files. */
export async function migratePrd(d: Deps, o: { prdPath: string; ignoreBudget: boolean }): Promise<JobResult> {
  if (!o.ignoreBudget) {
    const g = await d.gate.check('migrate', false)
    if (!g.ok) return { outcome: 'skipped', detail: g.reason }
  }
  const dir = await d.wt.fresh(MIGRATION_BRANCH)
  if (!existsSync(path.join(dir, o.prdPath))) return { outcome: 'error', detail: `${o.prdPath} not found on ${d.branch}`, worktree: dir }

  const prompt = await d.prompt('prd-to-backlog', { PRD_PATH: o.prdPath, OUT_DIR: MIGRATION_DIR, AREAS: d.project.areas.join(', ') })
  const res = await askClaude(d, { model: 'migrate', tools: 'migrate', prompt, cwd: dir, urgent: false, ignoreBudget: o.ignoreBudget })
  const cost = { estCostUsd: res.costUsd, turns: res.turns }
  if (isPause(res)) return { outcome: res.stopReason === 'deadline' ? 'checkpointed' : 'paused', detail: res.stopReason, worktree: dir, ...cost }

  const file = path.join(dir, MIGRATION_DIR, 'backlog.json')
  if (!existsSync(file)) return { outcome: 'error', detail: `Claude did not write ${MIGRATION_DIR}/backlog.json (${res.error ?? res.stopReason})`, worktree: dir, ...cost }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    return { outcome: 'error', detail: `backlog.json is not valid JSON: ${(e as Error).message}`, worktree: dir, ...cost }
  }
  const v = validateBacklog(raw, d.project.areas)

  await d.wt.commit(dir, 'chore: PRD backlog migration', [MIGRATION_DIR])
  await d.wt.push(dir, MIGRATION_BRANCH)
  const counts = (key: 'type' | 'priority') =>
    Object.entries(v.items.reduce<Record<string, number>>((a, it) => ({ ...a, [it[key]]: (a[it[key]] ?? 0) + 1 }), {}))
      .map(([k, n]) => `${k} ${n}`)
      .join(', ')
  const pr = await d.gh.openPr({
    head: MIGRATION_BRANCH,
    base: d.branch,
    title: `Backlog migration from ${o.prdPath}`,
    body:
      `${v.items.length} items in \`${MIGRATION_DIR}/backlog.json\` (types: ${counts('type')}; priorities: ${counts('priority')}), ` +
      `skipped items with evidence in \`${MIGRATION_DIR}/skipped.md\`.\n\n` +
      (v.errors.length ? `**Fix before merging:**\n${v.errors.map(e => `- ${e}`).join('\n')}\n\n` : '') +
      'Edit titles, merge or split items here. After merging, run `pez-bot migrate-prd --apply` to create the issues.',
  })
  d.digest.add('📦', `PRD migration PR opened (${v.items.length} items)`, pr.url)
  return { outcome: 'ok', detail: pr.url, worktree: dir, ...cost }
}

/** Step 2: creates issues from the merged backlog.json. Idempotent: existing titles are skipped. */
export async function applyMigration(d: Deps): Promise<JobResult> {
  const dir = await d.wt.fresh('migration/apply')
  const file = path.join(dir, MIGRATION_DIR, 'backlog.json')
  if (!existsSync(file)) return { outcome: 'error', detail: `${MIGRATION_DIR}/backlog.json not found on ${d.branch}: merge the migration PR first`, worktree: dir }
  const v = validateBacklog(JSON.parse(readFileSync(file, 'utf8')), d.project.areas)
  if (v.errors.length) return { outcome: 'error', detail: `backlog.json is invalid:\n${v.errors.join('\n')}`, worktree: dir }

  const existing = new Set(await d.gh.allIssueTitles())
  let created = 0
  for (const it of v.items) {
    if (existing.has(it.title)) continue
    const body = it.source ? `${it.body}\n\n<sub>Migrated from the PRD § ${it.source}</sub>` : it.body
    await d.gh.createIssue({
      title: it.title,
      body,
      labels: ['state:inbox', `type:${it.type}`, `priority:${it.priority}`, ...it.area.map(a => `area:${a}`)],
    })
    existing.add(it.title)
    created++
  }
  const skipped = v.items.length - created
  if (created) d.digest.add('📥', `Created ${created} issue(s) from the PRD migration${skipped ? ` (${skipped} already existed)` : ''}`)
  return { outcome: created ? 'ok' : 'noop', detail: `${created} created, ${skipped} skipped (already exist)`, worktree: dir }
}

import type { DB } from '../state/db.js'

export const DEFAULT_ESTIMATE_MIN: Record<string, number> = { propose: 20, build: 60, triage: 15, migrate: 30 }

/**
 * Rolling median duration of the last 10 completed runs of a kind (ok or blocked; paused and
 * checkpointed runs were cut short so they'd skew it). Falls back to the defaults.
 */
export function estimateMinutes(db: DB, kind: string): number {
  const rows = db
    .prepare(
      `SELECT started_at, ended_at FROM job_runs
       WHERE job = ? AND ended_at IS NOT NULL AND outcome IN ('ok', 'blocked')
       ORDER BY id DESC LIMIT 10`,
    )
    .all(kind) as { started_at: string; ended_at: string }[]
  if (!rows.length) return DEFAULT_ESTIMATE_MIN[kind] ?? 30
  const mins = rows.map(r => (Date.parse(r.ended_at) - Date.parse(r.started_at)) / 60_000).sort((a, b) => a - b)
  const mid = Math.floor(mins.length / 2)
  const median = mins.length % 2 ? mins[mid]! : (mins[mid - 1]! + mins[mid]!) / 2
  return Math.max(1, Math.ceil(median))
}

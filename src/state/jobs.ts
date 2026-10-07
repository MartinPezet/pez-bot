import type { DB } from './db.js'

export type Outcome = 'ok' | 'noop' | 'error' | 'blocked' | 'paused' | 'checkpointed' | 'skipped'

export interface JobRun {
  id: number
  job: string
  issue: number | null
  started_at: string
  ended_at: string | null
  outcome: Outcome | null
  detail: string | null
  est_cost_usd: number | null
  turns: number | null
}

export function startRun(db: DB, job: string, issue: number | null = null, now = new Date()): number {
  const r = db.prepare('INSERT INTO job_runs (job, issue, started_at) VALUES (?, ?, ?)').run(job, issue, now.toISOString())
  return Number(r.lastInsertRowid)
}

export function finishRun(
  db: DB,
  id: number,
  r: { outcome: Outcome; detail?: string; estCostUsd?: number; turns?: number; issue?: number },
  now = new Date(),
): void {
  db.prepare(
    'UPDATE job_runs SET ended_at = ?, outcome = ?, detail = ?, est_cost_usd = ?, turns = ?, issue = COALESCE(?, issue) WHERE id = ?',
  ).run(now.toISOString(), r.outcome, r.detail ?? null, r.estCostUsd ?? null, r.turns ?? null, r.issue ?? null, id)
}

export const recentRuns = (db: DB, limit = 10): JobRun[] =>
  db.prepare('SELECT * FROM job_runs ORDER BY id DESC LIMIT ?').all(limit) as JobRun[]

/** Finished runs only, newest first: what the health check judges. */
export const recentFinished = (db: DB, limit = 3): JobRun[] =>
  db.prepare('SELECT * FROM job_runs WHERE ended_at IS NOT NULL ORDER BY id DESC LIMIT ?').all(limit) as JobRun[]

export const currentRun = (db: DB): JobRun | undefined =>
  db.prepare('SELECT * FROM job_runs WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get() as JobRun | undefined

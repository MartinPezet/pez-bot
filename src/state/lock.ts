import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { DB } from './db.js'

/**
 * One job at a time across every process sharing the state volume (daemon, `docker exec`,
 * `docker compose run`). A lease whose heartbeat is older than `staleMs` is free.
 */

export const STALE_MS = 10 * 60_000

/** Unique per process: host (container id) plus pid plus a random suffix, since a restarted container reuses both. */
export const makeHolder = () => `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`

export interface Lease {
  holder: string
  job: string
  acquired_at: string
  heartbeat_at: string
}

export const lockHolder = (db: DB): Lease | undefined =>
  db.prepare('SELECT holder, job, acquired_at, heartbeat_at FROM job_lock WHERE id = 1').get() as Lease | undefined

/**
 * `takeover` is for the daemon at startup only: a lease held by another process on the same
 * host (this container) must belong to a dead predecessor, because there is one daemon per container.
 */
export function acquireLock(
  db: DB,
  holder: string,
  job: string,
  opts: { now?: Date; staleMs?: number; takeover?: boolean } = {},
): boolean {
  const now = opts.now ?? new Date()
  const staleMs = opts.staleMs ?? STALE_MS
  return db
    .transaction(() => {
      const cur = lockHolder(db)
      if (cur && cur.holder !== holder) {
        const fresh = now.getTime() - Date.parse(cur.heartbeat_at) < staleMs
        const sameHost = cur.holder.split(':')[0] === holder.split(':')[0]
        if (fresh && !(opts.takeover && sameHost)) return false
      }
      const t = now.toISOString()
      db.prepare(
        `INSERT INTO job_lock (id, holder, job, acquired_at, heartbeat_at) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, job = excluded.job,
           acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at`,
      ).run(holder, job, t, t)
      return true
    })
    .immediate()
}

export function beatLock(db: DB, holder: string, now = new Date()): boolean {
  return db.prepare('UPDATE job_lock SET heartbeat_at = ? WHERE id = 1 AND holder = ?').run(now.toISOString(), holder).changes === 1
}

export function releaseLock(db: DB, holder: string): void {
  db.prepare('DELETE FROM job_lock WHERE id = 1 AND holder = ?').run(holder)
}

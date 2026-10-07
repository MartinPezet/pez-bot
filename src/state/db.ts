import { mkdirSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

export type DB = Database.Database

/** Append-only. Each entry runs once, in order, tracked by `PRAGMA user_version`. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE job_runs (
    id INTEGER PRIMARY KEY,
    job TEXT NOT NULL,
    issue INTEGER,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    outcome TEXT,
    detail TEXT,
    est_cost_usd REAL,
    turns INTEGER
  );
  CREATE INDEX job_runs_job ON job_runs(job, started_at);
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE job_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    holder TEXT NOT NULL,
    job TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL
  );
  CREATE TABLE usage_readings (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    bucket TEXT NOT NULL,
    utilization REAL,
    status TEXT,
    resets_at TEXT,
    source TEXT NOT NULL
  );
  CREATE INDEX usage_readings_bucket ON usage_readings(bucket, at);
  CREATE TABLE updates (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    component TEXT NOT NULL,
    from_version TEXT,
    to_version TEXT,
    outcome TEXT NOT NULL,
    note TEXT
  );
  `,
]

export function openDb(file: string, opts: { readonly?: boolean } = {}): DB {
  if (opts.readonly) return new Database(file, { readonly: true, fileMustExist: true })
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i] ?? '')
      db.pragma(`user_version = ${i + 1}`)
    })()
  }
}

export const schemaVersion = () => MIGRATIONS.length

export const kv = {
  get(db: DB, key: string): string | undefined {
    return (db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value
  },
  set(db: DB, key: string, value: string, now = new Date()): void {
    db.prepare(
      'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).run(key, value, now.toISOString())
  },
  del(db: DB, key: string): void {
    db.prepare('DELETE FROM kv WHERE key = ?').run(key)
  },
  /** Keys with a prefix, for caches keyed by date or issue. */
  keys(db: DB, prefix: string): { key: string; updated_at: string }[] {
    return db.prepare("SELECT key, updated_at FROM kv WHERE key LIKE ? ESCAPE '\\'").all(`${prefix.replace(/[%_\\]/g, '\\$&')}%`) as {
      key: string
      updated_at: string
    }[]
  },
  getJson<T>(db: DB, key: string): T | undefined {
    const v = kv.get(db, key)
    return v === undefined ? undefined : (JSON.parse(v) as T)
  },
  setJson(db: DB, key: string, value: unknown, now = new Date()): void {
    kv.set(db, key, JSON.stringify(value), now)
  },
}

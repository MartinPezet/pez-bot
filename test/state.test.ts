import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { kv, openDb, schemaVersion } from '../src/state/db.js'
import { currentRun, finishRun, recentFinished, recentRuns, startRun } from '../src/state/jobs.js'
import { acquireLock, beatLock, lockHolder, releaseLock } from '../src/state/lock.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmpDb = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'pezbot-'))
  dirs.push(d)
  return path.join(d, 'state', 'runner.db')
}

describe('db', () => {
  it('migrates once and reopens cleanly', () => {
    const file = tmpDb()
    const a = openDb(file)
    expect(a.pragma('user_version', { simple: true })).toBe(schemaVersion())
    kv.set(a, 'k', 'v')
    a.close()
    const b = openDb(file)
    expect(kv.get(b, 'k')).toBe('v')
    b.close()
    const ro = openDb(file, { readonly: true })
    expect(kv.get(ro, 'k')).toBe('v')
    ro.close()
  })

  it('round-trips JSON in kv', () => {
    const db = openDb(':memory:')
    kv.setJson(db, 'x', { ok: true, n: 1 })
    expect(kv.getJson(db, 'x')).toEqual({ ok: true, n: 1 })
    expect(kv.getJson(db, 'missing')).toBeUndefined()
  })
})

describe('job runs', () => {
  it('records start, finish and outcome', () => {
    const db = openDb(':memory:')
    const t0 = new Date('2026-10-05T08:00:00Z')
    const id = startRun(db, 'sync', null, t0)
    expect(currentRun(db)?.id).toBe(id)
    finishRun(db, id, { outcome: 'ok', estCostUsd: 0.42, turns: 3, issue: 12 }, new Date('2026-10-05T08:01:00Z'))
    expect(currentRun(db)).toBeUndefined()
    const [r] = recentRuns(db)
    expect(r).toMatchObject({ job: 'sync', outcome: 'ok', est_cost_usd: 0.42, turns: 3, issue: 12, ended_at: '2026-10-05T08:01:00.000Z' })
  })

  it('recentFinished skips the running job', () => {
    const db = openDb(':memory:')
    finishRun(db, startRun(db, 'a'), { outcome: 'error' })
    startRun(db, 'b')
    expect(recentFinished(db).map(r => r.job)).toEqual(['a'])
  })
})

describe('job lock', () => {
  const t = (min: number) => new Date(Date.parse('2026-10-05T09:00:00Z') + min * 60_000)

  it('allows one holder at a time', () => {
    const db = openDb(':memory:')
    expect(acquireLock(db, 'hostA:1:aaaa', 'work', { now: t(0) })).toBe(true)
    expect(acquireLock(db, 'hostB:1:bbbb', 'sync', { now: t(1) })).toBe(false)
    expect(lockHolder(db)?.job).toBe('work')
    releaseLock(db, 'hostA:1:aaaa')
    expect(acquireLock(db, 'hostB:1:bbbb', 'sync', { now: t(2) })).toBe(true)
  })

  it('frees a lease whose heartbeat is stale', () => {
    const db = openDb(':memory:')
    acquireLock(db, 'hostA:1:aaaa', 'work', { now: t(0) })
    expect(beatLock(db, 'hostA:1:aaaa', t(5))).toBe(true)
    expect(acquireLock(db, 'hostB:1:bbbb', 'sync', { now: t(14) })).toBe(false)
    expect(acquireLock(db, 'hostB:1:bbbb', 'sync', { now: t(16) })).toBe(true)
    expect(beatLock(db, 'hostA:1:aaaa', t(17))).toBe(false)
  })

  it('lets the daemon take over a dead predecessor in the same container only', () => {
    const db = openDb(':memory:')
    acquireLock(db, 'hostA:7:old0', 'work', { now: t(0) })
    expect(acquireLock(db, 'hostB:7:new0', 'daemon', { now: t(1), takeover: true })).toBe(false)
    expect(acquireLock(db, 'hostA:7:new0', 'daemon', { now: t(1), takeover: true })).toBe(true)
  })

  it('releasing someone else’s lease is a no-op', () => {
    const db = openDb(':memory:')
    acquireLock(db, 'hostA:1:aaaa', 'work', { now: t(0) })
    releaseLock(db, 'hostB:1:bbbb')
    expect(lockHolder(db)?.holder).toBe('hostA:1:aaaa')
  })
})

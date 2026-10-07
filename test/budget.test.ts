import { describe, expect, it } from 'vitest'
import { projectSchema } from '../src/config/project.js'
import { BudgetGate } from '../src/jobs/gate.js'
import { kv, openDb } from '../src/state/db.js'
import { finishRun, startRun } from '../src/state/jobs.js'
import type { Probe } from '../src/usage/gauge.js'
import { SqliteGauge } from '../src/usage/gauge.js'
import type { Reading } from '../src/usage/passive.js'
import { decide, viewFromReadings, type BudgetConfig } from '../src/usage/rules.js'
import { estimateMinutes } from '../src/windows/estimate.js'
import { silent, testEnv } from './jobs-harness.js'

const now = new Date('2026-10-05T09:00:00Z') // Monday 10:00 BST, inside the morning window
const cfg: BudgetConfig = { weeklyStopPct: 80, weeklyHardStopPct: 95, fiveHourStartMaxPct: 60, maxAgeMin: 30, unknownPolicy: 'block' }
const r = (bucket: string, utilization: number | null, minsAgo = 5, extra: Partial<Reading> = {}): Reading => ({
  bucket, utilization, status: 'allowed', resetsAt: null, source: 'test', at: new Date(now.getTime() - minsAgo * 60_000), ...extra,
})
const view = (rs: Reading[], paused: Date | null = null) => viewFromReadings(rs, now, 30, paused)

describe('usage view', () => {
  it('uses the freshest known value per bucket and ignores stale readings', () => {
    const v = view([r('five_hour', 0.2, 5), r('five_hour', 0.5, 20), r('seven_day', 0.9, 45)])
    expect(v.five).toBe(0.2)
    expect(v.week).toBeNull()
  })

  it('falls back to an older fresh value when the newest reading has none', () => {
    expect(view([r('seven_day', null, 1), r('seven_day', 0.4, 10)]).week).toBe(0.4)
  })

  it('treats a rejected status as 100%, and a passed reset as empty again', () => {
    expect(view([r('five_hour', null, 1, { status: 'rejected' })]).five).toBe(1)
    expect(view([r('seven_day', 0.9, 5, { resetsAt: new Date(now.getTime() - 60_000) })]).week).toBe(0)
  })
})

describe('budget rules', () => {
  const known = (five: number, week: number) => view([r('five_hour', five), r('seven_day', week)])

  it('starts when both buckets are under their limits', () => {
    expect(decide(known(0.3, 0.5), false, cfg, now)).toEqual({ start: true })
  })

  it('weekly gate: no non-urgent work at or above WEEKLY_STOP_PCT, until the reset', () => {
    const reset = new Date('2026-10-08T00:00:00Z')
    const v = view([r('five_hour', 0.1), r('seven_day', 0.8, 5, { resetsAt: reset })])
    expect(decide(v, false, cfg, now)).toEqual({ start: false, reason: 'weekly usage 80% is at or above 80%', until: reset })
  })

  it('urgent bypasses the weekly gate but never the hard stop', () => {
    expect(decide(known(0.1, 0.9), true, cfg, now)).toEqual({ start: true, note: 'urgent-under-weekly-gate' })
    expect(decide(known(0.1, 0.95), true, cfg, now)).toMatchObject({ start: false, reason: expect.stringContaining('hard stop') })
  })

  it('urgent ignores the 5-hour guard; non-urgent does not', () => {
    expect(decide(known(0.7, 0.1), false, cfg, now)).toMatchObject({ start: false, reason: '5-hour usage 70% is at or above 60%' })
    expect(decide(known(0.7, 0.1), true, cfg, now)).toEqual({ start: true })
  })

  it('unknown usage follows the policy', () => {
    const v = view([r('five_hour', 0.1)])
    expect(decide(v, false, cfg, now)).toMatchObject({ start: false, unknown: true })
    expect(decide(v, false, { ...cfg, unknownPolicy: 'allow' }, now)).toEqual({ start: true, note: 'usage-unknown' })
    expect(decide(v, true, cfg, now)).toEqual({ start: true })
  })

  it('a known limit still stops work even if the other bucket is unknown', () => {
    expect(decide(view([r('seven_day', 0.85)]), false, { ...cfg, unknownPolicy: 'allow' }, now).start).toBe(false)
  })

  it('a hit limit pauses everything, urgent included, until its reset', () => {
    const until = new Date('2026-10-05T12:00:00Z')
    expect(decide(view([], until), true, cfg, now)).toMatchObject({ start: false, until })
    expect(decide(view([], until), true, cfg, new Date('2026-10-05T12:01:00Z')).start).toBe(true)
  })
})

describe('budget gate', () => {
  function setup(o: { env?: Record<string, string>; probe?: () => Reading[]; at?: Date } = {}) {
    const db = openDb(':memory:')
    let probes = 0
    const probe: Probe = {
      name: 'fake',
      async run() {
        probes++
        if (!o.probe) throw new Error('probe unavailable')
        return o.probe()
      },
    }
    const gauge = new SqliteGauge(db, [probe])
    const events: string[] = []
    let clock = o.at ?? now
    const project = projectSchema.parse({ displayName: 'D', install: ['x'], gates: [['x']], areas: ['a'], allowedAuthors: ['m'] })
    const gate = new BudgetGate({
      env: testEnv(o.env),
      project,
      db,
      gauge,
      log: silent,
      now: () => clock,
      notify: (e, t) => events.push(`${e} ${t}`),
    })
    return { db, gauge, gate, events, probes: () => probes, setClock: (d: Date) => (clock = d) }
  }

  it('refuses outside windows without probing', async () => {
    const s = setup({ at: new Date('2026-10-10T12:00:00Z') })
    expect((await s.gate.check('build', false)).ok).toBe(false)
    expect(s.probes()).toBe(0)
  })

  it('urgent ignores windows when URGENT_IGNORES_WINDOWS=true', async () => {
    const s = setup({ at: new Date('2026-10-10T12:00:00Z'), probe: () => [r('five_hour', 0.1, 0), r('seven_day', 0.1, 0)] })
    expect((await s.gate.check('build', true)).ok).toBe(true)
    const off = setup({ at: new Date('2026-10-10T12:00:00Z'), env: { URGENT_IGNORES_WINDOWS: 'false' } })
    expect((await off.gate.check('build', true)).ok).toBe(false)
  })

  it('probes at most once per USAGE_MAX_AGE_MIN when usage is unknown', async () => {
    const s = setup({ probe: () => [r('five_hour', 0.1, 0), r('seven_day', 0.2, 0)] })
    expect(await s.gate.check('propose', false)).toEqual({ ok: true })
    expect(await s.gate.check('propose', false)).toEqual({ ok: true })
    expect(s.probes()).toBe(1)
  })

  it('unknown usage with the default allow policy: runs, and reports once per occurrence', async () => {
    const s = setup()
    expect((await s.gate.check('propose', false)).ok).toBe(true)
    expect((await s.gate.check('propose', false)).ok).toBe(true)
    expect(s.events).toEqual(['⚠️ Usage unknown (fake: probe unavailable); running anyway because USAGE_UNKNOWN_POLICY=allow'])
    expect(kv.get(s.db, 'usage.unknown')).toBe('fake: probe unavailable')
  })

  it('unknown usage with the block policy holds non-urgent work', async () => {
    const s = setup({ env: { USAGE_UNKNOWN_POLICY: 'block' } })
    expect(await s.gate.check('propose', false)).toMatchObject({ ok: false, reason: expect.stringContaining('unknown') })
    expect(s.events[0]).toContain('non-urgent work is held')
  })

  it('posts weekly gate engaged and released once per transition', async () => {
    const reset = new Date('2026-10-05T09:20:00Z')
    const s = setup()
    s.gauge.record([r('five_hour', 0.1, 1), r('seven_day', 0.85, 1, { resetsAt: reset })])
    expect((await s.gate.check('build', false)).ok).toBe(false)
    expect((await s.gate.check('build', false)).ok).toBe(false)
    s.setClock(new Date('2026-10-05T09:25:00Z')) // after the weekly reset, readings still fresh
    expect((await s.gate.check('build', false)).ok).toBe(true)
    expect(s.events.filter(e => /Weekly gate/.test(e))).toEqual([
      '🛑 Weekly gate engaged: usage 85% ≥ 80%; non-urgent work held until 2026-10-05T09:20:00.000Z',
      '🟢 Weekly gate released: usage 0%',
    ])
  })

  it('tells an urgent run apart when the weekly gate is engaged', async () => {
    const s = setup()
    s.gauge.record([r('five_hour', 0.1, 1), r('seven_day', 0.9, 1)])
    expect(await s.gate.check('build', true)).toEqual({ ok: true, note: 'Urgent item run while the weekly gate is engaged' })
  })

  it('checkpoints at window end plus grace; urgent runs have no deadline', () => {
    const s = setup()
    expect(s.gate.deadline(false)).toEqual(new Date('2026-10-05T11:20:00Z'))
    expect(s.gate.deadline(true)).toBeNull()
  })
})

describe('duration estimates', () => {
  it('uses the median of the last 10 completed runs, ignoring paused ones', () => {
    const db = openDb(':memory:')
    const add = (kind: string, mins: number, outcome: 'ok' | 'paused' = 'ok') => {
      const t0 = new Date('2026-10-01T00:00:00Z')
      finishRun(db, startRun(db, kind, null, t0), { outcome }, new Date(t0.getTime() + mins * 60_000))
    }
    expect(estimateMinutes(db, 'build')).toBe(60)
    expect(estimateMinutes(db, 'propose')).toBe(20)
    for (const m of [30, 40, 50]) add('build', m)
    add('build', 5, 'paused')
    expect(estimateMinutes(db, 'build')).toBe(40)
    add('build', 41)
    expect(estimateMinutes(db, 'build')).toBe(41) // (40 + 41) / 2 rounded up
  })
})

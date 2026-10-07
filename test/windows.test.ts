import { describe, expect, it } from 'vitest'
import { canStartInWindow, nextWindow, parseWindows, windowAt, zonedTime } from '../src/windows/windows.js'

const TZ = 'Europe/London'
const DEFAULT = parseWindows('mon-fri 09:00-12:00; mon-fri 22:00-02:00')
const at = (iso: string) => new Date(iso)

describe('parsing', () => {
  it('reads days, ranges, lists and times', () => {
    const [a, b] = parseWindows('mon-fri 09:00-12:00; sat,sun 10:30-11:00')
    expect([...a!.days].sort()).toEqual([1, 2, 3, 4, 5])
    expect(a).toMatchObject({ startMin: 540, endMin: 720 })
    expect([...b!.days].sort()).toEqual([0, 6])
    expect([...parseWindows('fri-mon 08:00-09:00')[0]!.days].sort()).toEqual([0, 1, 5, 6])
    expect(parseWindows('daily 22:00-24:00')[0]?.endMin).toBe(0)
  })

  it('rejects nonsense with a clear message', () => {
    expect(() => parseWindows('weekdays 9-5')).toThrow(/can't parse run window/)
    expect(() => parseWindows('mon-fry 09:00-10:00')).toThrow(/unknown day "mon-fry"/)
    expect(() => parseWindows('mon 25:00-26:00')).toThrow(/invalid time/)
    expect(() => parseWindows('mon 09:00-09:00')).toThrow(/zero length/)
    expect(() => parseWindows(' ; ')).toThrow(/empty/)
  })
})

describe('zoned time', () => {
  it('converts wall-clock time in BST and GMT', () => {
    expect(zonedTime(2026, 10, 5, 9 * 60, TZ).toISOString()).toBe('2026-10-05T08:00:00.000Z')
    expect(zonedTime(2026, 11, 2, 9 * 60, TZ).toISOString()).toBe('2026-11-02T09:00:00.000Z')
  })
})

describe('window membership', () => {
  it('is inside a morning window on a weekday, in local time', () => {
    expect(windowAt(at('2026-10-05T08:30:00Z'), DEFAULT, TZ)).toEqual({ start: at('2026-10-05T08:00:00Z'), end: at('2026-10-05T11:00:00Z') })
    expect(windowAt(at('2026-10-05T11:00:00Z'), DEFAULT, TZ)).toBeNull() // 12:00 BST: end is exclusive
  })

  it('anchors a window to the day it starts: Friday night counts, Sunday night does not', () => {
    // Saturday 01:00 BST belongs to Friday's 22:00–02:00 window
    expect(windowAt(at('2026-10-10T00:00:00Z'), DEFAULT, TZ)?.start).toEqual(at('2026-10-09T21:00:00Z'))
    // Sunday 22:30 BST: no Sunday window
    expect(windowAt(at('2026-10-11T21:30:00Z'), DEFAULT, TZ)).toBeNull()
    // Monday 01:00 BST would be Sunday's window: none
    expect(windowAt(at('2026-10-12T00:00:00Z'), DEFAULT, TZ)).toBeNull()
    // Saturday 23:00: no Saturday window
    expect(windowAt(at('2026-10-10T22:00:00Z'), DEFAULT, TZ)).toBeNull()
  })

  it('crosses midnight into the next day', () => {
    const w = windowAt(at('2026-10-05T22:00:00Z'), DEFAULT, TZ) // Mon 23:00 BST
    expect(w).toEqual({ start: at('2026-10-05T21:00:00Z'), end: at('2026-10-06T01:00:00Z') })
  })

  it('handles the autumn DST change inside a window (an hour longer)', () => {
    const daily = parseWindows('daily 22:00-02:00')
    const w = windowAt(at('2026-10-25T00:30:00Z'), daily, TZ) // Sat 24th window, clocks go back at 02:00 BST
    expect(w).toEqual({ start: at('2026-10-24T21:00:00Z'), end: at('2026-10-25T02:00:00Z') })
  })

  it('handles the spring DST change inside a window (an hour shorter)', () => {
    const daily = parseWindows('daily 00:30-03:00')
    const w = windowAt(at('2026-03-29T01:30:00Z'), daily, TZ)
    expect(w).toEqual({ start: at('2026-03-29T00:30:00Z'), end: at('2026-03-29T02:00:00Z') })
  })

  it('works in other time zones', () => {
    const ny = windowAt(at('2026-10-05T13:30:00Z'), DEFAULT, 'America/New_York') // 09:30 EDT
    expect(ny?.start).toEqual(at('2026-10-05T13:00:00Z'))
  })
})

describe('start rule and next window', () => {
  it('only starts when the time left covers the estimate', () => {
    const t = at('2026-10-05T10:30:00Z') // 11:30 BST, 30 min left
    expect(canStartInWindow(t, DEFAULT, TZ, 20).ok).toBe(true)
    const r = canStartInWindow(t, DEFAULT, TZ, 60)
    expect(r).toEqual({ ok: false, reason: '30 min left in this window; the job usually takes ~60 min' })
  })

  it('names the next window when outside', () => {
    const r = canStartInWindow(at('2026-10-10T12:00:00Z'), DEFAULT, TZ, 20) // Saturday
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toBe('outside run windows (next opens 2026-10-12T08:00:00.000Z)')
    expect(nextWindow(at('2026-10-05T12:00:00Z'), DEFAULT, TZ)?.start).toEqual(at('2026-10-05T21:00:00Z'))
  })
})

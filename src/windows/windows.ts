/**
 * Run windows like `mon-fri 09:00-12:00; mon-fri 22:00-02:00`, in a time zone.
 * A window belongs to the day it starts: Friday 22:00–Saturday 02:00 is a Friday window.
 * All wall-clock maths goes through Intl, so DST changes are handled by the tz database.
 */

export interface WindowSpec {
  /** 0 = Sunday … 6 = Saturday: the days a window may start on. */
  days: Set<number>
  startMin: number
  /** End minute of day; <= startMin means the window ends the next day. */
  endMin: number
  text: string
}

export interface Interval {
  start: Date
  end: Date
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function parseDays(s: string): Set<number> {
  if (s === 'daily' || s === 'every') return new Set([0, 1, 2, 3, 4, 5, 6])
  const out = new Set<number>()
  for (const part of s.split(',')) {
    const [a, b] = part.split('-')
    const from = DAYS.indexOf(a ?? '')
    const to = b === undefined ? from : DAYS.indexOf(b)
    if (from < 0 || to < 0) throw new Error(`unknown day "${part}" (use mon, tue, …, sun, ranges like mon-fri, or daily)`)
    for (let i = from; ; i = (i + 1) % 7) {
      out.add(i)
      if (i === to) break
    }
  }
  return out
}

const minutes = (h: string, m: string) => {
  const hh = Number(h)
  const mm = Number(m)
  if (hh > 24 || mm > 59 || (hh === 24 && mm > 0)) throw new Error(`invalid time ${h}:${m}`)
  return hh * 60 + mm
}

export function parseWindows(text: string): WindowSpec[] {
  const specs = text
    .split(';')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .map(seg => {
      const m = seg.match(/^([a-z,-]+)\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/)
      if (!m) throw new Error(`can't parse run window "${seg}"; expected e.g. "mon-fri 09:00-12:00"`)
      const startMin = minutes(m[2]!, m[3]!)
      const endMin = minutes(m[4]!, m[5]!) % (24 * 60)
      if (startMin === endMin) throw new Error(`run window "${seg}" has zero length`)
      return { days: parseDays(m[1]!), startMin, endMin, text: seg }
    })
  if (!specs.length) throw new Error('RUN_WINDOWS is empty')
  return specs
}

interface LocalParts {
  y: number
  m: number
  d: number
  weekday: number
  h: number
  min: number
}

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function formatter(tz: string) {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    })
    fmtCache.set(tz, f)
  }
  return f
}

export function localParts(date: Date, tz: string): LocalParts & { s: number } {
  const p = Object.fromEntries(formatter(tz).formatToParts(date).map(x => [x.type, x.value]))
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour),
    min: Number(p.minute),
    s: Number(p.second),
    weekday: DAYS.indexOf(String(p.weekday).toLowerCase().slice(0, 3)),
  }
}

function offsetMs(date: Date, tz: string): number {
  const p = localParts(date, tz)
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(date.getTime() / 1000) * 1000
}

/** The instant a wall-clock time in `tz` happens. (Times in a spring-forward gap land just after it.) */
export function zonedTime(y: number, m: number, d: number, minuteOfDay: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, 0, minuteOfDay)
  const first = guess - offsetMs(new Date(guess), tz)
  const second = guess - offsetMs(new Date(first), tz)
  return new Date(second)
}

/** Calendar date `days` after y-m-d. */
function addDays(y: number, m: number, d: number, days: number) {
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), weekday: t.getUTCDay() }
}

/** The windows that start on local days [from, to] relative to `now`'s local date. */
function intervalsAround(now: Date, specs: WindowSpec[], tz: string, from: number, to: number): Interval[] {
  const p = localParts(now, tz)
  const out: Interval[] = []
  for (let off = from; off <= to; off++) {
    const day = addDays(p.y, p.m, p.d, off)
    for (const s of specs) {
      if (!s.days.has(day.weekday)) continue
      const start = zonedTime(day.y, day.m, day.d, s.startMin, tz)
      const endDay = s.endMin > s.startMin ? day : addDays(day.y, day.m, day.d, 1)
      out.push({ start, end: zonedTime(endDay.y, endDay.m, endDay.d, s.endMin, tz) })
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime())
}

export function windowAt(now: Date, specs: WindowSpec[], tz: string): Interval | null {
  return intervalsAround(now, specs, tz, -1, 0).find(w => w.start <= now && now < w.end) ?? null
}

export function nextWindow(now: Date, specs: WindowSpec[], tz: string): Interval | null {
  return intervalsAround(now, specs, tz, 0, 8).find(w => w.start > now) ?? null
}

/** Start rule: inside a window, with enough time left for the estimated duration. */
export function canStartInWindow(
  now: Date,
  specs: WindowSpec[],
  tz: string,
  estimateMin: number,
): { ok: true; window: Interval } | { ok: false; reason: string } {
  const w = windowAt(now, specs, tz)
  if (!w) {
    const next = nextWindow(now, specs, tz)
    return { ok: false, reason: `outside run windows${next ? ` (next opens ${next.start.toISOString()})` : ''}` }
  }
  const leftMin = Math.floor((w.end.getTime() - now.getTime()) / 60_000)
  if (leftMin < estimateMin) return { ok: false, reason: `${leftMin} min left in this window; the job usually takes ~${estimateMin} min` }
  return { ok: true, window: w }
}

import type { Reading } from './passive.js'

/**
 * Pure budget rules. Utilizations are 0..1; thresholds are percentages, as configured.
 * The rules govern the runner only; nothing here ever limits the human's own Claude use.
 */

export interface BudgetConfig {
  weeklyStopPct: number
  weeklyHardStopPct: number
  fiveHourStartMaxPct: number
  maxAgeMin: number
  unknownPolicy: 'block' | 'allow'
}

export interface UsageView {
  five: number | null
  week: number | null
  fiveResetsAt: Date | null
  weekResetsAt: Date | null
  /** Set after a run hit a rejected limit. */
  pausedUntil: Date | null
}

/** Freshest known value per bucket. A window whose reset time has passed counts as empty again. */
export function viewFromReadings(readings: Reading[], now: Date, maxAgeMin: number, pausedUntil: Date | null = null): UsageView {
  const fresh = readings.filter(r => now.getTime() - r.at.getTime() <= maxAgeMin * 60_000).sort((a, b) => b.at.getTime() - a.at.getTime())
  const bucket = (name: string) => {
    const rs = fresh.filter(r => r.bucket === name)
    const resetsAt = rs.find(r => r.resetsAt)?.resetsAt ?? null
    if (resetsAt && resetsAt <= now) return { value: 0, resetsAt: null }
    const known = rs.find(r => r.utilization !== null)
    if (known) return { value: known.utilization, resetsAt }
    if (rs[0]?.status === 'rejected') return { value: 1, resetsAt }
    return { value: null, resetsAt }
  }
  const five = bucket('five_hour')
  const week = bucket('seven_day')
  return { five: five.value, week: week.value, fiveResetsAt: five.resetsAt, weekResetsAt: week.resetsAt, pausedUntil }
}

export type BudgetDecision =
  | { start: true; note?: 'usage-unknown' | 'urgent-under-weekly-gate' }
  | { start: false; reason: string; until: Date | null; unknown?: boolean }

const pct = (v: number) => `${Math.round(v * 100)}%`

export function decide(v: UsageView, urgent: boolean, c: BudgetConfig, now: Date): BudgetDecision {
  if (v.pausedUntil && v.pausedUntil > now) {
    return { start: false, reason: `a usage limit was hit; paused until ${v.pausedUntil.toISOString()}`, until: v.pausedUntil }
  }
  if (urgent) {
    if (v.week !== null && v.week * 100 >= c.weeklyHardStopPct) {
      return { start: false, reason: `weekly usage ${pct(v.week)} is at or above the hard stop (${c.weeklyHardStopPct}%)`, until: v.weekResetsAt }
    }
    if (v.week !== null && v.week * 100 >= c.weeklyStopPct) return { start: true, note: 'urgent-under-weekly-gate' }
    return { start: true }
  }
  if (v.week !== null && v.week * 100 >= c.weeklyStopPct) {
    return { start: false, reason: `weekly usage ${pct(v.week)} is at or above ${c.weeklyStopPct}%`, until: v.weekResetsAt }
  }
  if (v.five !== null && v.five * 100 >= c.fiveHourStartMaxPct) {
    return { start: false, reason: `5-hour usage ${pct(v.five)} is at or above ${c.fiveHourStartMaxPct}%`, until: v.fiveResetsAt }
  }
  if (v.week === null || v.five === null) {
    if (c.unknownPolicy === 'block') return { start: false, reason: 'usage is unknown (USAGE_UNKNOWN_POLICY=block)', until: null, unknown: true }
    return { start: true, note: 'usage-unknown' }
  }
  return { start: true }
}

/** Is the weekly gate engaged for the current view? (For once-per-transition digest events.) */
export const weeklyGateEngaged = (v: UsageView, c: BudgetConfig) => v.week !== null && v.week * 100 >= c.weeklyStopPct

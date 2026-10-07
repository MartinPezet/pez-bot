import type { Env } from '../config/env.js'
import type { ProjectConfig } from '../config/project.js'
import type { Logger } from '../log.js'
import { kv, type DB } from '../state/db.js'
import type { UsageGauge } from '../usage/gauge.js'
import { decide, viewFromReadings, weeklyGateEngaged, type BudgetConfig, type UsageView } from '../usage/rules.js'
import { estimateMinutes } from '../windows/estimate.js'
import { canStartInWindow, parseWindows, windowAt, type WindowSpec } from '../windows/windows.js'
import type { ClaudeJobKind, Gate, GateDecision } from './types.js'

export interface GateDeps {
  env: Env
  project: ProjectConfig
  db: DB
  gauge: UsageGauge
  log: Logger
  now: () => Date
  /** Digest events raised by the gate (transitions, unknown usage). */
  notify: (emoji: string, text: string) => void
}

export const budgetConfig = (env: Env): BudgetConfig => ({
  weeklyStopPct: env.WEEKLY_STOP_PCT,
  weeklyHardStopPct: env.WEEKLY_HARD_STOP_PCT,
  fiveHourStartMaxPct: env.FIVE_HOUR_START_MAX_PCT,
  maxAgeMin: env.USAGE_MAX_AGE_MIN,
  unknownPolicy: env.USAGE_UNKNOWN_POLICY,
})

export function currentView(g: Pick<GateDeps, 'env' | 'db' | 'gauge'>, now: Date): UsageView {
  const paused = kv.get(g.db, 'usage.paused_until')
  const since = new Date(now.getTime() - g.env.USAGE_MAX_AGE_MIN * 60_000)
  return viewFromReadings(g.gauge.recent(since), now, g.env.USAGE_MAX_AGE_MIN, paused ? new Date(paused) : null)
}

/** Windows first (cheap, no probe outside a window), then the usage budget. */
export class BudgetGate implements Gate {
  private readonly specs: WindowSpec[]

  constructor(private readonly g: GateDeps) {
    this.specs = parseWindows(g.env.RUN_WINDOWS)
  }

  private get tz() {
    return this.g.project.timezone
  }

  private ignoresWindows(urgent: boolean) {
    return urgent && this.g.env.URGENT_IGNORES_WINDOWS
  }

  async check(kind: ClaudeJobKind, urgent: boolean): Promise<GateDecision> {
    const { env, db, log } = this.g
    const now = this.g.now()
    if (!this.ignoresWindows(urgent)) {
      const w = canStartInWindow(now, this.specs, this.tz, estimateMinutes(db, kind))
      if (!w.ok) return { ok: false, reason: w.reason }
    }

    let view = currentView(this.g, now)
    let probeError: string | null = null
    if ((view.week === null || view.five === null) && env.USAGE_PROBE) {
      const last = kv.get(db, 'usage.last_probe')
      if (!last || now.getTime() - Date.parse(last) >= env.USAGE_MAX_AGE_MIN * 60_000) {
        kv.set(db, 'usage.last_probe', now.toISOString())
        try {
          await this.g.gauge.probe()
        } catch (e) {
          probeError = e instanceof Error ? e.message : String(e)
          log.error({ err: probeError }, 'usage probe failed')
        }
        view = currentView(this.g, now)
      } else probeError = kv.get(db, 'usage.unknown') ?? null
    }

    this.trackWeeklyGate(view)
    this.trackUnknown(view, probeError ?? (env.USAGE_PROBE ? 'no fresh reading' : 'USAGE_PROBE=off and no fresh reading'))

    const d = decide(view, urgent, budgetConfig(env), now)
    if (!d.start) return { ok: false, reason: d.reason, until: d.until }
    return d.note === 'urgent-under-weekly-gate' ? { ok: true, note: 'Urgent item run while the weekly gate is engaged' } : { ok: true }
  }

  deadline(urgent: boolean): Date | null {
    if (this.ignoresWindows(urgent)) return null
    const w = windowAt(this.g.now(), this.specs, this.tz)
    return w ? new Date(w.end.getTime() + this.g.env.WINDOW_GRACE_MIN * 60_000) : null
  }

  /** One digest event per transition: engaged when crossing WEEKLY_STOP_PCT, released after reset. */
  private trackWeeklyGate(view: UsageView) {
    const { db, env } = this.g
    if (view.week === null) return
    const engaged = weeklyGateEngaged(view, budgetConfig(env))
    const prev = kv.get(db, 'gate.weekly') ?? 'released'
    if (engaged && prev !== 'engaged') {
      kv.set(db, 'gate.weekly', 'engaged')
      const until = view.weekResetsAt ? ` until ${view.weekResetsAt.toISOString()}` : ''
      this.g.notify('🛑', `Weekly gate engaged: usage ${Math.round(view.week * 100)}% ≥ ${env.WEEKLY_STOP_PCT}%; non-urgent work held${until}`)
    } else if (!engaged && prev === 'engaged') {
      kv.set(db, 'gate.weekly', 'released')
      this.g.notify('🟢', `Weekly gate released: usage ${Math.round(view.week * 100)}%`)
    }
  }

  /** Once per occurrence: unknown usage is logged as an error and posted to the digest. */
  private trackUnknown(view: UsageView, reason: string) {
    const { db, env, log } = this.g
    const unknown = view.week === null || view.five === null
    if (!unknown) {
      kv.del(db, 'usage.unknown')
      return
    }
    if (kv.get(db, 'usage.unknown')) return
    kv.set(db, 'usage.unknown', reason)
    log.error({ reason, policy: env.USAGE_UNKNOWN_POLICY }, 'usage unknown')
    this.g.notify(
      '⚠️',
      env.USAGE_UNKNOWN_POLICY === 'allow'
        ? `Usage unknown (${reason}); running anyway because USAGE_UNKNOWN_POLICY=allow`
        : `Usage unknown (${reason}); non-urgent work is held`,
    )
  }
}

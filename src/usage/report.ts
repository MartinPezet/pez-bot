import type { Env } from '../config/env.js'
import { budgetConfig, currentView } from '../jobs/gate.js'
import { kv, type DB } from '../state/db.js'
import { DEFAULT_ESTIMATE_MIN, estimateMinutes } from '../windows/estimate.js'
import { nextWindow, parseWindows, windowAt } from '../windows/windows.js'
import type { UsageGauge } from './gauge.js'
import { decide } from './rules.js'

const fmt = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d)
const pct = (v: number | null) => (v === null ? 'unknown' : `${Math.round(v * 100)}%`)

/** Gate and window state for `status` and `usage`. Reads SQLite only; never probes. */
export function usageReport(env: Env, db: DB, gauge: UsageGauge, tz: string, now = new Date()) {
  const view = currentView({ env, db, gauge }, now)
  const cfg = budgetConfig(env)
  const normal = decide(view, false, cfg, now)
  const urgent = decide(view, true, cfg, now)
  const gate =
    `5h ${pct(view.five)} · week ${pct(view.week)} · weekly gate ${kv.get(db, 'gate.weekly') ?? 'released'}` +
    ` · non-urgent ${normal.start ? 'may start' : `held (${normal.reason})`}` +
    (urgent.start ? '' : ` · urgent held (${urgent.reason})`)

  const specs = parseWindows(env.RUN_WINDOWS)
  const cur = windowAt(now, specs, tz)
  const next = nextWindow(now, specs, tz)
  const window = cur ? `open until ${fmt(cur.end, tz)}` : next ? `next opens ${fmt(next.start, tz)}` : 'no upcoming window'

  const lines = [
    `Readings (last ${env.USAGE_MAX_AGE_MIN} min):`,
    ...gauge
      .recent(new Date(now.getTime() - 7 * 24 * 60 * 60_000))
      .filter((r, i, all) => all.findIndex(x => x.bucket === r.bucket) === i)
      .map(r => {
        const age = Math.round((now.getTime() - r.at.getTime()) / 60_000)
        return `  ${r.bucket.padEnd(12)} ${pct(r.utilization).padEnd(8)} ${r.status ?? ''} (${r.source}, ${age} min ago${r.resetsAt ? `, resets ${fmt(r.resetsAt, tz)}` : ''})`
      }),
    `Gate: ${gate}`,
    ...(kv.get(db, 'usage.paused_until') ? [`Paused after a limit hit until ${kv.get(db, 'usage.paused_until')}`] : []),
    ...(kv.get(db, 'usage.unknown') ? [`Unknown usage reason: ${kv.get(db, 'usage.unknown')} (policy ${env.USAGE_UNKNOWN_POLICY})`] : []),
    `Windows (${tz}): ${env.RUN_WINDOWS}; ${window}`,
    `Estimates: ${Object.keys(DEFAULT_ESTIMATE_MIN).map(k => `${k} ~${estimateMinutes(db, k)} min`).join(', ')}`,
  ]
  return { gate, window, text: lines.join('\n') }
}

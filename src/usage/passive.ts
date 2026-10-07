/**
 * Parses `rate_limit_event` messages from `claude -p --output-format stream-json --verbose`.
 *
 * Documented shape (Agent SDK `SDKRateLimitEvent`):
 *   { type: "rate_limit_event", rate_limit_info: { status: "allowed"|"allowed_warning"|"rejected", resetsAt?: number, utilization?: number } }
 * Observed in the wild (undocumented, parsed when present):
 *   rate_limit_info.rateLimitType ("five_hour" | "seven_day" | …), surpassedThreshold,
 *   unifiedWindows: { five_hour: { utilization, resetsAt }, seven_day: { utilization, resetsAt } }
 * `utilization` is often absent: it only appears once a bucket crosses a warning threshold.
 */

export type RateLimitStatus = 'allowed' | 'allowed_warning' | 'rejected'

export interface Reading {
  bucket: string
  /** 0..1, or null when the source didn't say. */
  utilization: number | null
  status: RateLimitStatus | null
  resetsAt: Date | null
  source: string
  at: Date
}

const STATUSES: RateLimitStatus[] = ['allowed', 'allowed_warning', 'rejected']

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** Fractions stay as they are; percentages (0..100) are scaled down. */
export const normUtilization = (v: unknown): number | null => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null
  return v > 1 ? Math.min(v / 100, 1) : v
}

/** Epoch seconds, epoch milliseconds or ISO string. */
export const normReset = (v: unknown): Date | null => {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v > 1e12 ? v : v * 1000)
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : new Date(t)
  }
  return null
}

export function parseRateLimitEvent(ev: unknown, at: Date, source = 'stream'): Reading[] {
  const e = obj(ev)
  if (!e) return []
  const info = obj(e.rate_limit_info) ?? e
  const status = STATUSES.find(s => s === info.status) ?? null
  const bucket = typeof info.rateLimitType === 'string' && info.rateLimitType ? info.rateLimitType : 'unspecified'
  const primary: Reading = {
    bucket,
    utilization: normUtilization(info.utilization),
    status,
    resetsAt: normReset(info.resetsAt),
    source,
    at,
  }
  const out: Reading[] = [primary]
  const windows = obj(info.unifiedWindows)
  for (const [name, raw] of Object.entries(windows ?? {})) {
    const w = obj(raw)
    if (!w) continue
    const r: Reading = { bucket: name, utilization: normUtilization(w.utilization), status: null, resetsAt: normReset(w.resetsAt), source, at }
    if (name === bucket) {
      primary.utilization ??= r.utilization
      primary.resetsAt ??= r.resetsAt
    } else out.push(r)
  }
  return out
}

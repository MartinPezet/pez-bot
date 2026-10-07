import type { HealthCheck } from './health.js'
import type { JobRun } from './state/jobs.js'
import type { Lease } from './state/lock.js'

export interface ProjectConfigState {
  ok: boolean
  errors: string[]
  displayName?: string
  branch?: string
  checkedAt: string
}

export interface UsageRow {
  bucket: string
  utilization: number | null
  status: string | null
  resets_at: string | null
  source: string
  at: string
}

export interface UpdateRow {
  at: string
  component: string
  from_version: string | null
  to_version: string | null
  outcome: string
}

export interface StatusData {
  now: Date
  tz: string
  targetRepo: string | null
  envErrors: string[]
  project: ProjectConfigState | null
  queue: Record<string, number> | null
  current: JobRun | undefined
  lease: Lease | undefined
  recent: JobRun[]
  claudeVersion: string | null
  updates: UpdateRow[]
  usage: UsageRow[]
  gate: string | null
  nextWindow: string | null
  disk: { freeGb: number | null; minGb: number }
  health: HealthCheck[]
}

const fmt = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso))
const ago = (iso: string, now: Date) => {
  const min = Math.round((now.getTime() - Date.parse(iso)) / 60_000)
  return min < 120 ? `${min} min ago` : `${Math.round(min / 60)} h ago`
}
const pad = (s: string, n: number) => s.padEnd(n)

/** Pure text rendering so it can be tested without a container. */
export function renderStatus(s: StatusData): string {
  const L: string[] = []
  const row = (label: string, value: string) => L.push(`${pad(label, 9)}${value}`)
  const more = (value: string) => L.push(`${pad('', 9)}${value}`)

  L.push(`pez-bot status — ${fmt(s.now.toISOString(), s.tz)} (${s.tz})`, '')
  row('Target', `${s.targetRepo ?? '(TARGET_REPO not set)'}${s.project?.displayName ? `  "${s.project.displayName}"` : ''}`)

  row('Config', `env ${s.envErrors.length ? '✗' : '✓'}   project ${s.project === null ? '? (not loaded yet)' : s.project.ok ? '✓' : '✗'}`)
  for (const e of s.envErrors) more(`✗ env ${e}`)
  for (const e of s.project?.errors ?? []) more(`✗ ${e}`)

  if (s.queue) row('Queue', Object.entries(s.queue).map(([k, v]) => `${k} ${v}`).join(' · '))
  else row('Queue', '(not available yet)')

  if (s.current) {
    row('Job', `running ${s.current.job}${s.current.issue ? ` #${s.current.issue}` : ''} since ${fmt(s.current.started_at, s.tz)}`)
  } else row('Job', 'idle')
  if (s.lease) more(`lease: ${s.lease.job} held by ${s.lease.holder}, heartbeat ${ago(s.lease.heartbeat_at, s.now)}`)

  row('Recent', s.recent.length ? '' : 'none')
  for (const r of s.recent) {
    const cost = r.est_cost_usd === null ? '' : `  est $${r.est_cost_usd.toFixed(2)}`
    more(`${fmt(r.started_at, s.tz)}  ${pad(r.job, 8)} ${pad(r.outcome ?? 'running', 12)}${r.issue ? `#${r.issue}` : ''}${cost}`)
  }

  row('Claude', s.claudeVersion ?? '(version unavailable)')
  if (s.updates.length === 0) more('no updates recorded')
  for (const u of s.updates) more(`${fmt(u.at, s.tz)}  ${u.component} ${u.from_version ?? '?'} → ${u.to_version ?? '?'}  ${u.outcome}`)

  if (s.usage.length === 0) row('Usage', 'no readings yet')
  else {
    row('Usage', '')
    for (const u of s.usage) {
      const pct = u.utilization === null ? 'unknown' : `${Math.round(u.utilization * 100)}%`
      const reset = u.resets_at ? `, resets ${fmt(u.resets_at, s.tz)}` : ''
      more(`${pad(u.bucket, 10)} ${pad(pct, 8)} ${u.status ?? ''} (${u.source}, ${ago(u.at, s.now)}${reset})`)
    }
  }
  row('Gate', s.gate ?? '(not available yet)')
  row('Window', s.nextWindow ?? '(not available yet)')

  row('Disk', s.disk.freeGb === null ? 'unknown' : `${s.disk.freeGb.toFixed(1)} GB free (min ${s.disk.minGb})`)

  const healthy = s.health.every(h => h.ok)
  row('Health', healthy ? 'healthy' : 'UNHEALTHY')
  for (const h of s.health) more(`${h.ok ? '✓' : '✗'} ${pad(h.name, 12)} ${h.detail}`)

  return L.join('\n')
}

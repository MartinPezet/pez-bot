import { readFileSync, statfsSync } from 'node:fs'
import type { JobRun } from './state/jobs.js'

/** Written by docker/init-firewall.sh (as root) at start and on every refresh. */
export interface FirewallState {
  ok: boolean
  checkedAt: string
  blocked?: string
  allowed?: string
  error?: string | null
}

export function readFirewall(file: string): FirewallState | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as FirewallState
  } catch {
    return null
  }
}

export function freeGb(dir: string): number | null {
  try {
    const s = statfsSync(dir)
    return (s.bavail * s.bsize) / 1e9
  } catch {
    return null
  }
}

export interface HealthInput {
  now: Date
  heartbeatAt?: string | undefined
  lastFinished: Pick<JobRun, 'outcome'>[]
  firewall: FirewallState | null
  githubAuth?: { ok: boolean; detail: string } | undefined
  freeGb: number | null
  minFreeGb: number
}

export interface HealthCheck {
  name: string
  ok: boolean
  detail: string
}

export const HEARTBEAT_MAX_AGE_MIN = 60

/** Pure: the Docker HEALTHCHECK and `status` both use this. No network calls here. */
export function evaluateHealth(i: HealthInput): HealthCheck[] {
  const checks: HealthCheck[] = []

  if (!i.heartbeatAt) checks.push({ name: 'heartbeat', ok: false, detail: 'no heartbeat yet' })
  else {
    const ageMin = (i.now.getTime() - Date.parse(i.heartbeatAt)) / 60_000
    checks.push({ name: 'heartbeat', ok: ageMin <= HEARTBEAT_MAX_AGE_MIN, detail: `${Math.round(ageMin)} min old` })
  }

  const allErrored = i.lastFinished.length >= 3 && i.lastFinished.slice(0, 3).every(r => r.outcome === 'error')
  checks.push({ name: 'jobs', ok: !allErrored, detail: allErrored ? 'last 3 jobs errored' : 'ok' })

  checks.push(
    i.githubAuth
      ? { name: 'github-auth', ok: i.githubAuth.ok, detail: i.githubAuth.detail }
      : { name: 'github-auth', ok: true, detail: 'not checked yet' },
  )

  checks.push(
    i.freeGb === null
      ? { name: 'disk', ok: false, detail: 'could not read free space' }
      : { name: 'disk', ok: i.freeGb >= i.minFreeGb, detail: `${i.freeGb.toFixed(1)} GB free (min ${i.minFreeGb})` },
  )

  checks.push(
    i.firewall === null
      ? { name: 'firewall', ok: false, detail: 'firewall check has not run' }
      : { name: 'firewall', ok: i.firewall.ok, detail: i.firewall.ok ? `verified ${i.firewall.checkedAt}` : (i.firewall.error ?? 'failed') },
  )

  return checks
}

import { describe, expect, it } from 'vitest'
import { evaluateHealth, type HealthInput } from '../src/health.js'
import { renderStatus, type StatusData } from '../src/status.js'

const now = new Date('2026-10-05T09:00:00Z')
const healthy: HealthInput = {
  now,
  heartbeatAt: '2026-10-05T08:59:00Z',
  lastFinished: [{ outcome: 'ok' }, { outcome: 'error' }, { outcome: 'error' }],
  firewall: { ok: true, checkedAt: '2026-10-05T08:00:00Z' },
  githubAuth: { ok: true, detail: 'app can read acme/earthscope' },
  freeGb: 50,
  minFreeGb: 10,
}
const failing = (i: HealthInput) => evaluateHealth(i).filter(c => !c.ok).map(c => c.name)

describe('health', () => {
  it('passes when everything is fine', () => {
    expect(failing(healthy)).toEqual([])
  })

  it('fails on a stale or missing heartbeat', () => {
    expect(failing({ ...healthy, heartbeatAt: '2026-10-05T07:59:00Z' })).toEqual(['heartbeat'])
    expect(failing({ ...healthy, heartbeatAt: undefined })).toEqual(['heartbeat'])
  })

  it('fails only when the last 3 jobs all errored', () => {
    expect(failing({ ...healthy, lastFinished: [{ outcome: 'error' }, { outcome: 'error' }] })).toEqual([])
    expect(failing({ ...healthy, lastFinished: [{ outcome: 'error' }, { outcome: 'error' }, { outcome: 'error' }] })).toEqual(['jobs'])
  })

  it('fails on bad GitHub auth but not before the first check', () => {
    expect(failing({ ...healthy, githubAuth: { ok: false, detail: '401' } })).toEqual(['github-auth'])
    expect(failing({ ...healthy, githubAuth: undefined })).toEqual([])
  })

  it('fails on low disk and on a failed or missing firewall check', () => {
    expect(failing({ ...healthy, freeGb: 4 })).toEqual(['disk'])
    expect(failing({ ...healthy, firewall: { ok: false, checkedAt: '', error: 'example.com reachable' } })).toEqual(['firewall'])
    expect(failing({ ...healthy, firewall: null })).toEqual(['firewall'])
  })
})

describe('status rendering', () => {
  const data: StatusData = {
    now,
    tz: 'Europe/London',
    targetRepo: 'acme/earthscope',
    envErrors: [],
    project: { ok: false, errors: ['.backlog-runner.json not found on main.'], branch: 'main', checkedAt: '2026-10-05T08:40:00Z' },
    queue: null,
    current: undefined,
    lease: undefined,
    recent: [
      { id: 2, job: 'sync', issue: null, started_at: '2026-10-05T08:40:00Z', ended_at: '2026-10-05T08:40:10Z', outcome: 'ok', detail: null, est_cost_usd: null, turns: null },
      { id: 1, job: 'work', issue: 12, started_at: '2026-10-05T08:00:00Z', ended_at: '2026-10-05T08:30:00Z', outcome: 'blocked', detail: null, est_cost_usd: 1.234, turns: 40 },
    ],
    claudeVersion: '2.1.300 (Claude Code)',
    updates: [],
    usage: [{ bucket: 'seven_day', utilization: 0.42, status: 'allowed', resets_at: null, source: 'usage-cmd', at: '2026-10-05T08:48:00Z' }],
    gate: null,
    nextWindow: null,
    disk: { freeGb: 50, minGb: 10 },
    health: evaluateHealth(healthy),
  }

  it('renders every section in the configured time zone', () => {
    const out = renderStatus(data)
    expect(out).toContain('05/10/2026, 10:00 (Europe/London)')
    expect(out).toContain('Target   acme/earthscope')
    expect(out).toContain('project ✗')
    expect(out).toContain('✗ .backlog-runner.json not found on main.')
    expect(out).toContain('Job      idle')
    expect(out).toMatch(/work\s+blocked\s+#12\s+est \$1\.23/)
    expect(out).toContain('Claude   2.1.300 (Claude Code)')
    expect(out).toMatch(/seven_day\s+42%\s+allowed \(usage-cmd, 12 min ago\)/)
    expect(out).toContain('Disk     50.0 GB free (min 10)')
    expect(out).toContain('Health   healthy')
  })

  it('marks an unknown utilisation and an unhealthy container', () => {
    const out = renderStatus({
      ...data,
      usage: [{ ...data.usage[0]!, utilization: null }],
      health: evaluateHealth({ ...healthy, firewall: null }),
    })
    expect(out).toMatch(/seven_day\s+unknown/)
    expect(out).toContain('Health   UNHEALTHY')
    expect(out).toContain('✗ firewall     firewall check has not run')
  })
})

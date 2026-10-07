#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { loadEnv } from './config/env.js'
import { createApp, type App } from './app.js'
import { applyMigration, migratePrd } from './jobs/migrate.js'
import { runJob } from './jobs/runner.js'
import { setup } from './jobs/setup.js'
import type { JobResult } from './jobs/types.js'
import { STATES, stateOf } from './github/labels.js'
import { PAUSE_KEY } from './jobs/update.js'
import { usageReport } from './usage/report.js'
import { createContext, displayTz } from './context.js'
import { isJobName, type JobName } from './jobs/registry.js'
import { runDaemon, runNamed } from './scheduler.js'
import { evaluateHealth, freeGb, readFirewall, type HealthInput } from './health.js'
import { paths } from './paths.js'
import { kv, openDb, type DB } from './state/db.js'
import { currentRun, recentFinished, recentRuns } from './state/jobs.js'
import { lockHolder } from './state/lock.js'
import { renderStatus, type ProjectConfigState, type UpdateRow, type UsageRow } from './status.js'

const HELP = `pez-bot — containerised backlog runner

Usage: pez-bot <command> [options]

  daemon                      the scheduler (default)
  sync | work | triage        run that job once (work/triage accept --ignore-budget)
  summary | update | cleanup  run that job once
  status                      queue, jobs, versions, usage, disk, health
  healthcheck                 exit 0 if healthy (used by Docker HEALTHCHECK)
  setup                       labels, Discussions checks, scaffolding PR
  migrate-prd [--path PRD.md] [--apply]
  updates resume              clear an update pause after a rollback
  usage [--probe]             gauge readings, gate state, window schedule
`

const minFreeGb = () => {
  const env = loadEnv()
  return env.ok ? env.value.MIN_FREE_DISK_GB : Number(process.env.MIN_FREE_DISK_GB ?? 10)
}

function healthInput(db: DB): HealthInput {
  const p = paths()
  return {
    now: new Date(),
    heartbeatAt: kv.get(db, 'heartbeat'),
    lastFinished: recentFinished(db, 3),
    firewall: readFirewall(p.firewall),
    githubAuth: kv.getJson<{ ok: boolean; detail: string }>(db, 'health.github'),
    freeGb: freeGb(p.data),
    minFreeGb: minFreeGb(),
  }
}

function healthcheck(): number {
  const p = paths()
  if (!existsSync(p.db)) {
    console.log('unhealthy: no state database yet')
    return 1
  }
  const db = openDb(p.db, { readonly: true })
  try {
    const checks = evaluateHealth(healthInput(db))
    for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`)
    return checks.every(c => c.ok) ? 0 : 1
  } finally {
    db.close()
  }
}

async function status(): Promise<number> {
  const ctx = createContext()
  if (!existsSync(ctx.paths.db)) {
    console.log('No state database yet: start the daemon first.')
    return 1
  }
  const db = openDb(ctx.paths.db, { readonly: true })
  try {
    const version = await ctx.run('claude', ['--version'], { as: 'agent', timeoutMs: 15_000 })
    const usage = db
      .prepare(
        `SELECT bucket, utilization, status, resets_at, source, at FROM usage_readings u
         WHERE id = (SELECT MAX(id) FROM usage_readings WHERE bucket = u.bucket) ORDER BY bucket`,
      )
      .all() as UsageRow[]
    const updates = db
      .prepare('SELECT at, component, from_version, to_version, outcome FROM updates ORDER BY id DESC LIMIT 5')
      .all() as UpdateRow[]
    const h = healthInput(db)
    const project = kv.getJson<ProjectConfigState>(db, 'project.config') ?? null
    const tz = project?.timezone ?? displayTz(ctx.env)
    let queue: Record<string, number> | null = null
    let report: { gate: string; window: string } | null = null
    if (ctx.env.ok) {
      const app = createApp(ctx, db, ctx.env.value)
      report = usageReport(ctx.env.value, db, app.gauge, tz)
      try {
        const issues = await app.gh.listIssues()
        queue = Object.fromEntries(STATES.map(s => [s.slice(6), issues.filter(i => stateOf(i) === s).length]))
      } catch (e) {
        console.error(`(queue unavailable: ${e instanceof Error ? e.message : String(e)})`)
      }
    }
    console.log(
      renderStatus({
        now: new Date(),
        tz,
        targetRepo: ctx.env.ok ? ctx.env.value.TARGET_REPO : (process.env.TARGET_REPO ?? null),
        envErrors: ctx.env.ok ? [] : ctx.env.errors,
        project,
        queue,
        current: currentRun(db),
        lease: lockHolder(db),
        recent: recentRuns(db, 10),
        claudeVersion: version.exitCode === 0 ? version.stdout.trim() : null,
        updates,
        usage,
        gate: report?.gate ?? null,
        nextWindow: report?.window ?? null,
        disk: { freeGb: h.freeGb, minGb: h.minFreeGb },
        health: evaluateHealth(h),
      }),
    )
    return 0
  } finally {
    db.close()
  }
}

/** `updates resume`: clear the pause left by a rollback. */
function updatesCmd(args: string[]): number {
  if (args[0] !== 'resume') {
    console.error('Usage: pez-bot updates resume')
    return 64
  }
  const db = openDb(paths().db)
  try {
    const was = kv.get(db, PAUSE_KEY)
    kv.del(db, PAUSE_KEY)
    console.log(was ? `Update pause (until ${was}) cleared; the next update run will proceed.` : 'Updates were not paused.')
    return 0
  } finally {
    db.close()
  }
}

/** Gauge readings, gate state and the window schedule. `--probe` forces a fresh reading. */
async function usage(args: string[]): Promise<number> {
  const ctx = createContext()
  if (!ctx.env.ok) {
    for (const e of ctx.env.errors) console.error(`env ${e}`)
    return 78
  }
  const db = openDb(ctx.paths.db)
  try {
    const app = createApp(ctx, db, ctx.env.value)
    if (args.includes('--probe')) {
      try {
        const r = await app.gauge.probe()
        kv.set(db, 'usage.last_probe', new Date().toISOString())
        console.log(`Probe: ${r.map(x => `${x.bucket} ${x.utilization === null ? '?' : `${Math.round(x.utilization * 100)}%`} (${x.source})`).join(', ')}`)
      } catch (e) {
        console.log(`Probe failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    const tz = kv.getJson<ProjectConfigState>(db, 'project.config')?.timezone ?? displayTz(ctx.env)
    console.log(usageReport(ctx.env.value, db, app.gauge, tz).text)
    return 0
  } finally {
    db.close()
  }
}

/** Runs one job now. Exit codes: 0 ok/noop, 1 error, 75 skipped (lease held or gate closed), 78 bad env. */
async function withApp(name: string, fn: (app: App) => Promise<JobResult>): Promise<number> {
  const ctx = createContext()
  if (!ctx.env.ok) {
    for (const e of ctx.env.errors) console.error(`env ${e}`)
    return 78
  }
  const db = openDb(ctx.paths.db)
  const app = createApp(ctx, db, ctx.env.value)
  const onSignal = () => app.abort.abort()
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)
  try {
    const r = await fn(app)
    const multiline = r.detail?.includes('\n')
    console.log(`${name}: ${r.outcome}${r.kind && r.kind !== name ? ` (${r.kind})` : ''}${r.detail ? (multiline ? `\n${r.detail}` : ` — ${r.detail}`) : ''}`)
    return r.outcome === 'error' ? 1 : r.outcome === 'skipped' ? 75 : 0
  } finally {
    db.close()
  }
}

const oneShot = (name: JobName, args: string[]) =>
  withApp(name, app => runNamed(app, name, { ignoreBudget: args.includes('--ignore-budget') }))

const setupCmd = () =>
  withApp('setup', app =>
    runJob(app, 'setup', d => setup(d, { digestGh: app.digestGh, project: app.state.project, projectErrors: app.state.projectErrors }), {
      system: true,
    }),
  )

function migrateCmd(args: string[]): Promise<number> {
  if (args.includes('--apply')) return withApp('migrate-prd --apply', app => runJob(app, 'migrate-apply', d => applyMigration(d)))
  const i = args.indexOf('--path')
  const prdPath = i >= 0 ? (args[i + 1] ?? 'PRD.md') : 'PRD.md'
  return withApp('migrate-prd', app =>
    runJob(app, 'migrate', d => migratePrd(d, { prdPath, ignoreBudget: args.includes('--ignore-budget') }), { claude: true }),
  )
}

/**
 * `docker exec` runs as root. Everything except the health check re-executes itself as the
 * runner user (without NET_ADMIN/NET_RAW), so state files never end up root-owned.
 */
function dropRootIfNeeded(argv: string[]): number | null {
  if (process.getuid?.() !== 0 || argv[0] === 'healthcheck' || process.env.PEZ_BOT_ALLOW_ROOT === '1') return null
  try {
    execFileSync(
      'setpriv',
      [
        '--reuid=runner', '--regid=work', '--init-groups', '--inh-caps=-all', '--bounding-set=-net_admin,-net_raw',
        'env', 'HOME=/home/runner', process.execPath, realpathSync(process.argv[1] ?? ''), ...argv,
      ],
      { stdio: 'inherit' },
    )
    return 0
  } catch (e) {
    return (e as { status?: number }).status ?? 1
  }
}

export async function main(argv: string[]): Promise<number> {
  const dropped = dropRootIfNeeded(argv)
  if (dropped !== null) return dropped
  process.umask(0o002) // worktrees are shared with the agent user through the `work` group

  const [cmd = 'daemon'] = argv
  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP)
      return 0
    case 'healthcheck':
      return healthcheck()
    case 'status':
      return status()
    case 'usage':
      return usage(argv.slice(1))
    case 'updates':
      return updatesCmd(argv.slice(1))
    case 'setup':
      return setupCmd()
    case 'migrate-prd':
      return migrateCmd(argv.slice(1))
    case 'daemon':
      return runDaemon(createContext())
    default: {
      if (isJobName(cmd)) return oneShot(cmd, argv.slice(1))
      console.error(`Unknown command "${cmd}".\n\n${HELP}`)
      return 64
    }
  }
}

// realpath: in the image this runs through the /usr/local/bin/pez-bot symlink.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    code => {
      process.exitCode = code
    },
    (e: unknown) => {
      console.error(e)
      process.exitCode = 1
    },
  )
}

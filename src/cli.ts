#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { loadEnv } from './config/env.js'
import { createContext, displayTz } from './context.js'
import { daemon } from './daemon.js'
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

/** Commands that exist in the CLI surface but arrive in a later milestone. */
const LATER: Record<string, number> = {
  sync: 4,
  work: 4,
  summary: 4,
  usage: 5,
  triage: 6,
  update: 7,
  cleanup: 7,
  updates: 7,
  setup: 8,
  'migrate-prd': 8,
}

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
    console.log(
      renderStatus({
        now: new Date(),
        tz: displayTz(ctx.env),
        targetRepo: ctx.env.ok ? ctx.env.value.TARGET_REPO : (process.env.TARGET_REPO ?? null),
        envErrors: ctx.env.ok ? [] : ctx.env.errors,
        project: kv.getJson<ProjectConfigState>(db, 'project.config') ?? null,
        queue: null,
        current: currentRun(db),
        lease: lockHolder(db),
        recent: recentRuns(db, 10),
        claudeVersion: version.exitCode === 0 ? version.stdout.trim() : null,
        updates,
        usage,
        gate: null,
        nextWindow: null,
        disk: { freeGb: h.freeGb, minGb: h.minFreeGb },
        health: evaluateHealth(h),
      }),
    )
    return 0
  } finally {
    db.close()
  }
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
    case 'daemon':
      return daemon(createContext())
    default: {
      const m = LATER[cmd]
      if (m !== undefined) {
        console.error(`"${cmd}" is not built yet (milestone ${m}).`)
        return 2
      }
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

import { Cron } from 'croner'
import { createApp, type App } from './app.js'
import type { Ctx } from './context.js'
import { checkGitHubAuth } from './github/auth.js'
import { readFirewall } from './health.js'
import { JOBS, type JobDef, type JobName } from './jobs/registry.js'
import { heartbeat, queueDigest, refreshProject, runJob } from './jobs/runner.js'
import type { JobResult } from './jobs/types.js'
import { kv, openDb, type DB } from './state/db.js'
import { acquireLock, releaseLock } from './state/lock.js'
import { parseWindows, windowAt } from './windows/windows.js'

const DOWNTIME_MIN = 30

/** Jobs whose result means "something was done": the work loop continues straight away. */
const didWork = (r: JobResult) => (r.kind === 'build' || r.kind === 'propose') && r.outcome !== 'skipped' && r.outcome !== 'noop'

/**
 * One scheduler, one queue, one job at a time. Cron ticks only enqueue; the pump runs jobs
 * sequentially and keeps the work loop going while it finds work.
 */
export class Scheduler {
  private queue: JobName[] = []
  private running: Promise<void> | null = null
  private stopping = false

  constructor(
    private readonly app: App,
    private readonly run: (name: JobName) => Promise<JobResult> = name => runNamed(app, name, {}),
  ) {}

  enqueue(name: JobName): void {
    if (this.stopping || this.queue.includes(name)) return
    this.queue.push(name)
    this.running ??= this.pump().finally(() => {
      this.running = null
    })
  }

  private async pump(): Promise<void> {
    for (let name = this.queue.shift(); name && !this.stopping; name = this.queue.shift()) {
      const r = await this.run(name)
      if (name === 'work' && didWork(r)) this.enqueue('work')
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.queue = []
    await this.running
  }

  get idle(): boolean {
    return this.running === null
  }
}

export function runNamed(app: App, name: JobName, o: { ignoreBudget?: boolean }): Promise<JobResult> {
  const job: JobDef = JOBS[name]
  const opts = { ignoreBudget: o.ignoreBudget ?? false }
  return job.system
    ? runJob(app, name, d => job.fn(d, opts), { ...job.opts, system: true })
    : runJob(app, name, d => job.fn(d, opts), { ...job.opts, system: false })
}

/** Degraded mode keeps the heartbeat (and `status`) alive so a config problem doesn't restart-loop. */
async function degraded(db: DB, ctx: Ctx, errors: string[]): Promise<number> {
  ctx.log.error({ errors }, 'invalid environment: fix .env and restart; no jobs will run')
  const beat = new Cron('* * * * *', () => heartbeat(db))
  heartbeat(db)
  await waitForSignal(ctx)
  beat.stop()
  db.close()
  return 0
}

const waitForSignal = (ctx: Ctx) =>
  new Promise<void>(resolve => {
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      process.once(sig, () => {
        ctx.log.info({ sig }, 'shutting down')
        resolve()
      })
    }
  })

export async function runDaemon(ctx: Ctx): Promise<number> {
  const db = openDb(ctx.paths.db)
  if (!ctx.env.ok) return degraded(db, ctx, ctx.env.errors)
  const env = ctx.env.value
  const app = createApp(ctx, db, env)
  const { log } = app

  // A predecessor in this container that died mid-job leaves a lease behind: take it over.
  if (acquireLock(db, app.holder, 'daemon-start', { takeover: true })) releaseLock(db, app.holder)

  const last = kv.get(db, 'heartbeat')
  const now = new Date()
  if (last && now.getTime() - Date.parse(last) > DOWNTIME_MIN * 60_000) {
    queueDigest(db, '🔌', `Runner recovered after downtime from ${last.slice(0, 16).replace('T', ' ')} to ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`)
  }
  heartbeat(db)

  const fw = readFirewall(ctx.paths.firewall)
  if (!fw?.ok) {
    log.error({ firewall: fw }, 'firewall check failed: Claude jobs will be refused')
    queueDigest(db, '🧱', `Firewall check failed: ${fw?.error ?? 'no result'}. Claude jobs are refused until it passes.`)
  }

  await refreshProject(app).catch(e => log.error({ err: e }, 'initial repo refresh failed'))
  const tz = app.state.project?.timezone ?? env.TZ
  const sched = app.state.project?.schedule ?? {}
  const specs = parseWindows(env.RUN_WINDOWS)
  // Triage runs once at the start of each run window (if there's anything to triage).
  const scheduler = new Scheduler(app, async name => {
    const r = await runNamed(app, name, {})
    const w = windowAt(new Date(), specs, tz)
    if (name === 'triage' && r.outcome !== 'skipped' && w) kv.set(db, 'triage.window', w.start.toISOString())
    return r
  })
  const workTick = () => {
    const w = windowAt(new Date(), specs, tz)
    if (w && kv.get(db, 'triage.window') !== w.start.toISOString()) scheduler.enqueue('triage')
    scheduler.enqueue('work')
  }
  const every = (expr: string, fn: () => void) => new Cron(expr, { timezone: tz, protect: true }, fn)
  const authCheck = async () => {
    const r = await checkGitHubAuth(app.tokens, env.TARGET_REPO)
    kv.setJson(db, 'health.github', r)
    if (!r.ok) log.error(r, 'GitHub auth check failed')
  }

  const crons = [
    every('* * * * *', () => heartbeat(db)),
    every('*/30 * * * *', () => void authCheck()),
    every(sched.sync ?? '*/20 * * * *', () => scheduler.enqueue('sync')),
    every('*/5 * * * *', workTick),
    every(sched.summary ?? '30 7 * * 1-5', () => scheduler.enqueue('summary')),
    // Queued behind any running job, so updates only happen when idle, never mid-job.
    every(sched.update ?? '0 3 * * *', () => scheduler.enqueue('update')),
    every(sched.cleanup ?? '0 4 * * *', () => scheduler.enqueue('cleanup')),
  ]
  await authCheck()
  scheduler.enqueue('update')
  scheduler.enqueue('sync')
  workTick()

  await waitForSignal(ctx)
  app.abort.abort() // a running Claude job checkpoints and requeues
  for (const c of crons) c.stop()
  await scheduler.stop()
  db.close()
  return 0
}

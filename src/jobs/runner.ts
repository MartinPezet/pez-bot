import type { App } from '../app.js'
import { parseProjectConfig, PROJECT_CONFIG_FILE } from '../config/project.js'
import { Digest, DigestBatch, DigestSetupError, type DigestEvent } from '../digest/digest.js'
import { loadPrompt, render } from '../prompts.js'
import { kv, type DB } from '../state/db.js'
import { finishRun, startRun } from '../state/jobs.js'
import { acquireLock, beatLock, releaseLock } from '../state/lock.js'
import type { ProjectConfigState } from '../status.js'
import { diskGuard } from './cleanup.js'
import type { Deps, JobResult, SysDeps } from './types.js'

export const heartbeat = (db: DB, now = new Date()) => kv.set(db, 'heartbeat', now.toISOString(), now)

/** Events raised outside a job (startup, downtime, firewall) ride along with the next job's digest post. */
export function queueDigest(db: DB, emoji: string, text: string, url?: string, at = new Date()): void {
  const pending = kv.getJson<{ emoji: string; text: string; url?: string; at: string }[]>(db, 'digest.pending') ?? []
  pending.push({ emoji, text, ...(url ? { url } : {}), at: at.toISOString() })
  kv.setJson(db, 'digest.pending', pending)
}

function drainPending(db: DB, batch: DigestBatch): void {
  const pending = kv.getJson<{ emoji: string; text: string; url?: string; at: string }[]>(db, 'digest.pending') ?? []
  for (const e of pending) batch.add(e.emoji, e.text, e.url, new Date(e.at))
  kv.del(db, 'digest.pending')
}

export interface JobOptions {
  /** Calls Claude: refused unless the firewall check passed, skipped while disk is low. */
  claude?: boolean
  /** Runs without a valid .backlog-runner.json (update, cleanup, setup). */
  system?: boolean
}

export type JobFn = (d: Deps) => Promise<JobResult>
export type SysJobFn = (d: SysDeps) => Promise<JobResult>

export class PreconditionError extends Error {
  override name = 'PreconditionError'
}

/** Fetch the default branch and (re)load the project config into app.state. */
export async function refreshProject(app: App): Promise<void> {
  await app.git.ensureClone(app.env.TARGET_REPO)
  const branch = await app.git.defaultBranch()
  const res = parseProjectConfig(await app.git.readAtRef(`origin/${branch}`, PROJECT_CONFIG_FILE), branch)
  app.state.branch = res.ok && res.value.defaultBranch ? res.value.defaultBranch : branch
  app.state.project = res.ok ? res.value : null
  app.state.projectErrors = res.ok ? [] : res.errors
  const st: ProjectConfigState = res.ok
    ? { ok: true, errors: [], displayName: res.value.displayName, timezone: res.value.timezone, branch, checkedAt: new Date().toISOString() }
    : { ok: false, errors: res.errors, branch, checkedAt: new Date().toISOString() }
  kv.setJson(app.db, 'project.config', st)
}

export function makeDeps(app: App, batch: DigestBatch): Deps {
  const project = app.state.project
  if (!project) throw new PreconditionError(`project config invalid: ${app.state.projectErrors.join('; ')}`)
  const { git } = app
  return {
    ...makeSysDeps(app, batch),
    project,
    claude: app.claude,
    prompt: async (name, vars) => render(await loadPrompt(name, f => git.readAtRef(`origin/${app.state.branch}`, f)), vars),
    gate: app.makeGate(project, (emoji, text) => batch.add(emoji, text)),
  }
}

export function makeSysDeps(app: App, batch: DigestBatch): SysDeps {
  return {
    env: app.env,
    branch: app.state.branch,
    gh: app.gh,
    wt: app.wt,
    run: app.ctx.run,
    db: app.db,
    log: app.log,
    digest: batch,
    paths: app.ctx.paths,
    now: () => new Date(),
    botLogin: '',
    signal: app.abort.signal,
  }
}

async function healthPing(app: App, failed: boolean) {
  const url = app.env.HEALTH_PING_URL
  if (!url) return
  try {
    await fetch(failed ? `${url.replace(/\/+$/, '')}/fail` : url, { signal: AbortSignal.timeout(10_000) })
  } catch (e) {
    app.log.warn({ err: e }, 'health ping failed')
  }
}

/**
 * Every job goes through here: take the lease, record the run, refresh the repo and config,
 * run, then post the digest batch, clean up the worktree, heartbeat, release and ping.
 */
export function runJob(app: App, name: string, fn: JobFn, o?: JobOptions & { system?: false }): Promise<JobResult>
export function runJob(app: App, name: string, fn: SysJobFn, o: JobOptions & { system: true }): Promise<JobResult>
export async function runJob(app: App, name: string, fn: JobFn | SysJobFn, o: JobOptions = {}): Promise<JobResult> {
  const { db, log } = app
  if (!acquireLock(db, app.holder, name)) {
    log.info({ job: name }, 'another job holds the lease; not starting')
    return { outcome: 'skipped', detail: 'another job is running' }
  }
  const runId = startRun(db, name)
  const beat = setInterval(() => {
    beatLock(db, app.holder)
    heartbeat(db)
  }, 60_000)
  const batch = new DigestBatch()
  drainPending(db, batch)
  let result: JobResult = { outcome: 'error', detail: 'did not run' }
  log.info({ job: name }, 'job starting')
  const sys = makeSysDeps(app, batch)
  try {
    if (o.claude && !app.firewallOk()) throw new PreconditionError('the firewall check failed or has not run: Claude jobs are refused')
    if (o.claude && kv.get(db, 'disk.low')) {
      result = { outcome: 'skipped', detail: 'disk space is below MIN_FREE_DISK_GB' }
    } else if (o.system) {
      // System jobs (update, cleanup, setup) work without a valid project config, and even when GitHub is unreachable.
      await refreshProject(app).catch(e => log.warn({ err: e }, 'repo refresh failed; continuing'))
      sys.branch = app.state.branch
      sys.botLogin = await app.botLogin().catch(() => '')
      result = await (fn as SysJobFn)(sys)
    } else {
      await refreshProject(app)
      if (!app.state.project) throw new PreconditionError(`${PROJECT_CONFIG_FILE} is missing or invalid: ${app.state.projectErrors.join('; ')}`)
      const d = makeDeps(app, batch)
      d.botLogin = await app.botLogin()
      result = await (fn as JobFn)(d)
    }
  } catch (e) {
    result = { outcome: 'error', detail: e instanceof Error ? e.message : String(e) }
    log.error({ err: e, job: name }, 'job failed')
  } finally {
    clearInterval(beat)
    finishRun(db, runId, result)
    if (result.worktree) {
      if (result.keepWorktree) kv.set(db, `blocked-worktree.${result.worktree}`, new Date().toISOString())
      else await app.wt.remove(result.worktree).catch(e => log.warn({ err: e }, 'worktree removal failed'))
    }
    await diskGuard(sys).catch(e => log.error({ err: e }, 'disk guard failed'))
    await postDigest(app, batch)
    heartbeat(db)
    releaseLock(db, app.holder)
    await healthPing(app, result.outcome === 'error')
  }
  log.info({ job: name, outcome: result.outcome, kind: result.kind, issue: result.issue, detail: result.detail }, 'job finished')
  return result
}

export async function postDigest(app: App, batch: DigestBatch): Promise<void> {
  const project = app.state.project
  if (batch.empty) return
  if (!project) {
    app.log.warn({ events: batch.events.length }, 'digest not posted: no valid project config (no display name)')
    for (const e of batch.events) queueDigest(app.db, e.emoji, e.text, e.url, e.at)
    return
  }
  const digest = new Digest({
    gh: app.digestGh,
    db: app.db,
    category: app.env.DIGEST_CATEGORY,
    title: project.displayName,
    autoCreate: app.env.DIGEST_AUTO_CREATE,
    tz: project.timezone,
    log: app.log,
  })
  try {
    await digest.post(batch)
    kv.del(app.db, 'digest.problem')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    kv.set(app.db, 'digest.problem', msg)
    app.log.error({ err: e, setup: e instanceof DigestSetupError }, 'digest post failed')
    // Keep the events so they go out once the problem is fixed.
    for (const ev of batch.events) queueDigest(app.db, ev.emoji, ev.text, ev.url, ev.at)
  }
}

export type { DigestEvent }

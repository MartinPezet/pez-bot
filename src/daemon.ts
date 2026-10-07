import { Cron } from 'croner'
import { parseProjectConfig, PROJECT_CONFIG_FILE } from './config/project.js'
import type { Ctx } from './context.js'
import { Git } from './exec/git.js'
import { checkGitHubAuth, tokenProviderFromEnv } from './github/auth.js'
import { readFirewall } from './health.js'
import { kv, openDb, type DB } from './state/db.js'
import type { ProjectConfigState } from './status.js'

export const ASKPASS = process.env.GIT_ASKPASS_SCRIPT ?? '/opt/runner/docker/git-askpass.sh'

export const heartbeat = (db: DB, now = new Date()) => kv.set(db, 'heartbeat', now.toISOString(), now)

/**
 * M2 daemon: keeps state fresh (heartbeat, repo clone/fetch, project config, GitHub auth)
 * and refuses work when the firewall or config is bad. Jobs are scheduled from M4.
 */
export async function daemon(ctx: Ctx): Promise<number> {
  const { log, paths } = ctx
  const db = openDb(paths.db)
  log.info({ dataDir: paths.data }, 'daemon starting')

  const fw = readFirewall(paths.firewall)
  if (!fw?.ok) log.error({ firewall: fw }, 'firewall check failed or missing: jobs will not run')

  const safe = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (e) {
      log.error({ err: e }, `${name} failed`)
    }
  }

  const crons: Cron[] = [new Cron('* * * * *', () => heartbeat(db))]
  heartbeat(db)

  if (!ctx.env.ok) {
    log.error({ errors: ctx.env.errors }, 'invalid environment: fix .env and restart; jobs will not run')
  } else {
    const env = ctx.env.value
    const provider = tokenProviderFromEnv(env)
    const git = new Git(ctx.run, paths.repo, () => provider.token(), ASKPASS)

    const refreshRepo = async () => {
      const how = await git.ensureClone(env.TARGET_REPO)
      const branch = await git.defaultBranch()
      const res = parseProjectConfig(await git.readAtRef(`origin/${branch}`, PROJECT_CONFIG_FILE), branch)
      const state: ProjectConfigState = res.ok
        ? { ok: true, errors: [], displayName: res.value.displayName, branch, checkedAt: new Date().toISOString() }
        : { ok: false, errors: res.errors, branch, checkedAt: new Date().toISOString() }
      kv.setJson(db, 'project.config', state)
      if (res.ok) log.info({ how, branch }, 'repo ready, project config valid')
      else log.error({ how, branch, errors: res.errors }, 'project config invalid: jobs will not run')
    }
    const checkAuth = async () => {
      const r = await checkGitHubAuth(provider, env.TARGET_REPO)
      kv.setJson(db, 'health.github', r)
      if (!r.ok) log.error(r, 'GitHub auth check failed')
    }

    await safe('github auth check', checkAuth)
    await safe('repo refresh', refreshRepo)
    crons.push(new Cron('*/30 * * * *', () => safe('github auth check', checkAuth)))
    crons.push(new Cron('*/20 * * * *', () => safe('repo refresh', refreshRepo)))
  }

  await new Promise<void>(resolve => {
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      process.once(sig, () => {
        log.info({ sig }, 'shutting down')
        resolve()
      })
    }
  })
  for (const c of crons) c.stop()
  db.close()
  return 0
}

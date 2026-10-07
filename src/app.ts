import type { Env } from './config/env.js'
import type { ProjectConfig } from './config/project.js'
import type { Ctx } from './context.js'
import { ClaudeCli, type Claude } from './exec/claude.js'
import { Git } from './exec/git.js'
import { tokenProviderFromEnv, type TokenProvider } from './github/auth.js'
import { HttpGitHub, type GitHub } from './github/client.js'
import { DryRunGitHub } from './github/dryrun.js'
import { readFirewall } from './health.js'
import { BudgetGate } from './jobs/gate.js'
import type { Gate } from './jobs/types.js'
import { GitWorktrees } from './jobs/worktree.js'
import { SqliteGauge } from './usage/gauge.js'
import { haikuProbe } from './usage/probe.js'
import type { Logger } from './log.js'
import type { DB } from './state/db.js'
import { makeHolder } from './state/lock.js'
import type { Reading } from './usage/passive.js'

export const ASKPASS = process.env.GIT_ASKPASS_SCRIPT ?? '/opt/runner/docker/git-askpass.sh'

/** Long-lived wiring shared by every job in this process. */
export interface App {
  ctx: Ctx
  env: Env
  db: DB
  log: Logger
  tokens: TokenProvider
  gh: GitHub
  digestGh: GitHub
  git: Git
  wt: GitWorktrees
  claude: Claude
  holder: string
  abort: AbortController
  /** Refreshed by every job: the default branch and the parsed project config. */
  state: { branch: string; project: ProjectConfig | null; projectErrors: string[] }
  gauge: SqliteGauge
  /** Budget/window gate for a project; `notify` adds digest events to the running job's batch. */
  makeGate(project: ProjectConfig, notify: (emoji: string, text: string) => void): Gate
  /** Where Claude's rate-limit readings go: the usage gauge. */
  onReadings(r: Reading[]): void
  firewallOk(): boolean
  botLogin(): Promise<string>
}

export function createApp(ctx: Ctx, db: DB, env: Env): App {
  const { log, paths } = ctx
  const tokens = tokenProviderFromEnv(env)
  const wrap = (repo: string) => {
    const real = new HttpGitHub(repo, tokens)
    return env.DRY_RUN ? new DryRunGitHub(real, log) : real
  }
  const identity = {
    GIT_AUTHOR_NAME: env.BOT_GIT_NAME,
    GIT_AUTHOR_EMAIL: env.BOT_GIT_EMAIL,
    GIT_COMMITTER_NAME: env.BOT_GIT_NAME,
    GIT_COMMITTER_EMAIL: env.BOT_GIT_EMAIL,
  }
  const git = new Git(ctx.run, paths.repo, () => tokens.token(), ASKPASS, identity)
  const state: App['state'] = { branch: 'main', project: null, projectErrors: [] }
  let login: string | undefined
  // Probes run as the agent with Claude's auth only.
  const probeEnv = () => ({
    ...(env.CLAUDE_CODE_OAUTH_TOKEN ? { CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN } : { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? '' }),
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  })
  const gauge = new SqliteGauge(db, [])
  const app: App = {
    ctx,
    env,
    db,
    log,
    tokens,
    gh: wrap(env.TARGET_REPO),
    digestGh: wrap(env.DIGEST_REPO),
    git,
    wt: new GitWorktrees(git, paths.worktrees, () => state.branch, ctx.run, env.DRY_RUN, log),
    claude: new ClaudeCli(log, r => app.onReadings(r)),
    holder: makeHolder(),
    abort: new AbortController(),
    state,
    gauge,
    makeGate: (project, notify) => new BudgetGate({ env, project, db, gauge, log, now: () => new Date(), notify }),
    onReadings: r => gauge.record(r),
    firewallOk: () => readFirewall(paths.firewall)?.ok === true,
    async botLogin() {
      login ??= await tokens.login()
      return login
    },
  }
  gauge.setProbes([haikuProbe(app.claude, probeEnv)])
  return app
}

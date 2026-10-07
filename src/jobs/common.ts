import type { Env } from '../config/env.js'
import { trustedComments, renderComments } from '../github/authors.js'
import type { Issue } from '../github/client.js'
import { setState, type State } from '../github/labels.js'
import type { ClaudeResult } from '../exec/claude.js'
import { tail } from '../exec/run.js'
import { kv } from '../state/db.js'
import type { Deps, JobResult } from './types.js'

/** Agents end their final message with one of these lines when they must stop. The last one wins. */
export type StopKind = 'NEEDS_DECISION' | 'NEEDS_SPLIT' | 'BLOCKED'

export function stopSignal(text: string): { kind: StopKind; detail: string } | null {
  const re = /^(NEEDS_DECISION|NEEDS_SPLIT|BLOCKED):[ \t]*/gm
  let last: RegExpExecArray | null = null
  for (let m = re.exec(text); m; m = re.exec(text)) last = m
  if (!last) return null
  return { kind: last[1] as StopKind, detail: text.slice(last.index + last[0].length).trim() }
}

export const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')

export const firstLine = (s: string) => s.trim().split('\n')[0]?.slice(0, 160) ?? ''

/** Environment for agent-run code (installs, gates): test services only, no secrets. */
export function agentEnv(d: Deps): Record<string, string> {
  const e = d.env
  const env: Record<string, string> = {
    CI: '1',
    GIT_AUTHOR_NAME: e.BOT_GIT_NAME,
    GIT_AUTHOR_EMAIL: e.BOT_GIT_EMAIL,
    GIT_COMMITTER_NAME: e.BOT_GIT_NAME,
    GIT_COMMITTER_EMAIL: e.BOT_GIT_EMAIL,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    npm_config_store_dir: `${d.paths.data}/pnpm-store`,
    ...d.project.extraTestEnv,
  }
  const pg = d.project.testServices.postgres
  if (pg && e.TEST_POSTGRES_URL) env[pg.env] = withDatabase(e.TEST_POSTGRES_URL, pg.database)
  const redis = d.project.testServices.redis
  if (redis && e.TEST_REDIS_URL) env[redis.env] = e.TEST_REDIS_URL
  return env
}

/** Claude's own auth and update settings: the only secret an agent process ever receives. */
export function claudeAuthEnv(env: Env): Record<string, string> {
  const auth: Record<string, string> = env.CLAUDE_CODE_OAUTH_TOKEN
    ? { CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN }
    : { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? '' }
  return { ...auth, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
}

/** Claude's environment: agent env plus Claude's own auth. Never a GitHub token. */
export function claudeEnv(d: Deps): Record<string, string> {
  return { ...agentEnv(d), ...claudeAuthEnv(d.env) }
}

export function withDatabase(url: string, database: string): string {
  const u = new URL(url)
  u.pathname = `/${database}`
  return u.toString()
}

const READ = ['Read', 'Glob', 'Grep']
const WRITE = ['Edit', 'Write', 'TodoWrite', 'Task', 'Agent', 'Skill']
const INSPECT = ['Bash(ls *)', 'Bash(cat *)', 'Bash(grep *)', 'Bash(find *)', 'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)']

/** The reference allowlist, per kind. Propose can't commit; triage can't write. */
export function allowedTools(kind: 'propose' | 'build' | 'triage' | 'migrate', extra: string[]): string[] {
  switch (kind) {
    case 'triage':
      return [...READ, 'Bash(openspec list *)', 'Bash(git log *)', 'Bash(ls *)']
    case 'propose':
      return [...READ, ...WRITE, ...INSPECT, 'Bash(openspec *)', ...extra]
    case 'migrate':
      return [...READ, 'Write', 'Edit', ...INSPECT]
    case 'build':
      return [...READ, ...WRITE, ...INSPECT, 'Bash(pnpm *)', 'Bash(npx *)', 'Bash(npm *)', 'Bash(node *)', 'Bash(openspec *)', 'Bash(git add *)', 'Bash(git commit *)', ...extra]
  }
}

/** Model key per call: `fix` runs during a build but has its own model setting. */
export type ModelKey = 'propose' | 'build' | 'fix' | 'triage' | 'migrate'

/**
 * One Claude call with the job's model, limits and tool allowlist. PERMISSION_MODE is used as
 * configured: the runner refuses every Claude job unless the firewall check passed, which is
 * what makes bypassPermissions acceptable.
 */
export function askClaude(
  d: Deps,
  o: { model: ModelKey; tools: 'propose' | 'build' | 'triage' | 'migrate'; prompt: string; cwd: string; urgent: boolean; ignoreBudget: boolean; jsonSchema?: object },
): Promise<ClaudeResult> {
  return d.claude.run({
    prompt: o.prompt,
    cwd: o.cwd,
    model: d.project.models[o.model],
    maxTurns: d.project.claude.maxTurns,
    timeoutMs: d.project.claude.timeoutMin * 60_000,
    allowedTools: allowedTools(o.tools, d.project.claude.extraAllowedTools),
    permissionMode: o.tools === 'triage' ? 'dontAsk' : d.env.PERMISSION_MODE,
    env: claudeEnv(d),
    ...(o.jsonSchema ? { jsonSchema: o.jsonSchema } : {}),
    deadline: o.ignoreBudget ? null : d.gate.deadline(o.urgent),
    signal: d.signal,
  })
}

/** Claude failures that more turns can't fix. */
export const FATAL_CLAUDE_ERRORS = ['authentication_failed', 'oauth_org_not_allowed', 'billing_error', 'account_on_hold']

export const sumCost = (a: { estCostUsd?: number | undefined; turns?: number | undefined }, r: ClaudeResult) => ({
  estCostUsd: (a.estCostUsd ?? 0) + (r.costUsd ?? 0),
  turns: (a.turns ?? 0) + (r.turns ?? 0),
})

export async function trustedThread(d: Deps, n: number): Promise<string> {
  return renderComments(trustedComments(await d.gh.issueComments(n), d.project.allowedAuthors, d.botLogin))
}

export const gatesText = (d: Deps) => d.project.gates.map(g => `\`${g.join(' ')}\``).join(', ')

/** Stops that are not the agent's fault: the work is paused and requeued, not blocked. */
export const isPause = (r: ClaudeResult) => r.stopReason === 'rate_limited' || r.stopReason === 'deadline' || r.stopReason === 'aborted'

export async function pushAndOpenPr(
  d: Deps,
  dir: string,
  branch: string,
  title: string,
  body: string,
  draft = false,
): Promise<string> {
  await d.wt.push(dir, branch)
  return (await d.gh.openPr({ head: branch, base: d.branch, title, body, draft })).url
}

/** state:blocked with a comment; partial work goes up as a draft PR. */
export async function block(d: Deps, issue: Issue, reason: string, dir?: string, branch?: string): Promise<JobResult> {
  let extra = ''
  if (dir && branch && (await d.wt.commitsAhead(dir).catch(() => 0)) > 0) {
    const url = await pushAndOpenPr(
      d, dir, branch, `WIP: ${issue.title} (#${issue.number})`,
      `Partial work: the runner is blocked. See #${issue.number}.\n\nRefs #${issue.number}`, true,
    ).catch(e => {
      d.log.error({ err: e }, 'could not push partial work')
      return ''
    })
    if (url) extra = `\n\nPartial work: ${url}`
  }
  await setState(d.gh, issue, 'state:blocked')
  await d.gh.comment(
    issue.number,
    `🚧 **Runner blocked**\n\n${reason}${extra}\n\nWhen resolved, relabel \`state:ready\` (re-propose) or \`state:approved\` (re-build).`,
  )
  d.digest.add('🚧', `Blocked #${issue.number} ${issue.title}: ${firstLine(reason.replace(/[`*]/g, ''))}`, issue.url)
  return { outcome: 'blocked', issue: issue.number, detail: firstLine(reason), worktree: dir, keepWorktree: Boolean(dir) }
}

/**
 * The run was stopped from outside (limit hit, window closed, shutdown). Commit and push what
 * exists, put the issue back in its previous queue (not blocked), and remember a limit pause.
 */
export async function pause(
  d: Deps,
  issue: Issue,
  res: ClaudeResult,
  queue: State,
  dir: string,
  branch?: string,
): Promise<JobResult> {
  let pushed = false
  if (branch) {
    await d.wt.commit(dir, `wip: checkpoint (#${issue.number})`)
    if ((await d.wt.commitsAhead(dir)) > 0) {
      await d.wt.push(dir, branch)
      pushed = true
    }
  }
  await setState(d.gh, issue, queue)
  const resets = res.resetsAt ? ` until ${res.resetsAt.toISOString()}` : ''
  const why =
    res.stopReason === 'rate_limited' ? `the usage limit was reached${resets}` :
    res.stopReason === 'deadline' ? 'the run window closed' : 'the runner was shutting down'
  if (res.stopReason === 'rate_limited' && res.resetsAt) kv.set(d.db, 'usage.paused_until', res.resetsAt.toISOString())
  await d.gh.comment(
    issue.number,
    `⏸️ **Paused**: ${why}.${pushed ? ` Work in progress is on \`${branch}\`; the next run resumes from there.` : ''} Back in \`${queue}\`.`,
  )
  d.digest.add(
    '⏸️',
    `${res.stopReason === 'deadline' ? 'Checkpointed at window end' : 'Paused'} #${issue.number} ${issue.title} (${why})`,
    issue.url,
  )
  return {
    outcome: res.stopReason === 'deadline' ? 'checkpointed' : 'paused',
    issue: issue.number,
    detail: why,
    worktree: dir,
    estCostUsd: res.costUsd,
    turns: res.turns,
  }
}

export async function resetTestServices(d: Deps): Promise<void> {
  const pg = d.project.testServices.postgres
  if (pg && d.env.TEST_POSTGRES_URL) {
    const admin = withDatabase(d.env.TEST_POSTGRES_URL, 'postgres')
    const exists = await d.run('psql', [admin, '-tAc', `SELECT 1 FROM pg_database WHERE datname = '${pg.database}'`])
    if (exists.exitCode !== 0) throw new Error(`test Postgres unreachable:\n${tail(exists.all, 10)}`)
    if (exists.stdout.trim() !== '1') await mustRun(d, 'psql', [admin, '-c', `CREATE DATABASE "${pg.database}"`])
    await mustRun(d, 'psql', [
      withDatabase(d.env.TEST_POSTGRES_URL, pg.database), '-v', 'ON_ERROR_STOP=1',
      '-c', `DROP SCHEMA IF EXISTS "${pg.schema}" CASCADE; CREATE SCHEMA "${pg.schema}";`,
    ])
  }
  if (d.project.testServices.redis && d.env.TEST_REDIS_URL) await mustRun(d, 'redis-cli', ['-u', d.env.TEST_REDIS_URL, 'FLUSHALL'])
}

async function mustRun(d: Deps, cmd: string, args: string[]) {
  const r = await d.run(cmd, args)
  if (r.exitCode !== 0) throw new Error(`${cmd} failed:\n${tail(r.all, 20)}`)
}

export async function runGates(d: Deps, dir: string): Promise<{ ok: boolean; log: string }> {
  for (const [cmd = '', ...args] of d.project.gates) {
    const r = await d.run(cmd, args, { as: 'agent', cwd: dir, env: agentEnv(d), timeoutMs: 45 * 60_000 })
    if (r.exitCode !== 0) return { ok: false, log: `$ ${[cmd, ...args].join(' ')}\n${tail(r.all, 150)}` }
  }
  return { ok: true, log: '' }
}

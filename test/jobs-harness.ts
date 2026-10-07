import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pino from 'pino'
import { loadEnv, type Env } from '../src/config/env.js'
import { projectSchema } from '../src/config/project.js'
import { DigestBatch } from '../src/digest/digest.js'
import type { Claude, ClaudeRequest, ClaudeResult } from '../src/exec/claude.js'
import type { Run, RunOpts, RunResult } from '../src/exec/run.js'
import type { Deps, Gate, WorktreeOps } from '../src/jobs/types.js'
import { openGate } from '../src/jobs/types.js'
import { paths } from '../src/paths.js'
import { openDb } from '../src/state/db.js'
import { FakeGitHub } from './fakes.js'

export const silent = pino({ level: 'silent' })

export class FakeWorktrees implements WorktreeOps {
  remote = new Set<string>()
  local: string[] = []
  extraDirs: string[] = []
  deletedLocal: string[] = []
  deletedRemote: string[] = []
  mergeResult: 'ok' | 'conflict' = 'ok'
  /** Commits per worktree dir. */
  commits = new Map<string, string[]>()
  /** Dirs with uncommitted changes. */
  dirty = new Set<string>()
  pushed: string[] = []
  removed: string[] = []
  log: string[] = []

  constructor(private readonly root: string) {}

  private dirFor(branch: string) {
    const dir = path.join(this.root, branch.replaceAll('/', '__'))
    mkdirSync(dir, { recursive: true })
    return dir
  }
  async fresh(branch: string) {
    this.log.push(`fresh ${branch}`)
    const dir = this.dirFor(branch)
    this.commits.set(dir, [])
    return dir
  }
  async resume(branch: string) {
    if (!this.remote.has(branch)) return { dir: await this.fresh(branch), resumed: false }
    this.log.push(`resume ${branch}`)
    const dir = this.dirFor(branch)
    this.commits.set(dir, ['earlier work'])
    return { dir, resumed: true }
  }
  async mergeDefault(dir: string) {
    this.log.push(`merge ${path.basename(dir)}`)
    return this.mergeResult
  }
  async commitsAhead(dir: string) {
    return this.commits.get(dir)?.length ?? 0
  }
  async commit(dir: string, message: string, paths?: string[]) {
    if (!this.dirty.has(dir)) return false
    this.dirty.delete(dir)
    this.commits.get(dir)?.push(paths ? `${message} [${paths.join(',')}]` : message)
    return true
  }
  /** Simulates the agent committing a task. */
  agentCommit(dir: string, message: string) {
    this.commits.get(dir)?.push(message)
  }
  async push(dir: string, branch: string) {
    this.pushed.push(branch)
    this.log.push(`push ${branch} (${this.commits.get(dir)?.length ?? 0} commits)`)
  }
  async remove(dir: string) {
    this.removed.push(dir)
  }
  async list() {
    return [...new Set([...this.commits.keys(), ...this.extraDirs])].filter(d => !this.removed.includes(d))
  }
  async localBranches() {
    return this.local
  }
  async remoteBranches() {
    return [...this.remote]
  }
  async deleteLocalBranch(b: string) {
    this.deletedLocal.push(b)
  }
  async deleteRemoteBranch(b: string) {
    this.deletedRemote.push(b)
  }
}

type Handler = (req: ClaudeRequest) => Partial<ClaudeResult> | Promise<Partial<ClaudeResult>>

export class FakeClaude implements Claude {
  calls: ClaudeRequest[] = []
  private handlers: Handler[] = []

  /** Queue responses in call order. */
  then(h: Handler): this {
    this.handlers.push(h)
    return this
  }
  async run(req: ClaudeRequest): Promise<ClaudeResult> {
    this.calls.push(req)
    const h = this.handlers.shift()
    if (!h) throw new Error(`unexpected Claude call #${this.calls.length}: ${req.prompt.slice(0, 60)}`)
    const r = await h(req)
    return { ok: true, text: '', stopReason: 'completed', readings: [], costUsd: 0.5, turns: 10, ...r }
  }
}

export const baseEnv = {
  TARGET_REPO: 'acme/app',
  DIGEST_REPO: 'acme/digest',
  GH_TOKEN: 'ghp_x',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test-token',
  TEST_POSTGRES_URL: 'postgres://test:test@postgres-test:5432/app_test',
  TEST_REDIS_URL: 'redis://redis-test:6379',
}

export function testEnv(extra: Record<string, string> = {}): Env {
  const r = loadEnv({ ...baseEnv, ...extra })
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return r.value
}

export function harness(o: { gate?: Gate; now?: Date; project?: Record<string, unknown> } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'pezbot-jobs-'))
  const gh = new FakeGitHub()
  const db = openDb(':memory:')
  const wt = new FakeWorktrees(path.join(root, 'worktrees'))
  const claude = new FakeClaude()
  const runs: { cmd: string; args: string[]; opts?: RunOpts | undefined }[] = []
  const scripted: [string, Partial<RunResult>][] = []
  const run: Run = async (cmd, args, opts) => {
    runs.push({ cmd, args, opts })
    const line = [cmd, ...args].join(' ')
    const hit = scripted.find(([prefix]) => line.startsWith(prefix))
    // Sidecar version queries answer like the default compose images unless a test scripts them.
    const defaults = line.includes('SHOW server_version') ? '16.4 (Debian 16.4-1)' : line.includes('INFO server') ? 'redis_version:7.2.4\r\n' : ''
    return { exitCode: 0, stdout: defaults, stderr: '', all: defaults, timedOut: false, ...(hit?.[1] ?? {}) }
  }
  const project = projectSchema.parse({
    displayName: 'Demo',
    install: ['pnpm', 'install', '--frozen-lockfile'],
    gates: [['pnpm', 'typecheck'], ['pnpm', 'test']],
    areas: ['core', 'ui'],
    allowedAuthors: ['martin'],
    testServices: { postgres: { version: '16' }, redis: { version: '7' } },
    ...o.project,
  })
  const digest = new DigestBatch()
  const deps: Deps = {
    env: testEnv(),
    project,
    branch: 'main',
    gh,
    wt,
    claude,
    run,
    db,
    log: silent,
    digest,
    paths: paths(root),
    now: () => o.now ?? new Date('2026-10-05T10:00:00Z'),
    botLogin: 'pez-bot[bot]',
    prompt: async (name, vars) => `[${name}] ${JSON.stringify(vars)}`,
    gate: o.gate ?? openGate,
    signal: new AbortController().signal,
  }
  return {
    gh, db, wt, claude, run, runs, deps, digest, root,
    /** Make subprocess calls whose command line starts with `prefix` return this. */
    script(prefix: string, r: Partial<RunResult>) {
      scripted.unshift([prefix, r])
    },
    commandLines: () => runs.map(r => [r.cmd, ...r.args].join(' ')),
  }
}

/** What the agent does in a proposal run: write the change folder. */
export function writeChange(dir: string, changeId: string) {
  const d = path.join(dir, 'openspec', 'changes', changeId)
  mkdirSync(d, { recursive: true })
  writeFileSync(path.join(d, 'proposal.md'), '## Why\nBecause.')
}

import type { Env } from '../config/env.js'
import type { ProjectConfig } from '../config/project.js'
import type { DigestBatch } from '../digest/digest.js'
import type { Claude } from '../exec/claude.js'
import type { Run } from '../exec/run.js'
import type { GitHub } from '../github/client.js'
import type { Logger } from '../log.js'
import type { Paths } from '../paths.js'
import type { PromptName } from '../prompts.js'
import type { DB } from '../state/db.js'
import type { Outcome } from '../state/jobs.js'

export type ClaudeJobKind = 'propose' | 'build' | 'triage' | 'migrate'

export type GateDecision = { ok: true; note?: string } | { ok: false; reason: string; until?: Date | null }

/** Budget and run-window rules for jobs that call Claude (M5). */
export interface Gate {
  check(kind: ClaudeJobKind, urgent: boolean): Promise<GateDecision>
  /** When a running job must be checkpointed (window end + grace), or null. */
  deadline(urgent: boolean): Date | null
}

export const openGate: Gate = { check: async () => ({ ok: true }), deadline: () => null }

/** Git worktree operations a job needs; faked in tests. */
export interface WorktreeOps {
  /** A new worktree on `branch`, reset to origin/<default>. */
  fresh(branch: string): Promise<string>
  /** Checks out origin/<branch> if it exists (a paused build), otherwise like fresh(). */
  resume(branch: string): Promise<{ dir: string; resumed: boolean }>
  /** Merges origin/<default> into the worktree; aborts and reports a conflict. */
  mergeDefault(dir: string): Promise<'ok' | 'conflict'>
  commitsAhead(dir: string): Promise<number>
  /** Commits uncommitted changes (only `paths` if given). Returns whether a commit was made. */
  commit(dir: string, message: string, paths?: string[]): Promise<boolean>
  push(dir: string, branch: string): Promise<void>
  remove(dir: string): Promise<void>
  /** Worktree directories on disk. */
  list(): Promise<string[]>
  localBranches(): Promise<string[]>
  /** Branch names on origin (without the `origin/` prefix). */
  remoteBranches(): Promise<string[]>
  deleteLocalBranch(branch: string): Promise<void>
  deleteRemoteBranch(branch: string): Promise<void>
}

/** What every job gets, even without a valid project config (update, cleanup, setup). */
export interface SysDeps {
  env: Env
  branch: string
  gh: GitHub
  wt: WorktreeOps
  run: Run
  db: DB
  log: Logger
  digest: DigestBatch
  paths: Paths
  now: () => Date
  botLogin: string
  signal: AbortSignal
}

/** Project jobs: everything above plus the project config, Claude, prompts and the gate. */
export interface Deps extends SysDeps {
  project: ProjectConfig
  claude: Claude
  prompt(name: PromptName, vars: Record<string, string>): Promise<string>
  gate: Gate
}

export interface JobResult {
  outcome: Outcome
  detail?: string
  issue?: number
  /** Sub-kind recorded in job_runs (e.g. `build` for a work run), used for duration estimates. */
  kind?: string
  estCostUsd?: number
  turns?: number
  /** Worktree the job used; removed after the job unless `keepWorktree`. */
  worktree?: string
  keepWorktree?: boolean
}

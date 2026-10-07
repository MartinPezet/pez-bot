import { cleanup } from './cleanup.js'
import type { JobOptions } from './runner.js'
import { summary } from './summary.js'
import { sync } from './sync.js'
import { triage } from './triage.js'
import type { Deps, JobResult, SysDeps } from './types.js'
import { update } from './update.js'
import { work } from './work.js'

type RunOpts = { ignoreBudget: boolean }

export type JobDef =
  | { system?: false; fn: (d: Deps, o: RunOpts) => Promise<JobResult>; opts: JobOptions }
  | { system: true; fn: (d: SysDeps, o: RunOpts) => Promise<JobResult>; opts: JobOptions }

/** Every scheduled job, by CLI/cron name. */
export const JOBS = {
  sync: { fn: d => sync(d), opts: {} },
  work: { fn: (d, o) => work(d, o), opts: { claude: true } },
  summary: { fn: d => summary(d), opts: {} },
  triage: { fn: (d, o) => triage(d, o), opts: { claude: true } },
  update: { system: true, fn: d => update(d), opts: {} },
  cleanup: { system: true, fn: d => cleanup(d), opts: {} },
} satisfies Record<string, JobDef>

export type JobName = keyof typeof JOBS
export const isJobName = (s: string): s is JobName => s in JOBS

import { envSecrets, loadEnv, type Env } from './config/env.js'
import { run, type Run } from './exec/run.js'
import { createLogger, type Logger } from './log.js'
import { paths, type Paths } from './paths.js'
import { redactor } from './redact.js'
import type { ParseResult } from './result.js'

/** Everything a command needs. Built once per process. */
export interface Ctx {
  paths: Paths
  env: ParseResult<Env>
  log: Logger
  run: Run
}

export function createContext(): Ctx {
  redactor.add(...envSecrets())
  const p = paths()
  const env = loadEnv()
  const level = env.ok ? env.value.LOG_LEVEL : 'info'
  return { paths: p, env, log: createLogger({ level, logDir: p.logs }), run }
}

/** Time zone used for display and window maths. */
export const displayTz = (env: ParseResult<Env>) => (env.ok ? env.value.TZ : (process.env.TZ ?? 'UTC'))

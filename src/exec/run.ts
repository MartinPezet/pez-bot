import { execa } from 'execa'

/**
 * Every subprocess goes through here. `as: 'agent'` runs the command as the unprivileged
 * `agent` user via sudo with a wiped environment (`env -i`), so Claude and agent-written
 * code (installs, gates) only ever see the variables passed in `env`.
 */

export type RunAs = 'runner' | 'agent'

export interface RunOpts {
  cwd?: string
  env?: Record<string, string>
  input?: string
  timeoutMs?: number
  as?: RunAs
  signal?: AbortSignal
}

export interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
  all: string
  timedOut: boolean
}

export type Run = (cmd: string, args: string[], opts?: RunOpts) => Promise<RunResult>

export const AGENT_HOME = '/home/agent'
export const AGENT_PATH = `${AGENT_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`

export function agentArgv(cmd: string, args: string[], env: Record<string, string>): [string, string[]] {
  const base: Record<string, string> = { PATH: AGENT_PATH, HOME: AGENT_HOME, LANG: 'C.UTF-8', TZ: process.env.TZ ?? 'UTC' }
  const pairs = Object.entries({ ...base, ...env }).map(([k, v]) => `${k}=${v}`)
  return ['sudo', ['-n', '-u', 'agent', '-H', '--', '/usr/bin/env', '-i', ...pairs, cmd, ...args]]
}

/** AGENT_SUDO=0 runs "agent" commands as the current user (local development only, no isolation). */
export const run: Run = async (cmd, args, opts = {}) => {
  const asAgent = opts.as === 'agent' && process.env.AGENT_SUDO !== '0'
  const [c, a] = asAgent ? agentArgv(cmd, args, opts.env ?? {}) : [cmd, args]
  const r = await execa(c, a, {
    cwd: opts.cwd,
    input: opts.input,
    timeout: opts.timeoutMs,
    cancelSignal: opts.signal,
    env: asAgent ? {} : opts.env,
    extendEnv: !asAgent,
    reject: false,
    all: true,
    stripFinalNewline: true,
  })
  return {
    exitCode: r.exitCode ?? -1,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
    all: String(r.all ?? ''),
    timedOut: r.timedOut,
  }
}

export const tail = (s: string, n: number) => s.split('\n').slice(-n).join('\n')

export async function must(runFn: Run, cmd: string, args: string[], opts?: RunOpts): Promise<string> {
  const r = await runFn(cmd, args, opts)
  if (r.exitCode !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.exitCode}):\n${tail(r.all, 40)}`)
  return r.stdout
}

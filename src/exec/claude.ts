import { execa, type ResultPromise } from 'execa'
import type { Logger } from '../log.js'
import { parseRateLimitEvent, type Reading } from '../usage/passive.js'
import { agentArgv } from './run.js'

/**
 * Headless Claude Code, always as the `agent` user with `--output-format stream-json --verbose`
 * so rate-limit readings arrive while the job runs. The runner stops the run gracefully
 * (SIGINT, then SIGTERM, then SIGKILL) on a rejected rate limit, a window deadline, a timeout
 * or shutdown, and reports why.
 */

export type StopReason = 'completed' | 'rate_limited' | 'deadline' | 'timeout' | 'aborted' | 'crashed'

export interface ClaudeRequest {
  prompt: string
  cwd: string
  model: string
  maxTurns: number
  timeoutMs: number
  allowedTools: string[]
  permissionMode: string
  /** Agent env: Claude auth plus test service URLs. Nothing else. */
  env: Record<string, string>
  jsonSchema?: object
  deadline?: Date | null
  signal?: AbortSignal
}

export interface ClaudeResult {
  ok: boolean
  text: string
  structured?: unknown
  turns?: number
  costUsd?: number
  stopReason: StopReason
  readings: Reading[]
  /** Reset time of the bucket that rejected us, when rate limited. */
  resetsAt?: Date | null
  error?: string
}

export interface Claude {
  run(req: ClaudeRequest): Promise<ClaudeResult>
}

export function claudeArgs(req: ClaudeRequest): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', req.model,
    '--max-turns', String(req.maxTurns),
    '--permission-mode', req.permissionMode,
    '--permission-prompts', 'none',
    // Never load a target repo's own hooks or MCP servers in an unattended run.
    '--setting-sources', 'user',
    '--strict-mcp-config',
    '--no-session-persistence',
  ]
  if (req.jsonSchema) args.push('--json-schema', JSON.stringify(req.jsonSchema))
  args.push('--allowedTools', ...req.allowedTools)
  return args
}

/** Accumulates stream-json lines. Pure, so it can be tested on fixtures. */
export class StreamState {
  readings: Reading[] = []
  result: Record<string, unknown> | undefined
  lastAssistantError: string | undefined

  /** Returns readings found on this line (so the caller can react to a rejection immediately). */
  push(line: string, now = new Date()): Reading[] {
    const t = line.trim()
    if (!t.startsWith('{')) return []
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(t) as Record<string, unknown>
    } catch {
      return []
    }
    if (msg.type === 'rate_limit_event') {
      const r = parseRateLimitEvent(msg, now)
      this.readings.push(...r)
      return r
    }
    if (msg.type === 'result') this.result = msg
    if (msg.type === 'assistant' && typeof msg.error === 'string') this.lastAssistantError = msg.error
    return []
  }

  finish(stopReason: StopReason): ClaudeResult {
    const r = this.result
    const rejected = this.readings.find(x => x.status === 'rejected')
    const text = typeof r?.result === 'string' ? r.result : ''
    const isError = r ? r.is_error === true : true
    const reason: StopReason = stopReason === 'completed' && !r ? 'crashed' : stopReason
    return {
      ok: reason === 'completed' && !isError,
      text,
      structured: r?.structured_output,
      turns: typeof r?.num_turns === 'number' ? r.num_turns : undefined,
      costUsd: typeof r?.total_cost_usd === 'number' ? r.total_cost_usd : undefined,
      stopReason: reason,
      readings: this.readings,
      resetsAt: rejected?.resetsAt ?? null,
      error: isError ? (this.lastAssistantError ?? (typeof r?.subtype === 'string' ? r.subtype : 'no result')) : undefined,
    }
  }
}

const GRACE_MS = 30_000

export class ClaudeCli implements Claude {
  constructor(
    private readonly log: Logger,
    private readonly onReadings: (r: Reading[]) => void = () => {},
    private readonly bin = 'claude',
  ) {}

  async run(req: ClaudeRequest): Promise<ClaudeResult> {
    const useSudo = process.env.AGENT_SUDO !== '0'
    const [cmd, args] = useSudo ? agentArgv(this.bin, claudeArgs(req), req.env) : [this.bin, claudeArgs(req)]
    const sub: ResultPromise = execa(cmd, args, {
      cwd: req.cwd,
      input: req.prompt,
      reject: false,
      env: useSudo ? {} : req.env,
      extendEnv: !useSudo,
      stderr: 'pipe',
    })
    const state = new StreamState()
    let stopReason: StopReason = 'completed'
    const timers: NodeJS.Timeout[] = []
    const stop = (why: StopReason) => {
      if (stopReason !== 'completed') return
      stopReason = why
      this.log.warn({ why }, 'stopping claude')
      sub.kill('SIGINT')
      timers.push(setTimeout(() => sub.kill('SIGTERM'), GRACE_MS))
      timers.push(setTimeout(() => sub.kill('SIGKILL'), 2 * GRACE_MS))
    }
    timers.push(setTimeout(() => stop('timeout'), req.timeoutMs))
    if (req.deadline) timers.push(setTimeout(() => stop('deadline'), Math.max(0, req.deadline.getTime() - Date.now())))
    const onAbort = () => stop('aborted')
    req.signal?.addEventListener('abort', onAbort, { once: true })
    if (req.signal?.aborted) stop('aborted')

    try {
      for await (const line of sub) {
        const readings = state.push(String(line))
        if (readings.length) {
          this.onReadings(readings)
          if (readings.some(r => r.status === 'rejected')) stop('rate_limited')
        }
      }
      const done = await sub
      if (done.exitCode !== 0 && !state.result) this.log.error({ exit: done.exitCode, stderr: String(done.stderr).slice(-2000) }, 'claude exited without a result')
    } finally {
      for (const t of timers) clearTimeout(t)
      req.signal?.removeEventListener('abort', onAbort)
    }
    const res = state.finish(stopReason)
    this.log.info({ stop: res.stopReason, turns: res.turns, estCostUsd: res.costUsd, error: res.error }, 'claude finished')
    return res
  }
}

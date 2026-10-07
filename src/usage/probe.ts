import type { Claude } from '../exec/claude.js'
import type { Probe } from './gauge.js'

/**
 * Active usage probe: a one-turn Haiku call (one tiny request) whose stream carries a
 * rate_limit_event. That often has only a status, with a utilization figure only near a
 * threshold; the gate treats a missing figure as unknown.
 *
 * `claude -p "/usage"` was tried first and dropped: headless, it prints only the session's
 * cost and token totals, never the plan's 5-hour or weekly percentages.
 */
export function haikuProbe(claude: Claude, env: () => Record<string, string>, now = () => new Date()): Probe {
  return {
    name: 'haiku',
    async run() {
      const res = await claude.run({
        prompt: 'Reply with exactly: OK',
        cwd: '/tmp',
        model: 'haiku',
        maxTurns: 1,
        timeoutMs: 120_000,
        allowedTools: [],
        permissionMode: 'dontAsk',
        env: env(),
      })
      if (res.stopReason === 'crashed') throw new Error(`haiku probe failed: ${res.error ?? 'no result'}`)
      return res.readings.map(r => ({ ...r, source: 'haiku-probe', at: now() }))
    },
  }
}

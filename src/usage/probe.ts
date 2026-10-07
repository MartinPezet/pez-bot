import type { Claude } from '../exec/claude.js'
import type { Run } from '../exec/run.js'
import type { Probe } from './gauge.js'
import type { Reading } from './passive.js'

/**
 * Active usage probes, best first:
 * 1. `claude -p "/usage"`: a local command (no model call) whose output includes plan usage.
 *    The output is human-readable text, so this scrapes percentages next to "session" (5-hour)
 *    and "week" (weekly, all models) labels. If the wording changes, it fails loudly and the
 *    next probe takes over.
 * 2. A one-turn Haiku call: costs one tiny request; yields whatever rate_limit_event reports
 *    (often a status without a percentage).
 */

const PCT = /(\d{1,3}(?:\.\d+)?)\s*%/
const FIVE = /\b(session|5[- ]?h(ou)?r?|five[- ]hour)\b/i
const WEEK = /\b(week|weekly|7[- ]?d(ay)?|seven[- ]day)\b/i
const MODEL_SPECIFIC = /\b(opus|sonnet|haiku|fable)\b/i

export function parseUsageText(text: string, at: Date): Reading[] {
  const found = new Map<string, number>()
  let label: string | null = null
  for (const line of text.split(/\r?\n/)) {
    if (FIVE.test(line)) label = 'five_hour'
    else if (WEEK.test(line)) label = MODEL_SPECIFIC.test(line) ? null : 'seven_day'
    const m = line.match(PCT)
    if (m && label && !found.has(label)) {
      found.set(label, Math.min(Number(m[1]) / 100, 1))
      label = null
    }
  }
  return [...found].map(([bucket, utilization]) => ({ bucket, utilization, status: null, resetsAt: null, source: 'usage-cmd', at }))
}

export function usageCommandProbe(run: Run, env: () => Record<string, string>, now = () => new Date()): Probe {
  return {
    name: '/usage',
    async run() {
      const r = await run(
        'claude',
        ['-p', '/usage', '--output-format', 'json', '--setting-sources', 'user', '--strict-mcp-config', '--no-session-persistence'],
        { as: 'agent', env: env(), timeoutMs: 60_000, cwd: '/tmp' },
      )
      let text = r.stdout
      try {
        const j = JSON.parse(r.stdout) as { result?: string; is_error?: boolean }
        if (j.is_error) throw new Error(`claude reported an error: ${String(j.result).slice(0, 200)}`)
        text = j.result ?? ''
      } catch (e) {
        if (e instanceof SyntaxError) throw new Error(`unexpected output (exit ${r.exitCode}): ${r.all.slice(0, 200)}`)
        throw e
      }
      const readings = parseUsageText(text, now())
      if (!readings.length) throw new Error(`no session/weekly percentages found in /usage output: ${JSON.stringify(text.slice(0, 200))}`)
      return readings
    },
  }
}

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

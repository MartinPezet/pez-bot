import { describe, expect, it } from 'vitest'
import { claudeArgs, StreamState } from '../src/exec/claude.js'
import { stopSignal } from '../src/jobs/common.js'
import { normReset, normUtilization, parseRateLimitEvent } from '../src/usage/passive.js'

const at = new Date('2026-10-05T10:00:00Z')

describe('rate_limit_event parsing', () => {
  it('reads the documented shape, with no utilization', () => {
    const r = parseRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1790304000 } }, at)
    expect(r).toEqual([{ bucket: 'unspecified', utilization: null, status: 'allowed', resetsAt: new Date(1790304000 * 1000), source: 'stream', at }])
  })

  it('reads the observed shape with rateLimitType and unifiedWindows', () => {
    const r = parseRateLimitEvent(
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed_warning',
          resetsAt: 1790304000,
          rateLimitType: 'five_hour',
          utilization: 0.96,
          surpassedThreshold: 0.9,
          unifiedWindows: { five_hour: { utilization: 0.96, resetsAt: 1790304000 }, seven_day: { utilization: 0.92 } },
        },
      },
      at,
    )
    expect(r.map(x => [x.bucket, x.utilization, x.status])).toEqual([
      ['five_hour', 0.96, 'allowed_warning'],
      ['seven_day', 0.92, null],
    ])
  })

  it('fills the primary utilization from its window when the top level lacks it', () => {
    const r = parseRateLimitEvent(
      { rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', unifiedWindows: { seven_day: { utilization: 1, resetsAt: '2026-10-08T00:00:00Z' } } } },
      at,
    )
    expect(r[0]).toMatchObject({ bucket: 'seven_day', utilization: 1, status: 'rejected', resetsAt: new Date('2026-10-08T00:00:00Z') })
  })

  it('normalises percentages, millisecond and ISO resets, and ignores junk', () => {
    expect(normUtilization(42)).toBe(0.42)
    expect(normUtilization(0.42)).toBe(0.42)
    expect(normUtilization(-1)).toBeNull()
    expect(normUtilization('50')).toBeNull()
    expect(normReset(1790304000000)?.getTime()).toBe(1790304000000)
    expect(normReset('nope')).toBeNull()
    expect(parseRateLimitEvent('garbage', at)).toEqual([])
    expect(parseRateLimitEvent({ rate_limit_info: { status: 'weird' } }, at)[0]?.status).toBeNull()
  })
})

describe('stream-json accumulation', () => {
  const lines = [
    '{"type":"system","subtype":"init","model":"claude-sonnet"}',
    'not json',
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}',
    '{"type":"assistant","message":{"content":[]}}',
    '{"type":"result","subtype":"success","is_error":false,"num_turns":12,"total_cost_usd":1.25,"result":"Done.\\nBLOCKED: need a decision"}',
  ]

  it('takes the final result from the result message', () => {
    const s = new StreamState()
    for (const l of lines) s.push(l, at)
    const r = s.finish('completed')
    expect(r).toMatchObject({ ok: true, text: 'Done.\nBLOCKED: need a decision', turns: 12, costUsd: 1.25, stopReason: 'completed' })
    expect(r.readings).toHaveLength(1)
  })

  it('returns rejected readings immediately so the run can be stopped', () => {
    const s = new StreamState()
    const r = s.push('{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1790304000,"rateLimitType":"five_hour"}}', at)
    expect(r[0]?.status).toBe('rejected')
    const res = s.finish('rate_limited')
    expect(res.ok).toBe(false)
    expect(res.resetsAt).toEqual(new Date(1790304000 * 1000))
  })

  it('reports a crash when the stream ends without a result', () => {
    const r = new StreamState().finish('completed')
    expect(r.stopReason).toBe('crashed')
    expect(r.ok).toBe(false)
  })

  it('surfaces auth failures from the assistant message', () => {
    const s = new StreamState()
    s.push('{"type":"assistant","error":"authentication_failed","message":{"content":[]}}')
    s.push('{"type":"result","subtype":"success","is_error":true,"result":"Not logged in"}')
    expect(s.finish('completed')).toMatchObject({ ok: false, error: 'authentication_failed' })
  })
})

describe('claude arguments', () => {
  it('runs headless with stream-json, isolated settings and the allowlist last', () => {
    const args = claudeArgs({
      prompt: 'p', cwd: '/w', model: 'sonnet', maxTurns: 150, timeoutMs: 1, allowedTools: ['Read', 'Bash(pnpm *)'],
      permissionMode: 'acceptEdits', env: {}, jsonSchema: { type: 'object' },
    })
    expect(args.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose'])
    expect(args).toContain('--strict-mcp-config')
    expect(args.join(' ')).toContain('--setting-sources user')
    expect(args.join(' ')).toContain('--json-schema {"type":"object"}')
    expect(args.slice(-3)).toEqual(['--allowedTools', 'Read', 'Bash(pnpm *)'])
  })
})

describe('stop signals', () => {
  it('finds the last signal line and everything after it', () => {
    expect(stopSignal('All done.')).toBeNull()
    expect(stopSignal('Summary\nNEEDS_DECISION: 1. Which unit?\n2. Rounding?')).toEqual({
      kind: 'NEEDS_DECISION',
      detail: '1. Which unit?\n2. Rounding?',
    })
    expect(stopSignal('I must not say BLOCKED: here mid-line.')).toBeNull()
    expect(stopSignal('Protocol: end with `BLOCKED:`\nBLOCKED: real reason')?.detail).toBe('real reason')
    expect(stopSignal('NEEDS_SPLIT: a\nlater text\nBLOCKED: last one wins')?.kind).toBe('BLOCKED')
  })
})

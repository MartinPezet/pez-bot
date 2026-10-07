import { describe, expect, it } from 'vitest'
import type { Run } from '../src/exec/run.js'
import { components, PAUSE_KEY, parseVersion, update, type Component } from '../src/jobs/update.js'
import { kv } from '../src/state/db.js'
import { harness } from './jobs-harness.js'

function fake(o: { versions: (string | null)[]; smoke?: boolean; updateFails?: boolean }) {
  const calls: string[] = []
  let i = 0
  const c: Component = {
    key: 'claude-code',
    name: 'Claude Code',
    current: async () => o.versions[Math.min(i++, o.versions.length - 1)] ?? null,
    update: async () => {
      calls.push('update')
      if (o.updateFails) throw new Error('network down')
    },
    smoke: async () => ({ ok: o.smoke ?? true, detail: o.smoke === false ? 'expected token, got nothing' : 'ok' }),
    rollback: async prev => {
      calls.push(`rollback ${prev}`)
    },
  }
  return { c, calls }
}
const updates = (h: ReturnType<typeof harness>) =>
  h.db.prepare('SELECT component, from_version, to_version, outcome FROM updates ORDER BY id').all()

describe('update', () => {
  it('posts nothing when the version did not change', async () => {
    const h = harness()
    const { c } = fake({ versions: ['2.1.280', '2.1.280'] })
    expect(await update(h.deps, [c])).toMatchObject({ outcome: 'noop' })
    expect(h.digest.empty).toBe(true)
    expect(updates(h)).toEqual([])
  })

  it('records and announces a successful update', async () => {
    const h = harness()
    const { c } = fake({ versions: ['2.1.280', '2.1.285'] })
    expect((await update(h.deps, [c])).outcome).toBe('ok')
    expect(updates(h)).toEqual([{ component: 'claude-code', from_version: '2.1.280', to_version: '2.1.285', outcome: 'updated' }])
    expect(h.digest.events[0]?.text).toBe('Claude Code updated 2.1.280 → 2.1.285')
  })

  it('rolls back a failed smoke test and pauses updates for 7 days', async () => {
    const h = harness()
    const { c, calls } = fake({ versions: ['2.1.280', '2.1.285'], smoke: false })
    expect((await update(h.deps, [c])).outcome).toBe('ok')
    expect(calls).toEqual(['update', 'rollback 2.1.280'])
    expect(kv.get(h.db, PAUSE_KEY)).toBe('2026-10-12T10:00:00.000Z')
    expect(updates(h)).toEqual([{ component: 'claude-code', from_version: '2.1.280', to_version: '2.1.285', outcome: 'rolled_back' }])
    expect(h.digest.events[0]?.emoji).toBe('↩️')
    expect(h.digest.events[0]?.text).toContain('rolled back to 2.1.280')
  })

  it('does nothing while paused, and resumes once the pause is cleared', async () => {
    const h = harness()
    kv.set(h.db, PAUSE_KEY, '2026-10-12T10:00:00.000Z')
    const { c, calls } = fake({ versions: ['1', '2'] })
    expect(await update(h.deps, [c])).toMatchObject({ outcome: 'noop', detail: expect.stringContaining('paused') })
    expect(calls).toEqual([])
    kv.del(h.db, PAUSE_KEY)
    await update(h.deps, [c])
    expect(calls).toEqual(['update'])
  })

  it('reports an update command failure as an error without rolling back', async () => {
    const h = harness()
    const { c, calls } = fake({ versions: ['2.1.280'], updateFails: true })
    expect((await update(h.deps, [c])).outcome).toBe('error')
    expect(calls).toEqual(['update'])
    expect(updates(h)).toEqual([{ component: 'claude-code', from_version: '2.1.280', to_version: null, outcome: 'failed' }])
  })
})

describe('real components', () => {
  it('installs the configured channel, smoke-tests with a nonce, and rolls back by version', async () => {
    const h = harness()
    const lines: string[] = []
    let version = '2.1.280'
    let echo = true
    const run: Run = async (cmd, args, opts) => {
      lines.push(`${opts?.as ?? 'runner'}: ${[cmd, ...args].join(' ')}`)
      const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', all: stdout, timedOut: false })
      if (args[0] === '--version') return ok(`${version} (Claude Code)`)
      if (args[0] === 'install') {
        version = args[1] === 'stable' ? '2.1.285' : (args[1] ?? version)
        return ok()
      }
      if (args[0] === '-p') {
        const token = args[1]?.split(': ')[1] ?? ''
        return ok(JSON.stringify({ result: echo ? token : 'nope' }))
      }
      return ok()
    }
    const d = { ...h.deps, run }
    const [claude] = components(d)
    expect(await update(d, [claude!])).toMatchObject({ outcome: 'ok' })
    expect(lines).toContain('agent: claude install stable')
    expect(lines.some(l => /^agent: claude -p Reply with exactly this token and nothing else: PEZBOT-\w{8} --model haiku --max-turns 1/.test(l))).toBe(true)

    echo = false
    version = '2.1.285'
    const [again] = components(d)
    again!.update = async () => {
      version = '2.1.290'
    }
    await update(d, [again!])
    expect(lines.at(-1)).toBe('agent: claude install 2.1.285')
    expect(version).toBe('2.1.285')
  })

  it('includes Superpowers only when INSTALL_SUPERPOWERS is on', () => {
    const h = harness()
    expect(components(h.deps).map(c => c.key)).toEqual(['claude-code', 'openspec'])
    expect(components({ ...h.deps, env: { ...h.deps.env, INSTALL_SUPERPOWERS: true } }).map(c => c.key)).toContain('superpowers')
  })

  it('parses versions from tool output', () => {
    expect(parseVersion('2.1.285 (Claude Code)')).toBe('2.1.285')
    expect(parseVersion('1.14.0')).toBe('1.14.0')
    expect(parseVersion('command not found')).toBeNull()
  })
})

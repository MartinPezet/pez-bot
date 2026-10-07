import { randomUUID } from 'node:crypto'
import { kv } from '../state/db.js'
import { claudeAuthEnv } from './common.js'
import type { JobResult, SysDeps } from './types.js'

/**
 * Updates Claude Code, the OpenSpec CLI and (optionally) the Superpowers plugin in place on the
 * install volume. Claude Code's own background updater is off (DISABLE_AUTOUPDATER), so versions
 * only change here, never mid-job. Each change is smoke-tested; a failure rolls back and pauses
 * updates for 7 days (or until `updates resume`).
 */

export const PAUSE_DAYS = 7
export const PAUSE_KEY = 'updates.paused_until'

export interface Component {
  key: string
  name: string
  current(): Promise<string | null>
  update(): Promise<void>
  smoke(): Promise<{ ok: boolean; detail: string }>
  rollback(previous: string | null): Promise<void>
}

export type UpdateOutcome = 'unchanged' | 'updated' | 'rolled_back' | 'failed'

export const parseVersion = (s: string) => s.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/)?.[0] ?? null

function record(d: SysDeps, c: Component, from: string | null, to: string | null, outcome: UpdateOutcome, note = '') {
  d.db
    .prepare('INSERT INTO updates (at, component, from_version, to_version, outcome, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(d.now().toISOString(), c.key, from, to, outcome, note || null)
}

export async function updateComponent(d: SysDeps, c: Component): Promise<UpdateOutcome> {
  const before = await c.current()
  try {
    await c.update()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    d.log.error({ component: c.key, err: msg }, 'update failed')
    record(d, c, before, null, 'failed', msg.slice(0, 500))
    return 'failed'
  }
  const after = await c.current()
  if (after === before) return 'unchanged'

  const smoke = await c.smoke().catch((e: unknown) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }))
  if (smoke.ok) {
    record(d, c, before, after, 'updated')
    d.digest.add('⬆️', `${c.name} ${before ? `updated ${before} → ${after}` : `installed (${after})`}`)
    return 'updated'
  }
  await c.rollback(before)
  const until = new Date(d.now().getTime() + PAUSE_DAYS * 24 * 60 * 60_000)
  kv.set(d.db, PAUSE_KEY, until.toISOString())
  record(d, c, before, after, 'rolled_back', smoke.detail.slice(0, 500))
  d.digest.add(
    '↩️',
    `${c.name} ${after} failed its smoke test (${smoke.detail.slice(0, 120)}); rolled back to ${before ?? 'nothing'}. Updates paused until ${until.toISOString().slice(0, 10)} (\`pez-bot updates resume\` to clear).`,
  )
  return 'rolled_back'
}

const SUPERPOWERS = 'superpowers@claude-plugins-official'

export function components(d: SysDeps): Component[] {
  const asAgent = (cmd: string, args: string[], timeoutMs = 10 * 60_000) =>
    d.run(cmd, args, { as: 'agent', env: claudeAuthEnv(d.env), timeoutMs, cwd: '/tmp' })
  const must = async (cmd: string, args: string[]) => {
    const r = await asAgent(cmd, args)
    if (r.exitCode !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.exitCode}): ${r.all.slice(-500)}`)
    return r.stdout
  }
  const version = async (cmd: string) => {
    const r = await asAgent(cmd, ['--version'], 30_000)
    return r.exitCode === 0 ? parseVersion(r.stdout) : null
  }
  /** `claude --version` plus a one-turn headless call that must echo a nonce. */
  const claudeSmoke = async () => {
    if (!(await version('claude'))) return { ok: false, detail: 'claude --version failed' }
    const nonce = `PEZBOT-${randomUUID().slice(0, 8)}`
    const r = await asAgent(
      'claude',
      ['-p', `Reply with exactly this token and nothing else: ${nonce}`, '--model', 'haiku', '--max-turns', '1', '--output-format', 'json',
        '--setting-sources', 'user', '--strict-mcp-config', '--no-session-persistence'],
      180_000,
    )
    let result = ''
    try {
      result = String((JSON.parse(r.stdout) as { result?: unknown }).result ?? '')
    } catch {
      return { ok: false, detail: `headless call returned no JSON (exit ${r.exitCode})` }
    }
    return result.includes(nonce) ? { ok: true, detail: 'ok' } : { ok: false, detail: `expected ${nonce}, got ${JSON.stringify(result.slice(0, 80))}` }
  }

  const list: Component[] = [
    {
      key: 'claude-code',
      name: 'Claude Code',
      current: () => version('claude'),
      update: () => must('claude', ['install', d.env.CLAUDE_CHANNEL]).then(() => undefined),
      smoke: claudeSmoke,
      rollback: async prev => {
        if (prev) await must('claude', ['install', prev])
      },
    },
    {
      key: 'openspec',
      name: 'OpenSpec CLI',
      current: () => version('openspec'),
      update: () => must('npm', ['install', '-g', '@fission-ai/openspec@latest']).then(() => undefined),
      smoke: async () => {
        const h = await asAgent('openspec', ['--help'], 30_000)
        return (await version('openspec')) && h.exitCode === 0 ? { ok: true, detail: 'ok' } : { ok: false, detail: 'openspec --version/--help failed' }
      },
      rollback: async prev => {
        if (prev) await must('npm', ['install', '-g', `@fission-ai/openspec@${prev}`])
      },
    },
  ]
  if (d.env.INSTALL_SUPERPOWERS) {
    list.push({
      key: 'superpowers',
      name: 'Superpowers plugin',
      current: async () => {
        const r = await asAgent('claude', ['plugin', 'list', '--json'], 60_000)
        if (r.exitCode !== 0 || !r.stdout.includes('superpowers')) return null
        return r.stdout.match(/superpowers[\s\S]*?"version"\s*:\s*"([^"]+)"/)?.[1] ?? 'installed'
      },
      update: async () => {
        const installed = (await asAgent('claude', ['plugin', 'list', '--json'], 60_000)).stdout.includes('superpowers')
        if (installed) {
          await must('claude', ['plugin', 'update', SUPERPOWERS])
          return
        }
        const first = await asAgent('claude', ['plugin', 'install', SUPERPOWERS])
        if (first.exitCode === 0) return
        await must('claude', ['plugin', 'marketplace', 'add', 'anthropics/claude-plugins-official'])
        await must('claude', ['plugin', 'install', SUPERPOWERS])
      },
      smoke: claudeSmoke,
      // Plugins can't be pinned to a version, so a failed plugin update is uninstalled instead.
      rollback: async () => {
        await asAgent('claude', ['plugin', 'uninstall', SUPERPOWERS])
      },
    })
  }
  return list
}

export async function update(d: SysDeps, list: Component[] = components(d)): Promise<JobResult> {
  const paused = kv.get(d.db, PAUSE_KEY)
  if (paused && Date.parse(paused) > d.now().getTime()) return { outcome: 'noop', detail: `updates paused until ${paused}` }
  const results: string[] = []
  for (const c of list) results.push(`${c.key} ${await updateComponent(d, c)}`)
  const changed = results.some(r => /updated|rolled_back/.test(r))
  const failed = results.some(r => r.endsWith('failed'))
  return { outcome: failed ? 'error' : changed ? 'ok' : 'noop', detail: results.join(', ') }
}

import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import type { PullRequest } from '../github/client.js'
import { freeGb } from '../health.js'
import { kv } from '../state/db.js'
import type { JobResult, SysDeps } from './types.js'

const DAY = 24 * 60 * 60_000
const RUNNER_BRANCH = /^(proposal|change)\//
const latestFor = (prs: PullRequest[], branch: string) =>
  prs.filter(p => p.headRefName === branch).sort((a, b) => b.number - a.number)[0]

/** Local runner branches whose latest PR is merged or closed. */
export function selectLocalBranches(branches: string[], prs: PullRequest[]): string[] {
  return branches.filter(b => {
    if (!RUNNER_BRANCH.test(b)) return false
    const pr = latestFor(prs, b)
    return pr !== undefined && pr.state !== 'OPEN'
  })
}

/** Remote runner branches whose latest PR was closed without merging more than 7 days ago. */
export function selectRemoteBranches(branches: string[], prs: PullRequest[], now: Date): string[] {
  return branches.filter(b => {
    if (!RUNNER_BRANCH.test(b)) return false
    const pr = latestFor(prs, b)
    return pr?.state === 'CLOSED' && pr.closedAt !== null && now.getTime() - Date.parse(pr.closedAt) > 7 * DAY
  })
}

/** Worktrees to remove: everything, except blocked ones younger than keepDays (unless aggressive). */
export function selectWorktrees(dirs: string[], blocked: Map<string, string>, now: Date, keepDays: number, aggressive: boolean): string[] {
  return dirs.filter(dir => {
    const since = blocked.get(dir)
    return aggressive || !since || now.getTime() - Date.parse(since) >= keepDays * DAY
  })
}

/** Log files (`runner-YYYY-MM-DD.log`) older than the retention period. */
export function selectLogs(files: string[], now: Date, retentionDays: number): string[] {
  return files.filter(f => {
    const m = f.match(/^runner-(\d{4}-\d{2}-\d{2})\.log$/)
    return m !== null && now.getTime() - Date.parse(`${m[1]}T00:00:00Z`) > retentionDays * DAY
  })
}

/** Daily housekeeping. Posts nothing to the digest: only the disk guard does. */
export async function cleanup(d: SysDeps, o: { aggressive?: boolean } = {}): Promise<JobResult> {
  const now = d.now()
  const aggressive = o.aggressive ?? false
  const retention = aggressive ? 1 : d.env.RETENTION_DAYS
  const done: string[] = []

  const blocked = new Map(kv.keys(d.db, 'blocked-worktree.').map(k => [k.key.slice('blocked-worktree.'.length), kv.get(d.db, k.key) ?? k.updated_at]))
  const dirs = selectWorktrees(await d.wt.list(), blocked, now, d.env.KEEP_BLOCKED_WORKTREES_DAYS, aggressive)
  for (const dir of dirs) {
    await d.wt.remove(dir)
    kv.del(d.db, `blocked-worktree.${dir}`)
  }
  if (dirs.length) done.push(`${dirs.length} worktree(s)`)

  const prs = await d.gh.listPrs()
  const local = selectLocalBranches(await d.wt.localBranches(), prs)
  for (const b of local) await d.wt.deleteLocalBranch(b).catch(e => d.log.warn({ err: e, branch: b }, 'branch delete failed'))
  if (local.length) done.push(`${local.length} local branch(es)`)
  const remote = selectRemoteBranches(await d.wt.remoteBranches(), prs, now)
  for (const b of remote) await d.wt.deleteRemoteBranch(b).catch(e => d.log.warn({ err: e, branch: b }, 'remote branch delete failed'))
  if (remote.length) done.push(`${remote.length} remote branch(es)`)

  const lastPrune = kv.get(d.db, 'cleanup.pnpm_prune')
  if (aggressive || !lastPrune || now.getTime() - Date.parse(lastPrune) > 7 * DAY) {
    await d.run('pnpm', ['store', 'prune'], { as: 'agent', cwd: d.paths.data, env: { npm_config_store_dir: `${d.paths.data}/pnpm-store` }, timeoutMs: 30 * 60_000 })
    kv.set(d.db, 'cleanup.pnpm_prune', now.toISOString())
    done.push('pnpm store pruned')
  }

  // Session transcripts (normally not written: runs use --no-session-persistence) and old logs.
  await d.run('find', ['/home/agent/.claude/projects', '-type', 'f', '-name', '*.jsonl', '-mtime', `+${retention}`, '-delete'], { as: 'agent' })
  if (existsSync(d.paths.logs)) {
    const old = selectLogs(readdirSync(d.paths.logs), now, retention)
    for (const f of old) unlinkSync(path.join(d.paths.logs, f))
    if (old.length) done.push(`${old.length} log file(s)`)
  }

  const cutoff = new Date(now.getTime() - retention * DAY).toISOString()
  d.db.prepare('DELETE FROM usage_readings WHERE at < ?').run(cutoff)
  for (const k of kv.keys(d.db, 'digest.day.')) if (k.updated_at < cutoff) kv.del(d.db, k.key)
  d.db.exec('VACUUM')

  return { outcome: done.length ? 'ok' : 'noop', detail: done.join(', ') || 'nothing to clean' }
}

/**
 * Below MIN_FREE_DISK_GB: aggressive cleanup. Still low: flag it so Claude jobs are skipped
 * (the health check fails on disk too) and say so in the digest, once per occurrence.
 */
export async function diskGuard(d: SysDeps, free: () => number | null = () => freeGb(d.paths.data)): Promise<void> {
  const min = d.env.MIN_FREE_DISK_GB
  const before = free()
  if (before === null || before >= min) {
    if (kv.get(d.db, 'disk.low')) {
      kv.del(d.db, 'disk.low')
      d.log.info({ freeGb: before }, 'disk space recovered')
    }
    return
  }
  d.log.warn({ freeGb: before, min }, 'disk guard: low space, cleaning aggressively')
  await cleanup(d, { aggressive: true })
  const after = free() ?? 0
  if (after >= min) {
    kv.del(d.db, 'disk.low')
    d.digest.add('💾', `Disk guard triggered: ${before.toFixed(1)} GB free (min ${min}); aggressive cleanup freed it to ${after.toFixed(1)} GB`)
    return
  }
  if (!kv.get(d.db, 'disk.low')) {
    kv.set(d.db, 'disk.low', '1')
    d.digest.add('💾', `Disk guard: only ${after.toFixed(1)} GB free after aggressive cleanup (min ${min}). Claude jobs are skipped until space is freed.`)
  }
}

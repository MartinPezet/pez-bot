import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanup, diskGuard, selectLocalBranches, selectLogs, selectRemoteBranches, selectWorktrees } from '../src/jobs/cleanup.js'
import { kv } from '../src/state/db.js'
import { FakeGitHub } from './fakes.js'
import { harness } from './jobs-harness.js'

const now = new Date('2026-10-20T04:00:00Z')

describe('branch selection', () => {
  const g = new FakeGitHub()
  const prs = [
    g.addPr({ number: 1, headRefName: 'proposal/issue-1-a', state: 'MERGED', mergedAt: '2026-10-01T00:00:00Z' }),
    g.addPr({ number: 2, headRefName: 'proposal/issue-2-b', state: 'CLOSED', closedAt: '2026-10-01T00:00:00Z' }),
    g.addPr({ number: 3, headRefName: 'change/issue-3', state: 'CLOSED', closedAt: '2026-10-18T00:00:00Z' }),
    g.addPr({ number: 4, headRefName: 'change/issue-4', state: 'OPEN' }),
    g.addPr({ number: 5, headRefName: 'change/issue-5', state: 'CLOSED', closedAt: '2026-10-01T00:00:00Z' }),
    g.addPr({ number: 6, headRefName: 'change/issue-5', state: 'OPEN' }),
    g.addPr({ number: 7, headRefName: 'feature/human', state: 'CLOSED', closedAt: '2026-01-01T00:00:00Z' }),
  ]

  it('deletes local runner branches whose latest PR is merged or closed', () => {
    const local = ['main', 'proposal/issue-1-a', 'proposal/issue-2-b', 'change/issue-3', 'change/issue-4', 'change/issue-5', 'change/issue-9', 'feature/human']
    expect(selectLocalBranches(local, prs)).toEqual(['proposal/issue-1-a', 'proposal/issue-2-b', 'change/issue-3'])
  })

  it('deletes remote runner branches only when closed without merging for over 7 days', () => {
    const remote = ['main', 'proposal/issue-1-a', 'proposal/issue-2-b', 'change/issue-3', 'change/issue-4', 'change/issue-5', 'feature/human']
    expect(selectRemoteBranches(remote, prs, now)).toEqual(['proposal/issue-2-b'])
  })
})

describe('worktree and log selection', () => {
  it('keeps blocked worktrees for KEEP_BLOCKED_WORKTREES_DAYS unless aggressive', () => {
    const blocked = new Map([
      ['/w/young', '2026-10-19T00:00:00Z'],
      ['/w/old', '2026-10-10T00:00:00Z'],
    ])
    const dirs = ['/w/young', '/w/old', '/w/stray']
    expect(selectWorktrees(dirs, blocked, now, 3, false)).toEqual(['/w/old', '/w/stray'])
    expect(selectWorktrees(dirs, blocked, now, 3, true)).toEqual(dirs)
  })

  it('selects daily log files older than the retention period', () => {
    const files = ['runner-2026-10-01.log', 'runner-2026-10-19.log', 'other.txt']
    expect(selectLogs(files, now, 14)).toEqual(['runner-2026-10-01.log'])
  })
})

describe('cleanup job', () => {
  it('removes worktrees, branches, old logs and readings; prunes the pnpm store weekly', async () => {
    const h = harness({ now })
    const stray = path.join(h.root, 'worktrees', 'triage__readonly')
    h.wt.extraDirs.push(stray)
    h.wt.local = ['main', 'proposal/issue-2-b']
    h.wt.remote = new Set(['proposal/issue-2-b'])
    h.gh.addPr({ number: 2, headRefName: 'proposal/issue-2-b', state: 'CLOSED', closedAt: '2026-10-01T00:00:00Z' })
    mkdirSync(h.deps.paths.logs, { recursive: true })
    writeFileSync(path.join(h.deps.paths.logs, 'runner-2026-09-01.log'), 'x')
    writeFileSync(path.join(h.deps.paths.logs, 'runner-2026-10-19.log'), 'x')
    h.db.prepare("INSERT INTO usage_readings (at, bucket, source) VALUES ('2026-09-01T00:00:00Z', 'five_hour', 't')").run()

    const r = await cleanup(h.deps)
    expect(r.outcome).toBe('ok')
    expect(h.wt.removed).toEqual([stray])
    expect(h.wt.deletedLocal).toEqual(['proposal/issue-2-b'])
    expect(h.wt.deletedRemote).toEqual(['proposal/issue-2-b'])
    expect(existsSync(path.join(h.deps.paths.logs, 'runner-2026-09-01.log'))).toBe(false)
    expect(existsSync(path.join(h.deps.paths.logs, 'runner-2026-10-19.log'))).toBe(true)
    expect(h.db.prepare('SELECT COUNT(*) n FROM usage_readings').get()).toEqual({ n: 0 })
    expect(h.commandLines().filter(l => l === 'pnpm store prune')).toHaveLength(1)
    expect(h.digest.empty).toBe(true)

    await cleanup(h.deps)
    expect(h.commandLines().filter(l => l === 'pnpm store prune')).toHaveLength(1)
  })

  it('posts nothing and reports noop when there is nothing to clean', async () => {
    const h = harness({ now })
    kv.set(h.db, 'cleanup.pnpm_prune', now.toISOString())
    expect((await cleanup(h.deps)).outcome).toBe('noop')
  })
})

describe('disk guard', () => {
  it('does nothing above the threshold', async () => {
    const h = harness({ now })
    await diskGuard(h.deps, () => 50)
    expect(h.digest.empty).toBe(true)
    expect(h.wt.removed).toEqual([])
  })

  it('cleans aggressively (blocked worktrees too) and reports when that frees enough', async () => {
    const h = harness({ now })
    const blocked = path.join(h.root, 'worktrees', 'change__issue-1')
    h.wt.extraDirs.push(blocked)
    kv.set(h.db, `blocked-worktree.${blocked}`, now.toISOString())
    const readings = [5, 20]
    await diskGuard(h.deps, () => readings.shift() ?? 20)
    expect(h.wt.removed).toEqual([blocked])
    expect(h.digest.events[0]?.text).toBe('Disk guard triggered: 5.0 GB free (min 10); aggressive cleanup freed it to 20.0 GB')
    expect(kv.get(h.db, 'disk.low')).toBeUndefined()
  })

  it('flags low disk once when cleanup is not enough, and clears it when space returns', async () => {
    const h = harness({ now })
    await diskGuard(h.deps, () => 3)
    await diskGuard(h.deps, () => 3)
    expect(kv.get(h.db, 'disk.low')).toBe('1')
    expect(h.digest.events.map(e => e.emoji)).toEqual(['💾'])
    await diskGuard(h.deps, () => 30)
    expect(kv.get(h.db, 'disk.low')).toBeUndefined()
  })
})

import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { Git } from '../exec/git.js'
import type { Run } from '../exec/run.js'
import type { Logger } from '../log.js'
import type { WorktreeOps } from './types.js'

export const worktreeDir = (root: string, branch: string) => path.join(root, branch.replaceAll('/', '__'))

/**
 * Real worktree operations, as the runner user. Commits carry the bot identity from Git.
 * In dry run, pushes and remote branch deletions are logged instead of performed.
 */
export class GitWorktrees implements WorktreeOps {
  constructor(
    private readonly git: Git,
    private readonly root: string,
    private readonly defaultBranch: () => string,
    private readonly run: Run,
    private readonly dryRun = false,
    private readonly log?: Logger,
  ) {}

  private async add(branch: string, from: string): Promise<string> {
    const dir = worktreeDir(this.root, branch)
    if (existsSync(dir)) await this.remove(dir)
    await this.git.git(['worktree', 'prune'])
    await this.git.git(['worktree', 'add', '--force', '-B', branch, dir, from])
    return dir
  }

  fresh(branch: string): Promise<string> {
    return this.add(branch, `origin/${this.defaultBranch()}`)
  }

  async resume(branch: string): Promise<{ dir: string; resumed: boolean }> {
    const remote = await this.git.git(['ls-remote', '--heads', 'origin', branch], { auth: true })
    if (!remote.trim()) return { dir: await this.fresh(branch), resumed: false }
    await this.git.git(['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { auth: true })
    return { dir: await this.add(branch, `origin/${branch}`), resumed: true }
  }

  async mergeDefault(dir: string): Promise<'ok' | 'conflict'> {
    try {
      await this.git.git(['merge', '--no-edit', `origin/${this.defaultBranch()}`], { cwd: dir })
      return 'ok'
    } catch {
      await this.git.git(['merge', '--abort'], { cwd: dir }).catch(() => undefined)
      return 'conflict'
    }
  }

  async commitsAhead(dir: string): Promise<number> {
    return Number((await this.git.git(['rev-list', '--count', `origin/${this.defaultBranch()}..HEAD`], { cwd: dir })).trim())
  }

  async commit(dir: string, message: string, paths?: string[]): Promise<boolean> {
    const status = await this.git.git(['status', '--porcelain', ...(paths ? ['--', ...paths] : [])], { cwd: dir })
    if (!status.trim()) return false
    await this.git.git(['add', '-A', ...(paths ? ['--', ...paths] : [])], { cwd: dir })
    await this.git.git(['commit', '-m', message], { cwd: dir })
    return true
  }

  async push(dir: string, branch: string): Promise<void> {
    if (this.dryRun) {
      this.log?.info({ branch }, 'dry-run: would push branch')
      return
    }
    await this.git.git(['push', '--force-with-lease', '-u', 'origin', branch], { cwd: dir, auth: true })
  }

  /** git first; then rm as the agent (who owns most files in a worktree), then as runner. */
  async remove(dir: string): Promise<void> {
    await this.git.git(['worktree', 'remove', '--force', dir]).catch(() => undefined)
    if (existsSync(dir)) await this.run('rm', ['-rf', dir], { as: 'agent' })
    if (existsSync(dir)) await this.run('rm', ['-rf', dir])
    await this.git.git(['worktree', 'prune']).catch(() => undefined)
  }

  async list(): Promise<string[]> {
    return existsSync(this.root) ? readdirSync(this.root).map(d => path.join(this.root, d)) : []
  }

  async localBranches(): Promise<string[]> {
    return (await this.git.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])).split('\n').filter(Boolean)
  }

  async remoteBranches(): Promise<string[]> {
    await this.git.git(['fetch', '--quiet', '--prune', 'origin'], { auth: true })
    return (await this.git.git(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/']))
      .split('\n')
      .filter(b => b && b !== 'origin/HEAD' && b !== 'origin')
      .map(b => b.replace(/^origin\//, ''))
  }

  async deleteLocalBranch(branch: string): Promise<void> {
    await this.git.git(['branch', '-D', branch])
  }

  async deleteRemoteBranch(branch: string): Promise<void> {
    if (this.dryRun) {
      this.log?.info({ branch }, 'dry-run: would delete remote branch')
      return
    }
    await this.git.git(['push', 'origin', '--delete', branch], { auth: true })
  }
}

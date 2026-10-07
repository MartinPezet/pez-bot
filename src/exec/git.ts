import { existsSync } from 'node:fs'
import path from 'node:path'
import { must, type Run } from './run.js'

/**
 * The runner's own git, authenticated per call through GIT_ASKPASS. The token lives only
 * in this process and its git children (uid runner); nothing is written to disk.
 */
export class Git {
  constructor(
    private readonly runFn: Run,
    readonly repoDir: string,
    private readonly token: () => Promise<string>,
    private readonly askpass: string,
    /** GIT_AUTHOR_* / GIT_COMMITTER_* for the runner's own commits and merges. */
    private readonly identity: Record<string, string> = {},
  ) {}

  private async authEnv(): Promise<Record<string, string>> {
    return { GIT_ASKPASS: this.askpass, GIT_PASSWORD: await this.token(), GIT_TERMINAL_PROMPT: '0' }
  }

  async git(args: string[], opts: { cwd?: string; auth?: boolean } = {}): Promise<string> {
    const env = { ...this.identity, ...(opts.auth ? await this.authEnv() : { GIT_TERMINAL_PROMPT: '0' }) }
    return must(this.runFn, 'git', args, { cwd: opts.cwd ?? this.repoDir, env })
  }

  /** Clone on first start, fetch afterwards. Refuses if the volume holds a different repo. */
  async ensureClone(repo: string): Promise<'cloned' | 'fetched'> {
    const url = `https://github.com/${repo}.git`
    if (!existsSync(path.join(this.repoDir, '.git'))) {
      await this.git(['clone', '--quiet', url, this.repoDir], { cwd: path.dirname(this.repoDir), auth: true })
      // Worktrees written by the agent user share this object store.
      await this.git(['config', 'core.sharedRepository', 'group'])
      await this.git(['remote', 'set-head', 'origin', '--auto'], { auth: true })
      return 'cloned'
    }
    const origin = (await this.git(['remote', 'get-url', 'origin'])).trim()
    if (origin.replace(/\.git$/, '').toLowerCase() !== url.replace(/\.git$/, '').toLowerCase()) {
      throw new Error(`The repo volume holds ${origin}, not ${url}. Remove the repo and worktrees volumes to switch TARGET_REPO.`)
    }
    await this.git(['fetch', '--quiet', '--prune', 'origin'], { auth: true })
    await this.git(['remote', 'set-head', 'origin', '--auto'], { auth: true })
    return 'fetched'
  }

  async defaultBranch(): Promise<string> {
    const ref = (await this.git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim()
    return ref.replace(/^origin\//, '')
  }

  /** File content at a ref, or null if the path doesn't exist there. */
  async readAtRef(ref: string, file: string): Promise<string | null> {
    const r = await this.runFn('git', ['show', `${ref}:${file}`], { cwd: this.repoDir })
    return r.exitCode === 0 ? r.stdout : null
  }
}

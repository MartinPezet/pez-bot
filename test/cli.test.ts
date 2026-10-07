import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { main } from '../src/cli.js'
import { Git } from '../src/exec/git.js'
import { agentArgv, type Run, type RunOpts } from '../src/exec/run.js'

describe('cli', () => {
  const quiet = () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  }

  it('prints help', async () => {
    quiet()
    expect(await main(['help'])).toBe(0)
  })

  it('refuses to run jobs with an invalid environment, and says why', async () => {
    quiet()
    const dir = mkdtempSync(path.join(tmpdir(), 'pezbot-cli-'))
    process.env.DATA_DIR = dir // the logger writes under DATA_DIR/logs
    try {
      expect(await main(['sync'])).toBe(78)
      expect(console.error).toHaveBeenCalledWith('env TARGET_REPO: required')
    } finally {
      delete process.env.DATA_DIR
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('checks sub-command usage', async () => {
    quiet()
    expect(await main(['updates', 'pause'])).toBe(64)
  })

  it('rejects unknown commands', async () => {
    quiet()
    expect(await main(['frobnicate'])).toBe(64)
  })

  describe('healthcheck without state', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pezbot-cli-'))
    afterAll(() => rmSync(dir, { recursive: true, force: true }))
    it('is unhealthy when there is no database yet', async () => {
      quiet()
      process.env.DATA_DIR = dir
      expect(await main(['healthcheck'])).toBe(1)
      delete process.env.DATA_DIR
    })
  })
})

describe('agent isolation', () => {
  it('runs agent commands through sudo with a wiped environment', () => {
    const [cmd, args] = agentArgv('claude', ['-p'], { CLAUDE_CODE_OAUTH_TOKEN: 't' })
    expect(cmd).toBe('sudo')
    expect(args.slice(0, 7)).toEqual(['-n', '-u', 'agent', '-H', '--', '/usr/bin/env', '-i'])
    expect(args).toContain('HOME=/home/agent')
    expect(args).toContain('CLAUDE_CODE_OAUTH_TOKEN=t')
    expect(args.slice(-2)).toEqual(['claude', '-p'])
    expect(args.some(a => a.startsWith('GH_TOKEN='))).toBe(false)
  })
})

describe('git', () => {
  const fake = (responses: Record<string, string>) => {
    const calls: { args: string[]; opts?: RunOpts }[] = []
    const run: Run = async (_cmd, args, opts) => {
      calls.push({ args, opts })
      const key = Object.keys(responses).find(k => args.join(' ').startsWith(k))
      return { exitCode: key ? 0 : 128, stdout: key ? (responses[key] ?? '') : '', stderr: '', all: '', timedOut: false }
    }
    return { run, calls }
  }

  it('fetches with the token only in the git child env', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pezbot-git-'))
    const repoDir = path.join(dir, 'repo')
    // pretend it's already cloned
    const { mkdirSync } = await import('node:fs')
    mkdirSync(path.join(repoDir, '.git'), { recursive: true })
    const { run, calls } = fake({
      'remote get-url origin': 'https://github.com/Acme/EarthScope.git',
      'fetch --quiet --prune origin': '',
      'remote set-head': '',
    })
    const git = new Git(run, repoDir, async () => 'ghs_secret', '/opt/askpass.sh')
    expect(await git.ensureClone('acme/earthscope')).toBe('fetched')
    const fetch = calls.find(c => c.args[0] === 'fetch')
    expect(fetch?.opts?.env).toEqual({ GIT_ASKPASS: '/opt/askpass.sh', GIT_PASSWORD: 'ghs_secret', GIT_TERMINAL_PROMPT: '0' })
    const getUrl = calls.find(c => c.args[0] === 'remote' && c.args[1] === 'get-url')
    expect(getUrl?.opts?.env?.GIT_PASSWORD).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses a volume that holds a different repo', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pezbot-git-'))
    const { mkdirSync } = await import('node:fs')
    mkdirSync(path.join(dir, 'repo', '.git'), { recursive: true })
    const { run } = fake({ 'remote get-url origin': 'https://github.com/acme/other.git' })
    const git = new Git(run, path.join(dir, 'repo'), async () => 't', '/a')
    await expect(git.ensureClone('acme/earthscope')).rejects.toThrow(/holds https:\/\/github.com\/acme\/other.git/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('readAtRef returns null for a missing file', async () => {
    const { run } = fake({ 'show origin/main:.backlog-runner.json': '{"a":1}' })
    const git = new Git(run, '/repo', async () => 't', '/a')
    expect(await git.readAtRef('origin/main', '.backlog-runner.json')).toBe('{"a":1}')
    expect(await git.readAtRef('origin/main', 'nope.json')).toBeNull()
  })
})

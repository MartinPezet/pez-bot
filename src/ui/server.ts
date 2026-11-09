import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Logger } from '../log.js'

/**
 * Operator page, served by the daemon when UI_TOKEN is set (ADR-0017). Its commands are the CLI
 * run as a child process, so they take the lease and behave exactly as they do from a terminal.
 */

/** docker/init-firewall.sh opens this port and blocks the agent user from it. Keep them in step. */
export const UI_PORT = 8377
const MIN_TOKEN_LENGTH = 16

/** The only commands the page can run. `daemon` is left out: it's already running. */
export const COMMANDS: { group: string; cmd: string; about: string; confirm?: string }[] = [
  { group: 'Inspect', cmd: 'status', about: 'Queue, jobs, usage, health' },
  { group: 'Inspect', cmd: 'usage', about: 'Gauge, gate and windows' },
  { group: 'Inspect', cmd: 'usage --probe', about: 'Fresh reading; one tiny Claude call' },
  { group: 'Inspect', cmd: 'healthcheck', about: 'The Docker health check' },
  { group: 'Jobs', cmd: 'sync', about: 'Recover and promote. No Claude' },
  { group: 'Jobs', cmd: 'work', about: 'Build or propose one item' },
  { group: 'Jobs', cmd: 'triage', about: 'Inbox and answered questions' },
  { group: 'Jobs', cmd: 'summary', about: 'Post the summary to the digest' },
  { group: 'Jobs', cmd: 'cleanup', about: 'Worktrees, branches, logs, disk' },
  { group: 'Jobs', cmd: 'update', about: 'Claude Code, OpenSpec, Superpowers' },
  { group: 'Setup', cmd: 'setup', about: 'Labels, digest checks, scaffolding PR' },
  { group: 'Setup', cmd: 'migrate-prd', about: 'PRD.md to a backlog.json PR' },
  { group: 'Setup', cmd: 'migrate-prd --apply', about: 'Create issues from backlog.json', confirm: 'Create issues from the merged backlog.json?' },
  { group: 'Setup', cmd: 'updates resume', about: 'Clear the pause after a rollback' },
  { group: 'Ignore budget', cmd: 'work --ignore-budget', about: 'Skips windows and the budget gate', confirm: 'Run work outside the windows and budget gate? This spends plan usage.' },
  { group: 'Ignore budget', cmd: 'triage --ignore-budget', about: 'Skips windows and the budget gate', confirm: 'Run triage outside the windows and budget gate? This spends plan usage.' },
  { group: 'Ignore budget', cmd: 'migrate-prd --ignore-budget', about: 'Skips windows and the budget gate', confirm: 'Run migrate-prd outside the windows and budget gate? This spends plan usage.' },
]

export type RunCli = (args: string[], out: (chunk: Buffer | string) => void) => Promise<number>

/** Runs this process's own CLI. `stop` asks running commands to finish, so a job can checkpoint. */
function cliRunner(): { run: RunCli; stop(): Promise<unknown> } {
  const { UI_TOKEN: _, ...env } = process.env
  const cli = [...process.execArgv, realpathSync(process.argv[1] ?? '')]
  const running = new Map<ChildProcess, Promise<number>>()
  return {
    run(args, out) {
      const child = spawn(process.execPath, [...cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', out)
      child.stderr.on('data', out)
      const done = new Promise<number>(resolve => {
        child.once('error', e => {
          out(`could not start the command: ${e.message}\n`)
          resolve(127)
        })
        child.once('close', code => resolve(code ?? 1))
      }).finally(() => running.delete(child))
      running.set(child, done)
      return done
    },
    stop() {
      for (const child of running.keys()) child.kill('SIGTERM')
      return Promise.all(running.values())
    },
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest()

/** HTTP Basic: the password is UI_TOKEN and the username is ignored. */
function authorized(req: IncomingMessage, token: string): boolean {
  const [scheme = '', encoded = ''] = (req.headers.authorization ?? '').split(' ')
  if (scheme.toLowerCase() !== 'basic') return false
  const decoded = Buffer.from(encoded, 'base64').toString()
  return timingSafeEqual(sha256(decoded.slice(decoded.indexOf(':') + 1)), sha256(token))
}

/** A browser caches Basic credentials, so other sites' POSTs would carry them: require our own Origin. */
function sameOrigin(req: IncomingMessage): boolean {
  const { host, origin } = req.headers
  return origin === `http://${host}` || origin === `https://${host}`
}

const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'"

export function createUi(run: RunCli, token: string): Server {
  const page = readFileSync(new URL('page.html', import.meta.url))
  const commands = new Set(COMMANDS.map(c => c.cmd))

  return createServer((req, res) => {
    if (!authorized(req, token)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="pez-bot", charset="UTF-8"' }).end('password required')
      return
    }
    if (req.method !== 'GET' && !sameOrigin(req)) {
      res.writeHead(403).end('forbidden')
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = `${req.method} ${url.pathname}`
    const text = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }

    if (route === 'GET /') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_CSP }).end(page)
    } else if (route === 'GET /api/commands') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(COMMANDS))
    } else if (route === 'GET /api/failures') {
      let body = ''
      void run(['failures'], chunk => (body += chunk.toString())).then(code => res.writeHead(code === 0 ? 200 : 502, text).end(body))
    } else if (route === 'POST /api/run') {
      const cmd = url.searchParams.get('cmd') ?? ''
      if (!commands.has(cmd)) {
        res.writeHead(404).end('unknown command')
        return
      }
      res.writeHead(200, text).flushHeaders()
      // Writes are no-ops once the tab is gone. The job keeps running and its output keeps
      // draining: a blocked pipe could otherwise stall it.
      void run(cmd.split(' '), chunk => res.write(chunk)).then(code => res.end(`\n[exit ${code}]\n`))
    } else {
      res.writeHead(404).end('not found')
    }
  })
}

/** Serves the page if UI_TOKEN is set. Returns how to stop it, and any command it started. */
export function startUi(log: Logger): () => Promise<void> {
  const token = process.env.UI_TOKEN
  if (!token) return async () => {}
  if (token.length < MIN_TOKEN_LENGTH) {
    log.error(`UI_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters: the UI is not started`)
    return async () => {}
  }
  const cli = cliRunner()
  const server = createUi((args, out) => {
    if (args[0] !== 'failures') log.info({ args }, 'ui: running command') // the page polls failures
    return cli.run(args, out)
  }, token)
  server.on('error', e => log.error({ err: e }, 'ui server failed'))
  // All interfaces: Docker's published port arrives on the container's network address.
  server.listen(UI_PORT, '0.0.0.0', () => log.info({ port: UI_PORT }, 'ui listening'))
  return async () => {
    server.close()
    await cli.stop()
    server.closeAllConnections()
  }
}

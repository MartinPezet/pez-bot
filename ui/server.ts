import { spawn } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Local operator page. Runs on the host and shells out to the CLI, so nothing listens inside
 * the container, where agent-written code could reach it (ADR-0015).
 */

/** The only commands the page can run. `daemon` is left out: it's the container's entrypoint. */
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

const ROOT = fileURLToPath(new URL('..', import.meta.url))

export function cliRunner(prefix: string): RunCli {
  const [bin = 'docker', ...pre] = prefix.trim().split(/\s+/)
  return (args, out) =>
    new Promise(resolve => {
      const child = spawn(bin, [...pre, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', out)
      child.stderr.on('data', out)
      child.once('error', e => {
        out(`could not start ${bin}: ${e.message}\n`)
        resolve(127)
      })
      child.once('close', code => resolve(code ?? 1))
    })
}

/** Host check stops DNS rebinding; Origin check stops other sites POSTing to localhost. */
function trusted(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host ?? ''
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  return req.method === 'GET' || req.headers.origin === `http://${host}`
}

const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'"

export function createUi(run: RunCli): Server {
  const page = readFileSync(new URL('page.html', import.meta.url))
  const commands = new Set(COMMANDS.map(c => c.cmd))

  const server = createServer((req, res) => {
    if (!trusted(req, (server.address() as AddressInfo).port)) {
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
  return server
}

// realpath: matches how src/cli.ts detects being run directly.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const port = Number(process.env.PEZ_BOT_UI_PORT ?? 8377)
  const prefix = process.env.PEZ_BOT_UI_EXEC ?? 'docker compose exec -T runner pez-bot'
  createUi(cliRunner(prefix)).listen(port, '127.0.0.1', () => {
    console.log(`pez-bot UI: http://localhost:${port}  (runs: ${prefix} <command>)`)
  })
}

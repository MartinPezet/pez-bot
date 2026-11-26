import { request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { envSecrets } from '../src/config/env.js'
import type { Logger } from '../src/log.js'
import { COMMANDS, createUi, startUi, type RunCli } from '../src/ui/server.js'

const TOKEN = 'test-token-0123456789'
const basic = (password: string) => `Basic ${Buffer.from(`anyone:${password}`).toString('base64')}`

describe('ui server', () => {
  let server: Server | undefined
  afterEach(() => void server?.close())

  const start = async (run: RunCli) => {
    server = createUi(run, TOKEN)
    await new Promise<void>(r => server?.listen(0, '127.0.0.1', r))
    return (server.address() as AddressInfo).port
  }

  const raw = (port: number, method: string, path: string, headers: Record<string, string>) =>
    new Promise<{ status: number; body: string; challenge: string | undefined }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method, path, headers }, res => {
        let body = ''
        res.on('data', d => (body += d))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, challenge: res.headers['www-authenticate'] }))
      })
      req.on('error', reject)
      req.end()
    })
  const get = (port: number, path: string) => raw(port, 'GET', path, { authorization: basic(TOKEN) })
  const post = (port: number, path: string) => raw(port, 'POST', path, { authorization: basic(TOKEN), origin: `http://127.0.0.1:${port}` })

  it('serves the page and the command list', async () => {
    const port = await start(vi.fn())
    expect((await get(port, '/')).body).toContain('<title>pez-bot</title>')
    expect(JSON.parse((await get(port, '/api/commands')).body)).toEqual(COMMANDS)
  })

  it('asks for the password on every route, and refuses a wrong one', async () => {
    const run = vi.fn<RunCli>()
    const port = await start(run)
    for (const path of ['/', '/api/commands', '/api/failures']) {
      const res = await raw(port, 'GET', path, {})
      expect(res.status).toBe(401)
      expect(res.challenge).toContain('Basic')
    }
    const origin = `http://127.0.0.1:${port}`
    expect((await raw(port, 'POST', '/api/run?cmd=sync', { origin })).status).toBe(401)
    expect((await raw(port, 'POST', '/api/run?cmd=sync', { origin, authorization: basic('wrong') })).status).toBe(401)
    expect((await raw(port, 'POST', '/api/run?cmd=sync', { origin, authorization: `Bearer ${TOKEN}` })).status).toBe(401)
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses a POST with a foreign or missing Origin (CSRF)', async () => {
    const run = vi.fn<RunCli>()
    const port = await start(run)
    const authorization = basic(TOKEN)
    expect((await raw(port, 'POST', '/api/run?cmd=sync', { authorization, origin: 'https://evil.example' })).status).toBe(403)
    expect((await raw(port, 'POST', '/api/run?cmd=sync', { authorization })).status).toBe(403)
    expect(run).not.toHaveBeenCalled()
  })

  it('only runs listed commands', async () => {
    const run = vi.fn<RunCli>()
    const port = await start(run)
    for (const cmd of ['daemon', 'sync --evil', 'sync; rm -rf /']) {
      expect((await post(port, `/api/run?cmd=${encodeURIComponent(cmd)}`)).status).toBe(404)
    }
    expect(run).not.toHaveBeenCalled()
  })

  it('splits the listed command into argv and streams output with the exit code', async () => {
    const run = vi.fn<RunCli>(async (_args, out) => {
      out('working\n')
      return 75
    })
    const port = await start(run)
    const res = await post(port, `/api/run?cmd=${encodeURIComponent('work --ignore-budget')}`)
    expect(run.mock.calls[0]?.[0]).toEqual(['work', '--ignore-budget'])
    expect(res.body).toBe('working\n\n[exit 75]\n')
  })

  it('reports failed runs, and a 502 when the CLI fails', async () => {
    let code = 0
    const port = await start(async (args, out) => {
      expect(args).toEqual(['failures'])
      out(code === 0 ? 'No failed runs.\n' : 'no database\n')
      return code
    })
    expect(await get(port, '/api/failures')).toMatchObject({ status: 200, body: 'No failed runs.\n' })
    code = 1
    expect(await get(port, '/api/failures')).toMatchObject({ status: 502, body: 'no database\n' })
  })

  it('keeps draining a job after the tab goes away', async () => {
    let finish = (_code: number) => {}
    let out: Parameters<RunCli>[1] = () => {}
    const port = await start((_args, o) => {
      out = o
      return new Promise(r => (finish = r))
    })
    await new Promise<void>(resolve => {
      const headers = { authorization: basic(TOKEN), origin: `http://127.0.0.1:${port}` }
      const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/api/run?cmd=sync', headers }, res => {
        res.destroy()
        req.destroy()
        setTimeout(resolve, 20)
      })
      req.on('error', () => {})
      req.end()
    })
    expect(() => out('still going\n')).not.toThrow()
    finish(0)
    expect((await get(port, '/api/commands')).status).toBe(200)
  })
})

describe('startUi', () => {
  const log = () => ({ error: vi.fn(), info: vi.fn() }) as unknown as Logger
  afterEach(() => vi.unstubAllEnvs())

  it('stays off without a token', async () => {
    vi.stubEnv('UI_TOKEN', '')
    const l = log()
    await startUi(l)()
    expect(l.info).not.toHaveBeenCalled()
    expect(l.error).not.toHaveBeenCalled()
  })

  it('refuses a short token, and says so', async () => {
    vi.stubEnv('UI_TOKEN', 'short')
    const l = log()
    await startUi(l)()
    expect(l.error).toHaveBeenCalledWith(expect.stringContaining('UI_TOKEN'))
    expect(l.info).not.toHaveBeenCalled()
  })

  it('registers the token for redaction', () => {
    expect(envSecrets({ UI_TOKEN: TOKEN })).toContain(TOKEN)
  })
})

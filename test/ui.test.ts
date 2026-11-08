import { request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMMANDS, createUi, type RunCli } from '../ui/server.js'

describe('ui server', () => {
  let server: Server | undefined
  afterEach(() => void server?.close())

  const start = async (run: RunCli) => {
    server = createUi(run)
    await new Promise<void>(r => server?.listen(0, '127.0.0.1', r))
    return (server.address() as AddressInfo).port
  }

  const call = (port: number, method: string, path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method, path, headers }, res => {
        let body = ''
        res.on('data', d => (body += d))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject)
      req.end()
    })
  const post = (port: number, path: string) => call(port, 'POST', path, { origin: `http://127.0.0.1:${port}` })

  it('serves the page and the command list', async () => {
    const port = await start(vi.fn())
    expect((await call(port, 'GET', '/')).body).toContain('<title>pez-bot</title>')
    expect(JSON.parse((await call(port, 'GET', '/api/commands')).body)).toEqual(COMMANDS)
  })

  it('refuses a foreign Host (DNS rebinding)', async () => {
    const port = await start(vi.fn())
    expect((await call(port, 'GET', '/', { host: 'evil.example' })).status).toBe(403)
  })

  it('refuses a POST with a foreign or missing Origin (CSRF)', async () => {
    const run = vi.fn<RunCli>()
    const port = await start(run)
    expect((await call(port, 'POST', '/api/run?cmd=sync', { origin: 'https://evil.example' })).status).toBe(403)
    expect((await call(port, 'POST', '/api/run?cmd=sync')).status).toBe(403)
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

  it('reports failed runs, and a 502 when the CLI cannot be reached', async () => {
    let code = 0
    const port = await start(async (args, out) => {
      expect(args).toEqual(['failures'])
      out(code === 0 ? 'No failed runs.\n' : 'no docker\n')
      return code
    })
    expect(await call(port, 'GET', '/api/failures')).toEqual({ status: 200, body: 'No failed runs.\n' })
    code = 1
    expect(await call(port, 'GET', '/api/failures')).toEqual({ status: 502, body: 'no docker\n' })
  })

  it('keeps draining a job after the tab goes away', async () => {
    let finish = (_code: number) => {}
    let out: Parameters<RunCli>[1] = () => {}
    const port = await start((_args, o) => {
      out = o
      return new Promise(r => (finish = r))
    })
    await new Promise<void>(resolve => {
      const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/api/run?cmd=sync', headers: { origin: `http://127.0.0.1:${port}` } }, res => {
        res.destroy()
        req.destroy()
        setTimeout(resolve, 20)
      })
      req.on('error', () => {})
      req.end()
    })
    expect(() => out('still going\n')).not.toThrow()
    finish(0)
    expect((await call(port, 'GET', '/api/commands')).status).toBe(200)
  })
})

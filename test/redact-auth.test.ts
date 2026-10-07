import { createVerify, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { appJwt, appProvider, checkGitHubAuth, patProvider } from '../src/github/auth.js'
import { Redactor, REDACTED } from '../src/redact.js'

describe('redaction', () => {
  it('removes registered secret values everywhere they appear', () => {
    const r = new Redactor()
    r.add('super-secret-value', 'short', undefined)
    expect(r.string('a super-secret-value b super-secret-value')).toBe(`a ${REDACTED} b ${REDACTED}`)
    expect(r.string('short stays')).toBe('short stays')
  })

  it('removes token-shaped strings even when unregistered', () => {
    const r = new Redactor()
    const samples = [
      `ghp_${'a'.repeat(36)}`,
      `ghs_${'B1'.repeat(18)}`,
      `github_pat_${'x'.repeat(40)}`,
      'sk-ant-oat01-abcdefghijklmnop',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----',
    ]
    for (const s of samples) expect(r.string(`token=${s};`)).toBe(`token=${REDACTED};`)
    expect(r.string('postgres://test:hunter2@db:5432/x')).toBe(`postgres://${REDACTED}@db:5432/x`)
  })

  it('redacts nested objects and errors without touching other values', () => {
    const r = new Redactor()
    r.add('very-secret-token')
    const out = r.deep({ a: ['very-secret-token', 3], b: { c: null, d: true }, e: new Error('failed with very-secret-token') })
    expect(out).toMatchObject({ a: [REDACTED, 3], b: { c: null, d: true }, e: { type: 'Error', message: `failed with ${REDACTED}` } })
  })

  it('survives cycles', () => {
    const o: Record<string, unknown> = { name: 'x' }
    o.self = o
    expect(new Redactor().deep(o)).toEqual({ name: 'x', self: '[Circular]' })
  })
})

describe('GitHub App auth', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()

  it('signs a valid RS256 JWT, backdated for clock drift', () => {
    const jwt = appJwt('123', pem, Date.parse('2026-10-05T09:00:00Z'))
    const [h, p, s] = jwt.split('.') as [string, string, string]
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString()) as { iat: number; exp: number; iss: string }
    expect(payload.iss).toBe('123')
    expect(payload.iat).toBe(Date.parse('2026-10-05T09:00:00Z') / 1000 - 60)
    expect(payload.exp - payload.iat).toBe(540)
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true)
  })

  it('caches the installation token and refreshes it 10 minutes before expiry', async () => {
    let clock = Date.parse('2026-10-05T09:00:00Z')
    let calls = 0
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls++
      expect(String(url)).toBe('https://api.github.com/app/installations/456/access_tokens')
      expect(init?.method).toBe('POST')
      return new Response(JSON.stringify({ token: `ghs_token${calls}`, expires_at: new Date(clock + 60 * 60_000).toISOString() }))
    }) as typeof fetch
    const p = appProvider({ appId: '123', installationId: '456', pem, fetchFn, now: () => clock })
    expect(await p.token()).toBe('ghs_token1')
    clock += 49 * 60_000
    expect(await p.token()).toBe('ghs_token1')
    clock += 2 * 60_000
    expect(await p.token()).toBe('ghs_token2')
    expect(calls).toBe(2)
  })

  it('reports a failed token request clearly', async () => {
    const fetchFn = (async () => new Response('Bad credentials', { status: 401 })) as typeof fetch
    const p = appProvider({ appId: '1', installationId: '2', pem, fetchFn })
    await expect(p.token()).rejects.toThrow('GitHub App installation token request failed: 401 Bad credentials')
  })

  it('checkGitHubAuth reports ok and failure without throwing', async () => {
    const ok = await checkGitHubAuth(patProvider('ghp_x'), 'a/b', (async () => new Response('{}')) as typeof fetch)
    expect(ok).toEqual({ ok: true, detail: 'pat can read a/b' })
    const bad = await checkGitHubAuth(patProvider('ghp_x'), 'a/b', (async () => new Response('', { status: 404 })) as typeof fetch)
    expect(bad).toEqual({ ok: false, detail: '404 reading a/b' })
    const boom = await checkGitHubAuth(patProvider('ghp_x'), 'a/b', (async () => {
      throw new Error('network down')
    }) as typeof fetch)
    expect(boom).toEqual({ ok: false, detail: 'network down' })
  })
})

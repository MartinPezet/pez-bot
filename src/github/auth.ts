import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Env } from '../config/env.js'
import { redactor } from '../redact.js'

export interface TokenProvider {
  kind: 'pat' | 'app'
  token(): Promise<string>
  /** The login GitHub shows on the bot's comments and PRs (`slug[bot]` for an App). */
  login(): Promise<string>
}

const ghHeaders = (auth: string) => ({
  Authorization: `Bearer ${auth}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'pez-bot',
})

export function patProvider(token: string, fetchFn: typeof fetch = fetch): TokenProvider {
  let login: string | undefined
  return {
    kind: 'pat',
    token: async () => token,
    async login() {
      if (login) return login
      const res = await fetchFn('https://api.github.com/user', { headers: ghHeaders(token) })
      if (!res.ok) throw new Error(`GET /user failed: ${res.status}`)
      login = ((await res.json()) as { login: string }).login
      return login
    },
  }
}

/** RS256 JWT for authenticating as the App. Backdated 60 s for clock drift; GitHub caps lifetime at 10 min. */
export function appJwt(appId: string, pem: string, nowMs = Date.now()): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const iat = Math.floor(nowMs / 1000) - 60
  const data = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat, exp: iat + 540, iss: appId })}`
  return `${data}.${createSign('RSA-SHA256').update(data).sign(pem).toString('base64url')}`
}

/** Installation tokens last an hour; refresh when less than 10 minutes remain. */
export function appProvider(o: {
  appId: string
  installationId: string
  pem: string
  fetchFn?: typeof fetch
  now?: () => number
}): TokenProvider {
  const fetchFn = o.fetchFn ?? fetch
  const now = o.now ?? Date.now
  let cached: { token: string; expiresAt: number } | undefined
  let login: string | undefined
  return {
    kind: 'app',
    async login() {
      if (login) return login
      const res = await fetchFn('https://api.github.com/app', { headers: ghHeaders(appJwt(o.appId, o.pem, now())) })
      if (!res.ok) throw new Error(`GET /app failed: ${res.status}`)
      login = `${((await res.json()) as { slug: string }).slug}[bot]`
      return login
    },
    async token() {
      if (cached && cached.expiresAt - now() > 10 * 60_000) return cached.token
      const res = await fetchFn(`https://api.github.com/app/installations/${o.installationId}/access_tokens`, {
        method: 'POST',
        headers: ghHeaders(appJwt(o.appId, o.pem, now())),
      })
      if (!res.ok) throw new Error(`GitHub App installation token request failed: ${res.status} ${await res.text()}`)
      const j = (await res.json()) as { token: string; expires_at: string }
      redactor.add(j.token)
      cached = { token: j.token, expiresAt: Date.parse(j.expires_at) }
      return j.token
    },
  }
}

export function tokenProviderFromEnv(env: Env): TokenProvider {
  if (env.GH_TOKEN) return patProvider(env.GH_TOKEN)
  const pem = readFileSync(env.GH_APP_PRIVATE_KEY_FILE ?? '', 'utf8')
  redactor.add(pem)
  return appProvider({ appId: env.GH_APP_ID ?? '', installationId: env.GH_APP_INSTALLATION_ID ?? '', pem })
}

/** Cheap credential check used by the daemon (cached for the health check). */
export async function checkGitHubAuth(
  provider: TokenProvider,
  repo: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetchFn(`https://api.github.com/repos/${repo}`, {
      headers: ghHeaders(await provider.token()),
    })
    return res.ok ? { ok: true, detail: `${provider.kind} can read ${repo}` } : { ok: false, detail: `${res.status} reading ${repo}` }
  } catch (e) {
    return { ok: false, detail: redactor.string((e as Error).message) }
  }
}

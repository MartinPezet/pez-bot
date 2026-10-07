import { describe, expect, it } from 'vitest'
import { loadEnv } from '../src/config/env.js'
import { parseProjectConfig } from '../src/config/project.js'

const baseEnv = {
  TARGET_REPO: 'acme/earthscope',
  DIGEST_REPO: 'acme/digest',
  GH_APP_ID: '123',
  GH_APP_INSTALLATION_ID: '456',
  GH_APP_PRIVATE_KEY_FILE: '/run/secrets/gh-app.pem',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxxxxxxxxxxx',
}

describe('env', () => {
  it('accepts a minimal App config and fills defaults', () => {
    const r = loadEnv(baseEnv)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.USAGE_UNKNOWN_POLICY).toBe('allow')
    expect(r.value.CLAUDE_CHANNEL).toBe('stable')
    expect(r.value.WEEKLY_STOP_PCT).toBe(80)
    expect(r.value.DRY_RUN).toBe(false)
    expect(r.value.RUN_WINDOWS).toBe('mon-fri 09:00-12:00; mon-fri 22:00-02:00')
    expect(r.value.EXTRA_ALLOWED_DOMAINS).toEqual([])
  })

  it('parses booleans, numbers and lists', () => {
    const r = loadEnv({ ...baseEnv, DRY_RUN: '1', WEEKLY_STOP_PCT: '70', EXTRA_ALLOWED_DOMAINS: 'a.example, b.example' })
    expect(r.ok && r.value.DRY_RUN).toBe(true)
    expect(r.ok && r.value.WEEKLY_STOP_PCT).toBe(70)
    expect(r.ok && r.value.EXTRA_ALLOWED_DOMAINS).toEqual(['a.example', 'b.example'])
  })

  it('treats empty strings from compose as unset', () => {
    const r = loadEnv({ ...baseEnv, GH_TOKEN: '', ANTHROPIC_API_KEY: '', HEALTH_PING_URL: '' })
    expect(r.ok).toBe(true)
  })

  it('says exactly what is wrong', () => {
    const r = loadEnv({ TARGET_REPO: 'not-a-repo', DIGEST_REPO: 'a/b', GH_APP_ID: '1' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toContain('TARGET_REPO: must be owner/name')
    expect(loadEnv({}).ok || (loadEnv({}) as { errors: string[] }).errors).toContain('DIGEST_REPO: required')
    expect(r.errors.some(e => e.includes('GH_APP_ID, GH_APP_INSTALLATION_ID and GH_APP_PRIVATE_KEY_FILE (or GH_APP_PRIVATE_KEY) together'))).toBe(true)
    expect(r.errors.some(e => e.includes('exactly one of CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY'))).toBe(true)
  })

  it('rejects both GitHub auth modes, and no auth at all', () => {
    const both = loadEnv({ ...baseEnv, GH_TOKEN: 'ghp_x' })
    expect(!both.ok && both.errors.some(e => e.includes('not both'))).toBe(true)
    const { GH_APP_ID, GH_APP_INSTALLATION_ID, GH_APP_PRIVATE_KEY_FILE, ...none } = baseEnv
    const r = loadEnv(none)
    expect(!r.ok && r.errors.some(e => e.includes('GitHub credentials missing'))).toBe(true)
  })

  it('accepts the App key inline instead of as a file, but not both', () => {
    const { GH_APP_PRIVATE_KEY_FILE, ...inline } = baseEnv
    expect(loadEnv({ ...inline, GH_APP_PRIVATE_KEY: 'LS0tLS1CRUdJTg==' }).ok).toBe(true)
    const both = loadEnv({ ...baseEnv, GH_APP_PRIVATE_KEY: 'x' })
    expect(!both.ok && both.errors.some(e => e.includes('not both'))).toBe(true)
  })

  it('rejects a hard stop below the weekly stop', () => {
    const r = loadEnv({ ...baseEnv, WEEKLY_STOP_PCT: '90', WEEKLY_HARD_STOP_PCT: '85' })
    expect(r.ok).toBe(false)
  })
})

const minimalProject = {
  displayName: 'EarthScope',
  install: ['pnpm', 'install', '--frozen-lockfile'],
  gates: [['pnpm', 'typecheck'], ['pnpm', 'test']],
  areas: ['borehole-log', 'ags'],
  allowedAuthors: ['martinpezet'],
}

describe('project config', () => {
  it('fills nested defaults', () => {
    const r = parseProjectConfig(JSON.stringify(minimalProject))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.wip).toEqual({ proposalsInReview: 3, prsInReview: 3 })
    expect(r.value.maxFixAttempts).toBe(2)
    expect(r.value.models.build).toBe('sonnet')
    expect(r.value.claude).toEqual({ maxTurns: 150, timeoutMin: 90, extraAllowedTools: [] })
    expect(r.value.timezone).toBe('Europe/London')
    expect(r.value.testServices).toEqual({})
  })

  it('fills test service defaults', () => {
    const r = parseProjectConfig(
      JSON.stringify({ ...minimalProject, testServices: { postgres: { version: '16' }, redis: { version: '7' } } }),
    )
    expect(r.ok && r.value.testServices.postgres).toEqual({ version: '16', env: 'DATABASE_URL', database: 'app_test', schema: 'public' })
    expect(r.ok && r.value.testServices.redis).toEqual({ version: '7', env: 'REDIS_URL' })
  })

  it('explains a missing file', () => {
    const r = parseProjectConfig(null, 'main')
    expect(!r.ok && r.errors[0]).toMatch(/not found on main.*setup/)
  })

  it('explains invalid JSON', () => {
    const r = parseProjectConfig('{ nope')
    expect(!r.ok && r.errors[0]).toMatch(/not valid JSON/)
  })

  it('rejects unknown keys, bad areas, bad tz and bad cron with paths', () => {
    const r = parseProjectConfig(
      JSON.stringify({
        ...minimalProject,
        surprise: true,
        areas: ['Not Kebab'],
        timezone: 'Mars/Olympus',
        schedule: { sync: 'every so often' },
      }),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    const all = r.errors.join('\n')
    expect(all).toMatch(/surprise/)
    expect(all).toMatch(/areas\.0: must be lower-kebab-case/)
    expect(all).toMatch(/timezone: must be an IANA time zone/)
    expect(all).toMatch(/schedule\.sync: must be a valid cron expression/)
  })

  it('allows secret-sounding names with dummy values, but not real-looking credentials', () => {
    const dummies = { APP_KEY: 'test-app-key-0123456789abcdef', POLAR_WEBHOOK_SECRET: 'test-webhook-secret', DB_PASSWORD: 'test' }
    expect(parseProjectConfig(JSON.stringify({ ...minimalProject, extraTestEnv: dummies })).ok).toBe(true)
    const real = parseProjectConfig(JSON.stringify({ ...minimalProject, extraTestEnv: { GH: `ghp_${'a'.repeat(36)}` } }))
    expect(!real.ok && real.errors.join()).toMatch(/looks like a real credential/)
  })

  it('validates test service versions and variable mappings', () => {
    const ok = parseProjectConfig(
      JSON.stringify({
        ...minimalProject,
        testServices: { postgres: { version: '16', vars: { host: 'DB_HOST', password: 'DB_PASSWORD' } }, redis: { version: '7.2', vars: { port: 'REDIS_PORT' } } },
      }),
    )
    expect(ok.ok).toBe(true)
    const bad = parseProjectConfig(JSON.stringify({ ...minimalProject, testServices: { postgres: { version: 'latest', vars: { hostname: 'X' } } } }))
    expect(!bad.ok && bad.errors.join('\n')).toMatch(/version: must be a version number[\s\S]*hostname/)
  })
})

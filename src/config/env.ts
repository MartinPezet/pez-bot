import { z } from 'zod'
import { formatIssues, type ParseResult } from '../result.js'

/** Account-level settings. These are env vars, not project config, because the usage budget is shared. */

const TRUE = ['true', '1', 'on', 'yes']
const bool = (def: boolean) =>
  z.enum(['true', 'false', '1', '0', 'on', 'off', 'yes', 'no'])
    .default(def ? 'true' : 'false')
    .transform(v => TRUE.includes(v))
const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(min).max(max).default(def)
const pct = (def: number) => int(def, 0, 100)
const repo = z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'must be owner/name')
const secret = z.string().min(1).optional()

export const envSchema = z
  .object({
    TARGET_REPO: repo,
    GH_TOKEN: secret,
    GH_APP_ID: z.string().regex(/^\d+$/, 'must be numeric').optional(),
    GH_APP_INSTALLATION_ID: z.string().regex(/^\d+$/, 'must be numeric').optional(),
    GH_APP_PRIVATE_KEY_FILE: z.string().min(1).optional(),
    CLAUDE_CODE_OAUTH_TOKEN: secret,
    ANTHROPIC_API_KEY: secret,
    DIGEST_REPO: repo,
    DIGEST_CATEGORY: z.string().min(1).default('Daily Digest'),
    DIGEST_AUTO_CREATE: bool(false),
    DRY_RUN: bool(false),
    PERMISSION_MODE: z.enum(['default', 'acceptEdits', 'dontAsk', 'auto', 'bypassPermissions']).default('acceptEdits'),
    USAGE_PROBE: bool(true),
    USAGE_MAX_AGE_MIN: int(30, 1),
    USAGE_UNKNOWN_POLICY: z.enum(['block', 'allow']).default('allow'),
    WEEKLY_STOP_PCT: pct(80),
    WEEKLY_HARD_STOP_PCT: pct(95),
    FIVE_HOUR_START_MAX_PCT: pct(60),
    RUN_WINDOWS: z.string().min(1).default('mon-fri 09:00-12:00; mon-fri 22:00-02:00'),
    WINDOW_GRACE_MIN: int(20),
    URGENT_IGNORES_WINDOWS: bool(true),
    TZ: z.string().default('Europe/London'),
    KEEP_BLOCKED_WORKTREES_DAYS: int(3),
    RETENTION_DAYS: int(14, 1),
    MIN_FREE_DISK_GB: int(10),
    HEALTH_PING_URL: z.url().optional(),
    EXTRA_ALLOWED_DOMAINS: z
      .string()
      .default('')
      .transform(s => s.split(',').map(x => x.trim()).filter(Boolean)),
    INSTALL_SUPERPOWERS: bool(false),
    CLAUDE_CHANNEL: z.enum(['stable', 'latest']).default('stable'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    BOT_GIT_NAME: z.string().min(1).default('pez-bot'),
    BOT_GIT_EMAIL: z.string().min(1).default('pez-bot@users.noreply.github.com'),
    TEST_POSTGRES_URL: z.string().min(1).optional(),
    TEST_REDIS_URL: z.string().min(1).optional(),
  })
  .superRefine((e, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message })
    const app = [e.GH_APP_ID, e.GH_APP_INSTALLATION_ID, e.GH_APP_PRIVATE_KEY_FILE].filter(Boolean).length
    if (app > 0 && app < 3) fail('GitHub App auth needs GH_APP_ID, GH_APP_INSTALLATION_ID and GH_APP_PRIVATE_KEY_FILE together')
    if (app === 3 && e.GH_TOKEN) fail('set either GH_TOKEN or the GitHub App variables, not both')
    if (app === 0 && !e.GH_TOKEN) fail('GitHub credentials missing: set the GitHub App variables (recommended) or GH_TOKEN')
    if (!!e.CLAUDE_CODE_OAUTH_TOKEN === !!e.ANTHROPIC_API_KEY) fail('set exactly one of CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY')
    if (e.WEEKLY_HARD_STOP_PCT < e.WEEKLY_STOP_PCT) fail('WEEKLY_HARD_STOP_PCT must be >= WEEKLY_STOP_PCT')
  })

export type Env = z.infer<typeof envSchema>

export function loadEnv(raw: NodeJS.ProcessEnv = process.env): ParseResult<Env> {
  // Compose passes `VAR=` as an empty string; treat that as unset.
  const cleaned = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v !== ''))
  const r = envSchema.safeParse(cleaned)
  return r.success ? { ok: true, value: r.data } : { ok: false, errors: formatIssues(r.error) }
}

/** Every secret value in the environment, for the redactor. */
export const envSecrets = (raw: NodeJS.ProcessEnv = process.env): (string | undefined)[] =>
  [raw.GH_TOKEN, raw.CLAUDE_CODE_OAUTH_TOKEN, raw.ANTHROPIC_API_KEY]

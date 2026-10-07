import { Cron } from 'croner'
import { z } from 'zod'
import { Redactor } from '../redact.js'
import { formatIssues, type ParseResult } from '../result.js'

/** Per-project config, read from `.backlog-runner.json` on the target repo's default branch. */

export const PROJECT_CONFIG_FILE = '.backlog-runner.json'

const cmd = z.array(z.string().min(1)).min(1, 'needs at least the program name')
const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'must be an UPPER_SNAKE env var name')
const ident = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a plain SQL identifier')
const version = z.string().regex(/^\d+(\.\d+)*$/, 'must be a version number like "16" or "7.2"')
/** Same token/key patterns the log redactor uses: this file is committed, so values must be dummies. */
const looksLikeCredential = (v: string) => new Redactor().string(v) !== v
const model = z.string().regex(/^[\w.[\]-]+$/, 'must be a model alias or id').default('sonnet')

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz })
    return true
  } catch {
    return false
  }
}
const isCron = (expr: string) => {
  try {
    new Cron(expr, { paused: true })
    return true
  } catch {
    return false
  }
}
const cron = z.string().refine(isCron, 'must be a valid cron expression').optional()

export const projectSchema = z
  .object({
    displayName: z.string().min(1).max(100),
    defaultBranch: z.string().min(1).optional(),
    install: cmd,
    gates: z.array(cmd).min(1),
    areas: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lower-kebab-case')).min(1),
    wip: z
      .object({
        proposalsInReview: z.number().int().min(1).default(3),
        prsInReview: z.number().int().min(1).default(3),
      })
      .strict()
      .prefault({}),
    maxFixAttempts: z.number().int().min(0).max(10).default(2),
    testServices: z
      .object({
        postgres: z
          .object({
            version,
            env: envName.default('DATABASE_URL'),
            database: ident.default('app_test'),
            schema: ident.default('public'),
            /** Also hand out the connection as separate variables, e.g. { "host": "DB_HOST", … }. */
            vars: z.object({ host: envName, port: envName, user: envName, password: envName, database: envName }).partial().strict().optional(),
          })
          .strict()
          .optional(),
        redis: z
          .object({
            version,
            env: envName.default('REDIS_URL'),
            vars: z.object({ host: envName, port: envName, password: envName }).partial().strict().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .prefault({}),
    /** Extra env for installs and gates. Names may be anything (APP_KEY, *_SECRET…); values must be dummies. */
    extraTestEnv: z
      .record(envName, z.string())
      .refine(
        r => !Object.values(r).some(looksLikeCredential),
        'a value looks like a real credential (token, API key, private key or URL password); this file is committed, so use dummy values',
      )
      .default({}),
    timezone: z.string().refine(isTimeZone, 'must be an IANA time zone').default('Europe/London'),
    schedule: z.object({ sync: cron, summary: cron, update: cron, cleanup: cron }).strict().prefault({}),
    allowedAuthors: z.array(z.string().regex(/^[A-Za-z0-9-]+(\[bot\])?$/, 'must be a GitHub login')).min(1),
    models: z
      .object({ propose: model, build: model, fix: model, triage: model, migrate: model })
      .strict()
      .prefault({}),
    claude: z
      .object({
        maxTurns: z.number().int().min(1).default(150),
        timeoutMin: z.number().int().min(1).default(90),
        extraAllowedTools: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .prefault({}),
  })
  .strict()

export type ProjectConfig = z.infer<typeof projectSchema>

/** `text` is the file content, or null when the file doesn't exist on the default branch. */
export function parseProjectConfig(text: string | null, branch = 'the default branch'): ParseResult<ProjectConfig> {
  if (text === null) {
    return { ok: false, errors: [`${PROJECT_CONFIG_FILE} not found on ${branch}. Run \`setup\` to open a PR that scaffolds it.`] }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e) {
    return { ok: false, errors: [`${PROJECT_CONFIG_FILE} is not valid JSON: ${(e as Error).message}`] }
  }
  const r = projectSchema.safeParse(json)
  return r.success
    ? { ok: true, value: r.data }
    : { ok: false, errors: formatIssues(r.error).map(e => `${PROJECT_CONFIG_FILE} ${e}`) }
}

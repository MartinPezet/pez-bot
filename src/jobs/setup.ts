import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PROJECT_CONFIG_FILE, type ProjectConfig } from '../config/project.js'
import { Digest, DigestSetupError } from '../digest/digest.js'
import type { GitHub } from '../github/client.js'
import { areaLabels, FIXED_LABELS } from '../github/labels.js'
import { kv } from '../state/db.js'
import type { JobResult, SysDeps } from './types.js'

export const SCAFFOLD_BRANCH = 'setup/scaffold'

export function configTemplate(repo: string): string {
  const [owner = 'OWNER', name = 'project'] = repo.split('/')
  return `${JSON.stringify(
    {
      displayName: name,
      install: ['pnpm', 'install', '--frozen-lockfile'],
      gates: [['pnpm', 'typecheck'], ['pnpm', 'lint'], ['pnpm', 'test']],
      areas: ['core'],
      wip: { proposalsInReview: 3, prsInReview: 3 },
      maxFixAttempts: 2,
      testServices: {
        postgres: { version: '16', env: 'DATABASE_URL', database: 'app_test', schema: 'public' },
        redis: { version: '7', env: 'REDIS_URL' },
      },
      timezone: 'Europe/London',
      allowedAuthors: [owner],
      models: { propose: 'sonnet', build: 'sonnet', fix: 'sonnet', triage: 'sonnet', migrate: 'sonnet' },
    },
    null,
    2,
  )}\n`
}

/** Project context for every spec and coding agent. TODOs are for the maintainer to fill in. */
export const CONTEXT_TEMPLATE = `# Project context, read by every spec and coding agent. Keep it short and current.
# Replace every TODO before the runner starts proposing work.

## What it is

TODO: one paragraph: what the product does, for whom, and what matters most (for example "data correctness beats features").

## Stack

- TODO: apps and packages, with paths (for example \`apps/web\`: Nuxt; \`apps/api\`: AdonisJS).
- TODO: databases, queues, caches.
- TODO: observability (tracing, error tracking) and deployment.

## Conventions

- TypeScript strict; no new \`any\`.
- TODO: where request validation happens.
- TODO: where shared API types live and how they're kept in sync.
- TODO: where heavy work runs (background jobs vs request handlers).

## Domain rules

- TODO: the rules an agent must never break (units, rounding, standards the product follows).

## Testing

- TODO: test frameworks per app, and how to run one test file.
- Every spec scenario maps to at least one test.
- Tests run against the local test Postgres/Redis, never shared environments.

## Off-limits for agents unless a task says so

\`.env*\`, secrets, deployment config, Dockerfiles, CI workflows, existing migrations, dependency upgrades.
`

const indent = (s: string) =>
  s
    .trimEnd()
    .split('\n')
    .map(l => (l ? `  ${l}` : ''))
    .join('\n')

export const openspecConfig = (context: string) => `schema: spec-driven\n\ncontext: |\n${indent(context)}\n`

/** Context is "filled in" when it exists and has no TODO left. */
export const contextFilled = (yaml: string) => /^context:/m.test(yaml) && !/TODO/.test(yaml)

export interface ScaffoldPlan {
  files: Record<string, string>
  notes: string[]
}

/** What the default branch is missing. Pure apart from reading files in the checkout. */
export function planScaffold(dir: string, repo: string): ScaffoldPlan {
  const files: Record<string, string> = {}
  const notes: string[] = []
  const has = (f: string) => existsSync(path.join(dir, f))
  if (!has(PROJECT_CONFIG_FILE)) files[PROJECT_CONFIG_FILE] = configTemplate(repo)
  if (!has('openspec')) {
    files['openspec/specs/.gitkeep'] = ''
    files['openspec/changes/.gitkeep'] = ''
  }
  const cfg = 'openspec/config.yaml'
  if (!has(cfg)) {
    // An existing legacy project.md becomes the context; otherwise the template.
    const legacy = has('openspec/project.md') ? readFileSync(path.join(dir, 'openspec/project.md'), 'utf8') : null
    files[cfg] = openspecConfig(legacy ?? CONTEXT_TEMPLATE)
    if (legacy) notes.push('Moved the context from `openspec/project.md` into `openspec/config.yaml`; check it, then delete project.md.')
  } else if (!contextFilled(readFileSync(path.join(dir, cfg), 'utf8'))) {
    notes.push('`openspec/config.yaml` has no `context:` or still contains TODOs: fill it in before going live.')
  }
  return { files, notes }
}

export interface SetupOptions {
  digestGh: GitHub
  project: ProjectConfig | null
  projectErrors: string[]
}

/**
 * Labels, Discussions checks and (if needed) one scaffolding PR. Safe to re-run: labels are
 * upserted and the scaffolding PR is reused while open. Returns a report for the CLI.
 */
export async function setup(d: SysDeps, o: SetupOptions): Promise<JobResult & { report: string[] }> {
  const report: string[] = []
  let problems = 0

  const labels = [...FIXED_LABELS, ...areaLabels(o.project?.areas ?? [])]
  const counts = { created: 0, updated: 0, unchanged: 0 }
  for (const l of labels) counts[await d.gh.upsertLabel(l)]++
  report.push(`✓ Labels on ${d.gh.repo}: ${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged`)
  if (!o.project) report.push('  (area: labels come from .backlog-runner.json; re-run setup once it is merged)')

  if (o.project) {
    const digest = new Digest({
      gh: o.digestGh, db: d.db, category: d.env.DIGEST_CATEGORY, title: o.project.displayName,
      autoCreate: d.env.DIGEST_AUTO_CREATE, tz: o.project.timezone, log: d.log,
    })
    try {
      await digest.resolveDiscussion()
      report.push(`✓ Digest: "${o.project.displayName}" in "${d.env.DIGEST_CATEGORY}" on ${o.digestGh.repo}`)
    } catch (e) {
      problems++
      report.push(`✗ Digest: ${e instanceof DigestSetupError ? e.message : (e as Error).message}`)
    }
  } else {
    problems++
    report.push(`✗ ${PROJECT_CONFIG_FILE}: ${o.projectErrors.join('; ') || 'missing'}`)
  }

  const dir = await d.wt.fresh(SCAFFOLD_BRANCH)
  const plan = planScaffold(dir, d.env.TARGET_REPO)
  for (const n of plan.notes) report.push(`! ${n}`)
  const names = Object.keys(plan.files)
  if (names.length) {
    for (const [f, content] of Object.entries(plan.files)) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
      writeFileSync(path.join(dir, f), content)
    }
    await d.wt.commit(dir, 'chore: scaffold backlog runner config', names)
    await d.wt.push(dir, SCAFFOLD_BRANCH)
    const pr = await d.gh.openPr({
      head: SCAFFOLD_BRANCH,
      base: d.branch,
      title: 'Set up the backlog runner',
      body:
        'Scaffolding for pez-bot. Review and edit before merging:\n\n' +
        names.map(f => `- \`${f}\``).join('\n') +
        `\n\nIn \`${PROJECT_CONFIG_FILE}\`, check the install and gate commands, the \`area\` list, the test service versions ` +
        '(match production) and `allowedAuthors`. In `openspec/config.yaml`, replace every TODO in `context`.\n\n' +
        'After merging, run `pez-bot setup` again to create the `area:` labels and check the digest.',
    })
    problems++
    report.push(`! Scaffolding PR: ${pr.url} (${names.join(', ')})`)
  } else report.push('✓ Repo has .backlog-runner.json and openspec/')

  const ok = problems === 0 && plan.notes.length === 0
  if (ok && !kv.get(d.db, 'setup.done')) {
    kv.set(d.db, 'setup.done', d.now().toISOString())
    d.digest.add('🎉', `First-run setup completed for ${d.gh.repo}`)
  }
  report.push(ok ? 'Setup complete.' : 'Setup incomplete: see the items above, then run setup again.')
  return { outcome: ok ? 'ok' : 'noop', detail: report.join('\n'), worktree: dir, report }
}

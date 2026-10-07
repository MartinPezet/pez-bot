import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseProjectConfig } from '../src/config/project.js'
import { applyMigration, migratePrd, MIGRATION_DIR, validateBacklog } from '../src/jobs/migrate.js'
import { configTemplate, contextFilled, planScaffold, setup } from '../src/jobs/setup.js'
import { FakeGitHub } from './fakes.js'
import { harness } from './jobs-harness.js'

const write = (dir: string, file: string, content: string) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  writeFileSync(path.join(dir, file), content)
}

describe('scaffolding', () => {
  it('the config template is valid project config', () => {
    const r = parseProjectConfig(configTemplate('acme/earthscope'))
    expect(r.ok).toBe(true)
    expect(r.ok && r.value).toMatchObject({ displayName: 'earthscope', allowedAuthors: ['acme'] })
  })

  it('plans every missing file on an empty repo', () => {
    const h = harness()
    const dir = path.join(h.root, 'empty')
    mkdirSync(dir)
    const plan = planScaffold(dir, 'acme/app')
    expect(Object.keys(plan.files).sort()).toEqual(['.backlog-runner.json', 'openspec/changes/.gitkeep', 'openspec/config.yaml', 'openspec/specs/.gitkeep'])
    expect(plan.files['openspec/config.yaml']).toMatch(/^schema: spec-driven\n\ncontext: \|\n {2}# Project context/)
  })

  it('moves a legacy project.md into config.yaml context', () => {
    const h = harness()
    const dir = path.join(h.root, 'legacy')
    write(dir, '.backlog-runner.json', '{}')
    write(dir, 'openspec/project.md', '# Context\n\nAll good.')
    const plan = planScaffold(dir, 'acme/app')
    expect(plan.files['openspec/config.yaml']).toBe('schema: spec-driven\n\ncontext: |\n  # Context\n\n  All good.\n')
    expect(plan.notes[0]).toMatch(/delete project.md/)
  })

  it('flags an unfilled context but never overwrites an existing config', () => {
    const h = harness()
    const dir = path.join(h.root, 'todo')
    write(dir, '.backlog-runner.json', '{}')
    write(dir, 'openspec/config.yaml', 'schema: spec-driven\ncontext: |\n  TODO: fill in\n')
    const plan = planScaffold(dir, 'acme/app')
    expect(plan.files).toEqual({})
    expect(plan.notes[0]).toMatch(/still contains TODOs/)
    expect(contextFilled('context: |\n  Done.\n')).toBe(true)
  })
})

describe('setup', () => {
  it('upserts labels, checks the digest and opens one scaffolding PR', async () => {
    const h = harness()
    const digestGh = new FakeGitHub('acme/digest')
    digestGh.discussion.threads.push({ id: 'D1', title: 'Demo' })
    h.wt.dirty = new Set<string>()
    const orig = h.wt.fresh.bind(h.wt)
    h.wt.fresh = async b => {
      const dir = await orig(b)
      h.wt.dirty.add(dir)
      return dir
    }
    const r = await setup(h.deps, { digestGh, project: h.deps.project, projectErrors: [] })
    expect(h.gh.labels.map(l => l.name)).toEqual(expect.arrayContaining(['state:inbox', 'urgent', 'area:core', 'area:ui']))
    expect(r.report[0]).toMatch(/Labels on acme\/app: 22 created/)
    expect(r.report).toContain('✓ Digest: "Demo" in "Daily Digest" on acme/digest')
    expect(h.gh.prs[0]).toMatchObject({ headRefName: 'setup/scaffold', title: 'Set up the backlog runner' })
    expect(r.outcome).toBe('noop')

    const again = await setup(h.deps, { digestGh, project: h.deps.project, projectErrors: [] })
    expect(again.report[0]).toMatch(/0 created, 0 updated, 22 unchanged/)
    expect(h.gh.prs).toHaveLength(1)
  })

  it('completes, once, when everything is in place', async () => {
    const h = harness()
    const digestGh = new FakeGitHub('acme/digest')
    digestGh.discussion.threads.push({ id: 'D1', title: 'Demo' })
    const orig = h.wt.fresh.bind(h.wt)
    h.wt.fresh = async b => {
      const dir = await orig(b)
      write(dir, '.backlog-runner.json', '{}')
      write(dir, 'openspec/config.yaml', 'schema: spec-driven\ncontext: |\n  Filled in.\n')
      return dir
    }
    const r = await setup(h.deps, { digestGh, project: h.deps.project, projectErrors: [] })
    expect(r.outcome).toBe('ok')
    expect(h.digest.events.map(e => e.emoji)).toEqual(['🎉'])
    await setup(h.deps, { digestGh, project: h.deps.project, projectErrors: [] })
    expect(h.digest.events).toHaveLength(1)
  })

  it('reports the exact digest problem and a missing project config', async () => {
    const h = harness()
    const digestGh = new FakeGitHub('acme/digest')
    const r = await setup(h.deps, { digestGh, project: h.deps.project, projectErrors: [] })
    expect(r.report.join('\n')).toMatch(/✗ Digest: Create a discussion titled "Demo"/)
    const none = await setup(h.deps, { digestGh, project: null, projectErrors: ['.backlog-runner.json not found on main.'] })
    expect(none.report.join('\n')).toMatch(/✗ \.backlog-runner\.json: \.backlog-runner\.json not found on main\./)
  })
})

describe('PRD migration', () => {
  const items = [
    { title: 'Render water strikes', body: 'b', type: 'feature', area: ['core'], priority: 'p1', source: 'Logs' },
    { title: 'Export CSV', body: 'b', type: 'feature', area: ['ui'], priority: 'p2' },
  ]

  it('validates types, areas and duplicate titles', () => {
    expect(validateBacklog(items, ['core', 'ui']).errors).toEqual([])
    expect(validateBacklog([{ ...items[0], area: ['billing'] }], ['core']).errors[0]).toMatch(/billing not in the project's areas/)
    expect(validateBacklog([items[0], items[0]], ['core', 'ui']).errors[0]).toMatch(/duplicate/)
    expect(validateBacklog([{ ...items[0], type: 'epic' }], ['core']).errors[0]).toMatch(/^0\.type/)
  })

  it('opens a PR with only the migration files', async () => {
    const h = harness()
    const orig = h.wt.fresh.bind(h.wt)
    h.wt.fresh = async b => {
      const dir = await orig(b)
      write(dir, 'PRD.md', '# PRD')
      return dir
    }
    h.claude.then(req => {
      write(req.cwd, `${MIGRATION_DIR}/backlog.json`, JSON.stringify(items))
      write(req.cwd, `${MIGRATION_DIR}/skipped.md`, '- none')
      h.wt.dirty.add(req.cwd)
      return { text: 'feature 2' }
    })
    const r = await migratePrd(h.deps, { prdPath: 'PRD.md', ignoreBudget: false })
    expect(r.outcome).toBe('ok')
    expect(h.claude.calls[0]?.allowedTools).not.toContain('Bash(git commit *)')
    expect([...h.wt.commits.values()].flat()).toEqual([`chore: PRD backlog migration [${MIGRATION_DIR}]`])
    expect(h.gh.prs[0]).toMatchObject({ headRefName: 'migration/prd', title: 'Backlog migration from PRD.md' })
    expect(h.digest.events[0]?.text).toBe('PRD migration PR opened (2 items)')
  })

  it('applies the merged backlog idempotently', async () => {
    const h = harness()
    h.gh.addIssue({ number: 1, title: 'Export CSV' })
    const orig = h.wt.fresh.bind(h.wt)
    h.wt.fresh = async b => {
      const dir = await orig(b)
      write(dir, `${MIGRATION_DIR}/backlog.json`, JSON.stringify(items))
      return dir
    }
    expect(await applyMigration(h.deps)).toMatchObject({ outcome: 'ok', detail: '1 created, 1 skipped (already exist)' })
    const created = h.gh.issues.find(i => i.title === 'Render water strikes')
    expect(created?.labels).toEqual(['state:inbox', 'type:feature', 'priority:p1', 'area:core'])
    expect(created?.body).toContain('Migrated from the PRD § Logs')
    expect(await applyMigration(h.deps)).toMatchObject({ outcome: 'noop' })
  })

  it('refuses to apply before the migration PR is merged', async () => {
    const h = harness()
    expect((await applyMigration(h.deps)).detail).toMatch(/merge the migration PR first/)
  })

  it('refuses a missing PRD', async () => {
    const h = harness()
    expect((await migratePrd(h.deps, { prdPath: 'PRD.md', ignoreBudget: true })).detail).toBe('PRD.md not found on main')
    expect(h.claude.calls).toHaveLength(0)
  })
})

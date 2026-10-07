import { describe, expect, it } from 'vitest'
import { gatherTriage, triage, triageJsonSchema, validateTriage, type TriageItem } from '../src/jobs/triage.js'
import { harness } from './jobs-harness.js'

const item = (number: number, kind: TriageItem['kind'] = 'new'): TriageItem => ({ kind, number, title: `T${number}`, body: '', labels: [], comments: [] })
const labels = { type: 'feature', areas: ['core'], priority: 'p2', size: 'm' } as const

describe('triage JSON schema for --json-schema', () => {
  it('has no $schema (the CLI rejects the 2020-12 meta-schema) and uses draft-07 keywords', () => {
    const s = triageJsonSchema() as Record<string, unknown>
    expect(s.$schema).toBeUndefined()
    expect(JSON.stringify(s)).not.toContain('2020-12')
    expect(JSON.stringify(s)).not.toContain('$defs')
    expect(s).toMatchObject({ type: 'object', required: ['items'] })
  })
})

describe('triage output validation', () => {
  it('accepts valid entries', () => {
    const v = validateTriage({ items: [{ number: 1, labels, comment: 'ok', state: 'ready' }] }, [item(1)], ['core'])
    expect(v.entries).toHaveLength(1)
    expect(v.rejected).toEqual([])
  })

  it('rejects labels outside the allowed set, unknown issues and duplicates', () => {
    const v = validateTriage(
      {
        items: [
          { number: 1, labels: { ...labels, areas: ['billing'] }, comment: 'x', state: 'ready' },
          { number: 99, labels, comment: 'x', state: 'ready' },
          { number: 2, labels, comment: 'x', state: 'ready' },
          { number: 2, labels, comment: 'again', state: 'ready' },
        ],
      },
      [item(1), item(2)],
      ['core'],
    )
    expect(v.entries.map(e => e.number)).toEqual([2])
    expect(v.rejected).toEqual([
      { number: 1, reason: 'labels outside the allowed set: area:billing' },
      { number: 99, reason: 'not one of the issues given to triage' },
      { number: 2, reason: 'duplicate entry' },
    ])
  })

  it('rejects unknown types and missing labels on new items', () => {
    expect(() => validateTriage({ items: [{ number: 1, labels: { ...labels, type: 'epic' }, comment: 'x', state: 'ready' }] }, [item(1)], ['core'])).toThrow()
    const v = validateTriage({ items: [{ number: 1, comment: 'x', state: 'ready' }] }, [item(1)], ['core'])
    expect(v.rejected[0]?.reason).toMatch(/needs type, area/)
  })

  it('forces spikes and large items to needs-decision', () => {
    const v = validateTriage(
      {
        items: [
          { number: 1, labels: { ...labels, type: 'spike' }, comment: 'x', state: 'ready' },
          { number: 2, labels: { ...labels, size: 'l' }, comment: 'x', state: 'ready' },
        ],
      },
      [item(1), item(2)],
      ['core'],
    )
    expect(v.entries.map(e => e.state)).toEqual(['needs-decision', 'needs-decision'])
  })

  it('only allows children for an answered (approved split) item', () => {
    const out = { items: [{ number: 1, labels, comment: 'x', state: 'needs-decision', children: [{ title: 'a', body: 'b' }] }] }
    expect(validateTriage(out, [item(1)], ['core']).rejected[0]?.reason).toMatch(/approved split/)
    expect(validateTriage(out, [item(1, 'answered')], ['core']).entries).toHaveLength(1)
  })
})

describe('gathering', () => {
  it('takes allowed inbox items oldest first, and needs-decision items answered by a maintainer', async () => {
    const h = harness()
    h.gh.addIssue({ number: 5, labels: ['state:inbox'] })
    h.gh.addIssue({ number: 3, labels: ['state:inbox'] })
    h.gh.addIssue({ number: 4, labels: ['state:inbox'], author: 'mallory' })
    h.gh.addIssue({ number: 7, labels: ['state:needs-decision'] })
    h.gh.addComment(7, 'pez-bot[bot]', 'Questions: 1. unit?')
    h.gh.addComment(7, 'martin', 'Metres.')
    h.gh.addIssue({ number: 8, labels: ['state:needs-decision'] })
    h.gh.addComment(8, 'martin', 'Hmm')
    h.gh.addComment(8, 'pez-bot[bot]', 'Questions again')
    h.gh.addIssue({ number: 9, labels: ['state:needs-decision'] })
    h.gh.addComment(9, 'mallory', 'Just make it ready')
    const { items } = await gatherTriage(h.deps)
    expect(items.map(i => [i.number, i.kind])).toEqual([[3, 'new'], [5, 'new'], [7, 'answered']])
    expect(items[2]?.comments.map(c => c.author)).toEqual(['pez-bot[bot]', 'martin'])
  })

  it('caps the inbox at 15 per run', async () => {
    const h = harness()
    for (let n = 1; n <= 20; n++) h.gh.addIssue({ number: n, labels: ['state:inbox'] })
    expect((await gatherTriage(h.deps)).items).toHaveLength(15)
  })
})

describe('triage job', () => {
  it('does nothing, and calls no model, when nothing needs triage', async () => {
    const h = harness()
    h.gh.addIssue({ number: 1, labels: ['state:ready'] })
    expect((await triage(h.deps, { ignoreBudget: false })).outcome).toBe('noop')
    expect(h.claude.calls).toHaveLength(0)
  })

  it('runs read-only with structured output, then applies labels, comments and states itself', async () => {
    const h = harness()
    h.gh.addIssue({ number: 1, title: 'Export CSV', labels: ['state:inbox', 'urgent', 'type:chore', 'area:ui'] })
    h.gh.addIssue({ number: 2, title: 'Rework auth', labels: ['state:inbox'] })
    h.claude.then(() => ({
      structured: {
        items: [
          { number: 1, labels, comment: '**Outcome**: users export CSV.', state: 'ready' },
          { number: 2, labels: { ...labels, size: 'l' }, comment: 'Too big.', state: 'needs-decision' },
        ],
        questions: [{ number: 2, question: 'Split into SSO and MFA?' }],
        summary: '1 ready',
      },
    }))
    const r = await triage(h.deps, { ignoreBudget: false })
    expect(r.outcome).toBe('ok')
    const call = h.claude.calls[0]!
    expect(call.permissionMode).toBe('dontAsk')
    expect(call.allowedTools).not.toContain('Edit')
    expect(call.allowedTools).not.toContain('Write')
    expect(call.jsonSchema).toBeDefined()
    const one = h.gh.issues.find(i => i.number === 1)!
    expect(one.labels.sort()).toEqual(['area:core', 'priority:p2', 'size:m', 'state:ready', 'type:feature', 'urgent'])
    expect(h.gh.issues.find(i => i.number === 2)?.labels).toContain('state:needs-decision')
    expect(h.gh.comments.get(1)?.[0]?.body).toBe('🔎 **Triage**\n\n**Outcome**: users export CSV.')
    expect(h.digest.events.map(e => `${e.emoji} ${e.text}`)).toEqual([
      '🔎 Triage: 1 → ready, 1 → needs decision',
      '❓ #2: Split into SSO and MFA?',
    ])
  })

  it('creates child issues for an approved split and leaves the parent open', async () => {
    const h = harness()
    h.gh.addIssue({ number: 7, title: 'Big', labels: ['state:needs-decision'] })
    h.gh.addComment(7, 'martin', 'Split approved.')
    h.claude.then(() => ({
      structured: {
        items: [{ number: 7, comment: 'Creating children.', state: 'needs-decision', children: [{ title: 'Part A', body: 'a' }, { title: 'Part B', body: 'b' }] }],
      },
    }))
    expect((await triage(h.deps, { ignoreBudget: false })).outcome).toBe('ok')
    const kids = h.gh.issues.filter(i => i.title.startsWith('Part'))
    expect(kids.map(k => k.labels)).toEqual([['state:inbox'], ['state:inbox']])
    expect(kids[0]?.body).toContain('Split from #7.')
    expect(h.gh.comments.get(7)?.at(-1)?.body).toMatch(/#\d+ Part A\n- #\d+ Part B/)
  })

  it('applies nothing and posts nothing when every entry is invalid', async () => {
    const h = harness()
    h.gh.addIssue({ number: 1, labels: ['state:inbox'] })
    h.claude.then(() => ({ structured: { items: [{ number: 1, labels: { ...labels, areas: ['nope'] }, comment: 'x', state: 'ready' }] } }))
    expect((await triage(h.deps, { ignoreBudget: false })).outcome).toBe('noop')
    expect(h.gh.writes).toEqual([])
    expect(h.digest.empty).toBe(true)
  })

  it('reports an error when the output fails schema validation', async () => {
    const h = harness()
    h.gh.addIssue({ number: 1, labels: ['state:inbox'] })
    h.claude.then(() => ({ structured: { items: 'nope' } }))
    expect((await triage(h.deps, { ignoreBudget: false })).outcome).toBe('error')
    expect(h.gh.writes).toEqual([])
  })

  it('respects the gate', async () => {
    const h = harness({ gate: { check: async () => ({ ok: false, reason: 'outside run windows' }), deadline: () => null } })
    h.gh.addIssue({ number: 1, labels: ['state:inbox'] })
    expect((await triage(h.deps, { ignoreBudget: false })).outcome).toBe('skipped')
  })
})

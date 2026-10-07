import { describe, expect, it } from 'vitest'
import { sync } from '../src/jobs/sync.js'
import { kv } from '../src/state/db.js'
import { harness } from './jobs-harness.js'

describe('sync: recovery', () => {
  it('requeues issues left mid-job by a dead run', async () => {
    const h = harness()
    h.gh.addIssue({ number: 1, labels: ['state:proposing'] })
    h.gh.addIssue({ number: 2, labels: ['state:building'] })
    const r = await sync(h.deps)
    expect(r.outcome).toBe('ok')
    expect(h.gh.issues.find(i => i.number === 1)?.labels).toEqual(['state:ready'])
    expect(h.gh.issues.find(i => i.number === 2)?.labels).toEqual(['state:approved'])
    expect(h.gh.writes.some(w => w.startsWith('comment #2: ♻️'))).toBe(true)
    expect(h.digest.events.map(e => e.emoji)).toEqual(['♻️', '♻️'])
  })

  it('blocks an issue interrupted twice within 24 hours', async () => {
    const h = harness()
    kv.setJson(h.db, 'recovered.1', ['2026-10-05T01:00:00Z'])
    h.gh.addIssue({ number: 1, labels: ['state:building'] })
    await sync(h.deps)
    expect(h.gh.issues[0]?.labels).toEqual(['state:blocked'])
    expect(h.digest.events[0]?.emoji).toBe('🚧')
  })

  it('forgets interruptions older than 24 hours', async () => {
    const h = harness()
    kv.setJson(h.db, 'recovered.1', ['2026-10-03T01:00:00Z'])
    h.gh.addIssue({ number: 1, labels: ['state:building'] })
    await sync(h.deps)
    expect(h.gh.issues[0]?.labels).toEqual(['state:approved'])
  })
})

describe('sync: proposal promotion', () => {
  it('merged proposal → approved; closed → needs-decision with a comment; open → unchanged', async () => {
    const h = harness()
    h.gh.addIssue({ number: 1, labels: ['state:proposal-review'] })
    h.gh.addIssue({ number: 2, labels: ['state:proposal-review'] })
    h.gh.addIssue({ number: 3, labels: ['state:proposal-review'] })
    h.gh.addPr({ number: 10, headRefName: 'proposal/issue-1-x', state: 'MERGED' })
    h.gh.addPr({ number: 11, headRefName: 'proposal/issue-2-x', state: 'CLOSED' })
    h.gh.addPr({ number: 12, headRefName: 'proposal/issue-3-x', state: 'OPEN' })
    await sync(h.deps)
    expect(h.gh.issues.map(i => i.labels[0])).toEqual(['state:approved', 'state:needs-decision', 'state:proposal-review'])
    expect(h.gh.writes.filter(w => w.startsWith('comment'))).toEqual([expect.stringContaining('comment #2: Proposal')])
    expect(h.digest.events.map(e => e.emoji)).toEqual(['✅', '❌'])
  })

  it('uses the newest proposal PR for the issue', async () => {
    const h = harness()
    h.gh.addIssue({ number: 1, labels: ['state:proposal-review'] })
    h.gh.addPr({ number: 10, headRefName: 'proposal/issue-1-old', state: 'CLOSED' })
    h.gh.addPr({ number: 20, headRefName: 'proposal/issue-1-new', state: 'MERGED' })
    h.gh.addPr({ number: 30, headRefName: 'proposal/issue-11-other', state: 'CLOSED' })
    await sync(h.deps)
    expect(h.gh.issues[0]?.labels).toEqual(['state:approved'])
  })

  it('does nothing (noop) when nothing changed', async () => {
    const h = harness()
    h.gh.addIssue({ number: 1, labels: ['state:ready'] })
    expect((await sync(h.deps)).outcome).toBe('noop')
    expect(h.gh.writes).toEqual([])
    expect(h.digest.empty).toBe(true)
  })
})

describe('sync: author allowlist', () => {
  it('never touches issues from other authors, and notes each once', async () => {
    const h = harness()
    h.gh.addIssue({ number: 5, author: 'mallory', labels: ['state:building'] })
    h.gh.addIssue({ number: 6, author: 'mallory', labels: [] })
    await sync(h.deps)
    await sync(h.deps)
    expect(h.gh.issues[0]?.labels).toEqual(['state:building'])
    expect(h.digest.events.map(e => e.text)).toEqual(['Ignoring #5: @mallory is not in allowedAuthors'])
  })
})

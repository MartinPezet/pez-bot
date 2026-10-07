import { describe, expect, it } from 'vitest'
import { BLOCK_HEADER, buildSummary, summary } from '../src/jobs/summary.js'
import { FakeGitHub } from './fakes.js'
import { harness } from './jobs-harness.js'

const now = new Date('2026-10-05T06:30:00Z')

describe('buildSummary', () => {
  it('returns null when nothing needs attention', () => {
    const g = new FakeGitHub()
    const issues = [g.addIssue({ number: 1, labels: ['state:ready'] })]
    expect(buildSummary({ issues, prs: [], blocked: new Map(), now })).toBeNull()
  })

  it('lists what needs review, blocked reasons, questions, shipped work and counts', () => {
    const g = new FakeGitHub()
    const issues = [
      g.addIssue({ number: 1, title: 'A', labels: ['state:pr-review'] }),
      g.addIssue({ number: 2, title: 'B', labels: ['state:proposal-review'] }),
      g.addIssue({ number: 3, title: 'C', labels: ['state:blocked'] }),
      g.addIssue({ number: 4, title: 'D', labels: ['state:needs-decision'] }),
      g.addIssue({ number: 5, title: 'E', labels: ['state:ready'] }),
    ]
    const prs = [
      g.addPr({ number: 10, headRefName: 'change/issue-1', createdAt: '2026-10-04T00:00:00Z' }),
      g.addPr({ number: 11, headRefName: 'proposal/issue-2-b', createdAt: '2026-10-04T00:00:00Z' }),
      g.addPr({ number: 12, headRefName: 'change/issue-40', title: 'Shipped thing', state: 'MERGED', mergedAt: '2026-10-04T20:00:00Z' }),
      g.addPr({ number: 13, headRefName: 'change/issue-41', state: 'MERGED', mergedAt: '2026-10-01T20:00:00Z' }),
    ]
    const md = buildSummary({ issues, prs, blocked: new Map([[3, { reason: 'Gates still failing', times: 1 }]]), now }) ?? ''
    expect(md).toContain('🔍 PR to review: [#10]')
    expect(md).toContain('📝 Proposal to review: [#11]')
    expect(md).toContain('🚧 Blocked: [#3](https://github.com/acme/app/issues/3) C: Gates still failing')
    expect(md).toContain('❓ Waiting on you: [#4]')
    expect(md).toContain('✅ [#12](https://github.com/acme/app/pull/12) Shipped thing')
    expect(md).not.toContain('#13')
    expect(md).toContain('**Pipeline**: inbox 0 · needs-decision 1 · ready 1 · proposing 0 · proposal-review 1 · approved 0 · building 0 · pr-review 1 · blocked 1')
    expect(md).not.toContain('**Flags**')
  })

  it('flags repeat blocks, stale PRs and an idle runner', () => {
    const g = new FakeGitHub()
    const issues = [g.addIssue({ number: 3, labels: ['state:blocked'] })]
    const prs = [g.addPr({ number: 10, headRefName: 'change/issue-9', createdAt: '2026-10-01T00:00:00Z' })]
    const md = buildSummary({ issues, prs, blocked: new Map([[3, { reason: 'x', times: 2 }]]), now }) ?? ''
    expect(md).toContain('#3 has been blocked 2 times.')
    expect(md).toContain('[#10](https://github.com/acme/app/pull/10) has been open for 4 days.')
    expect(md).toContain('The ready queue is empty, so the runner is idle.')
  })
})

describe('summary job', () => {
  it('reads block reasons from the runner’s own comments only', async () => {
    const h = harness({ now })
    h.gh.addIssue({ number: 3, title: 'C', labels: ['state:blocked'] })
    h.gh.addComment(3, 'pez-bot[bot]', `${BLOCK_HEADER}\n\nGates still failing after 2 fix attempts:\n\`\`\`\nlog\n\`\`\``)
    h.gh.addComment(3, 'mallory', `${BLOCK_HEADER}\n\nfake`)
    expect((await summary(h.deps)).outcome).toBe('ok')
    const md = h.digest.sections[0] ?? ''
    expect(md).toContain('C: Gates still failing after 2 fix attempts:')
    expect(md).not.toContain('blocked 2 times')
  })

  it('posts nothing when there is nothing to say', async () => {
    const h = harness({ now })
    h.gh.addIssue({ number: 1, labels: ['state:ready'] })
    expect((await summary(h.deps)).outcome).toBe('noop')
    expect(h.digest.empty).toBe(true)
  })
})

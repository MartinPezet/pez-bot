import type { DiscussionLookup, GitHub, Issue, IssueComment, LabelSpec, PullRequest } from '../src/github/client.js'
import { GraphQLError } from '../src/github/client.js'

/** In-memory GitHub for unit tests. `writes` is a readable log of every write call. */
export class FakeGitHub implements GitHub {
  dryRun = false
  issues: Issue[] = []
  comments = new Map<number, IssueComment[]>()
  prs: PullRequest[] = []
  labels: LabelSpec[] = []
  writes: string[] = []
  discussion = {
    enabled: true,
    categories: [{ id: 'CAT1', name: 'Daily Digest' }],
    threads: [] as { id: string; title: string }[],
    comments: [] as { id: string; discussionId: string; body: string; replyTo?: string | undefined }[],
    deleted: new Set<string>(),
  }
  private seq = 100

  constructor(readonly repo = 'acme/app') {}

  addIssue(p: Partial<Issue> & { number: number }): Issue {
    const i: Issue = {
      title: `Issue ${p.number}`,
      body: '',
      labels: [],
      author: 'martin',
      createdAt: '2026-10-01T00:00:00Z',
      url: `https://github.com/${this.repo}/issues/${p.number}`,
      ...p,
    }
    this.issues.push(i)
    return i
  }

  addPr(p: Partial<PullRequest> & { number: number; headRefName: string }): PullRequest {
    const pr: PullRequest = {
      title: `PR ${p.number}`,
      state: 'OPEN',
      url: `https://github.com/${this.repo}/pull/${p.number}`,
      isDraft: false,
      createdAt: '2026-10-01T00:00:00Z',
      mergedAt: null,
      closedAt: null,
      ...p,
    }
    this.prs.push(pr)
    return pr
  }

  addComment(n: number, author: string, body: string, createdAt = '2026-10-02T00:00:00Z'): void {
    const list = this.comments.get(n) ?? []
    list.push({ id: this.seq++, author, body, createdAt })
    this.comments.set(n, list)
  }

  async listIssues(label?: string) {
    return this.issues.filter(i => !label || i.labels.includes(label)).map(i => ({ ...i, labels: [...i.labels] }))
  }
  async allIssueTitles() {
    return this.issues.map(i => i.title)
  }
  async issueComments(n: number) {
    return this.comments.get(n) ?? []
  }
  async listPrs() {
    return [...this.prs].sort((a, b) => b.number - a.number)
  }
  async listLabels() {
    return this.labels
  }
  private find(n: number) {
    const i = this.issues.find(x => x.number === n)
    if (!i) throw new Error(`no issue ${n}`)
    return i
  }
  async addLabels(n: number, labels: string[]) {
    this.writes.push(`label #${n} +${labels.join(',')}`)
    const i = this.find(n)
    i.labels = [...new Set([...i.labels, ...labels])]
  }
  async removeLabel(n: number, label: string) {
    this.writes.push(`label #${n} -${label}`)
    const i = this.find(n)
    i.labels = i.labels.filter(l => l !== label)
  }
  async comment(n: number, body: string) {
    this.writes.push(`comment #${n}: ${body.split('\n')[0]}`)
    this.addComment(n, 'pez-bot[bot]', body)
  }
  async createIssue(p: { title: string; body: string; labels: string[] }) {
    const number = this.seq++
    this.writes.push(`create issue #${number}: ${p.title} [${p.labels.join(',')}]`)
    this.addIssue({ number, title: p.title, body: p.body, labels: p.labels, author: 'pez-bot[bot]' })
    return { number, url: `https://github.com/${this.repo}/issues/${number}` }
  }
  async openPr(p: { head: string; base: string; title: string; body: string; draft?: boolean }) {
    const existing = this.prs.find(x => x.headRefName === p.head && x.state === 'OPEN')
    if (existing) return { number: existing.number, url: existing.url }
    const number = this.seq++
    this.writes.push(`open ${p.draft ? 'draft ' : ''}PR #${number} ${p.head}: ${p.title}`)
    const pr = this.addPr({ number, headRefName: p.head, title: p.title, isDraft: p.draft ?? false, createdAt: new Date().toISOString() })
    return { number, url: pr.url }
  }
  async upsertLabel(l: LabelSpec) {
    const cur = this.labels.find(x => x.name === l.name)
    if (!cur) {
      this.labels.push({ ...l })
      this.writes.push(`label created ${l.name}`)
      return 'created' as const
    }
    if (cur.color === l.color && cur.description === l.description) return 'unchanged' as const
    Object.assign(cur, l)
    this.writes.push(`label updated ${l.name}`)
    return 'updated' as const
  }
  async findDiscussion(category: string, title: string): Promise<DiscussionLookup> {
    const cat = this.discussion.categories.find(c => c.name === category)
    const t = cat && this.discussion.threads.find(x => x.title === title && !this.discussion.deleted.has(x.id))
    return { repositoryId: 'REPO1', discussionsEnabled: this.discussion.enabled, categoryId: cat?.id ?? null, discussionId: t?.id ?? null }
  }
  async createDiscussion(_repo: string, _cat: string, title: string, _body: string) {
    const id = `D${this.seq++}`
    this.writes.push(`create discussion ${title}`)
    this.discussion.threads.push({ id, title })
    return id
  }
  async addDiscussionComment(discussionId: string, body: string, replyToId?: string) {
    if (this.discussion.deleted.has(discussionId) || (replyToId && this.discussion.deleted.has(replyToId))) {
      throw new GraphQLError(['NOT_FOUND'], `Could not resolve to a node with the global id of '${replyToId ?? discussionId}'`)
    }
    const id = `DC${this.seq++}`
    this.discussion.comments.push({ id, discussionId, body, replyTo: replyToId })
    this.writes.push(`discussion ${replyToId ? `reply to ${replyToId}` : 'comment'}: ${body.split('\n')[0]}`)
    return id
  }
}

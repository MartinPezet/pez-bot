import type { Logger } from '../log.js'
import type { DiscussionLookup, GitHub, Issue, IssueComment, LabelSpec, PullRequest } from './client.js'

export interface Intent {
  action: string
  args: Record<string, unknown>
}

/**
 * DRY_RUN=1: reads go to GitHub as normal; every write is logged and recorded instead.
 * Returned ids are placeholders, and callers must not cache them (`dryRun` is true).
 */
export class DryRunGitHub implements GitHub {
  readonly dryRun = true
  readonly intents: Intent[] = []
  private nextNumber = 900_000

  constructor(
    private readonly inner: GitHub,
    private readonly log?: Logger,
  ) {}

  get repo() {
    return this.inner.repo
  }

  private record(action: string, args: Record<string, unknown>) {
    this.intents.push({ action, args })
    this.log?.info({ repo: this.inner.repo, action, ...args }, `dry-run: would ${action}`)
  }

  listIssues(label?: string): Promise<Issue[]> {
    return this.inner.listIssues(label)
  }
  allIssueTitles(): Promise<string[]> {
    return this.inner.allIssueTitles()
  }
  issueComments(n: number): Promise<IssueComment[]> {
    return this.inner.issueComments(n)
  }
  listPrs(): Promise<PullRequest[]> {
    return this.inner.listPrs()
  }
  listLabels(): Promise<LabelSpec[]> {
    return this.inner.listLabels()
  }
  findDiscussion(category: string, title: string): Promise<DiscussionLookup> {
    return this.inner.findDiscussion(category, title)
  }

  async addLabels(n: number, labels: string[]) {
    this.record('add labels', { issue: n, labels })
  }
  async removeLabel(n: number, label: string) {
    this.record('remove label', { issue: n, label })
  }
  async comment(n: number, body: string) {
    this.record('comment', { issue: n, body })
  }
  async createIssue(i: { title: string; body: string; labels: string[] }) {
    this.record('create issue', i)
    const number = this.nextNumber++
    return { number, url: `(dry-run issue ${number})` }
  }
  async openPr(p: { head: string; base: string; title: string; body: string; draft?: boolean }) {
    this.record('open PR', p)
    const number = this.nextNumber++
    return { number, url: `(dry-run PR from ${p.head})` }
  }
  async upsertLabel(l: LabelSpec) {
    this.record('upsert label', { ...l })
    return 'unchanged' as const
  }
  async createDiscussion(repositoryId: string, categoryId: string, title: string, body: string) {
    this.record('create discussion', { repositoryId, categoryId, title, body })
    return 'dry-run-discussion'
  }
  async addDiscussionComment(discussionId: string, body: string, replyToId?: string) {
    this.record('add discussion comment', { discussionId, replyToId, body })
    return 'dry-run-comment'
  }
}

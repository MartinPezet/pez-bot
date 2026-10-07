import { redactor } from '../redact.js'
import type { TokenProvider } from './auth.js'

export type PrState = 'OPEN' | 'CLOSED' | 'MERGED'

export interface Issue {
  number: number
  title: string
  body: string
  labels: string[]
  author: string
  createdAt: string
  url: string
}

export interface IssueComment {
  id: number
  author: string
  body: string
  createdAt: string
}

export interface PullRequest {
  number: number
  title: string
  state: PrState
  headRefName: string
  url: string
  isDraft: boolean
  createdAt: string
  mergedAt: string | null
  closedAt: string | null
}

export interface LabelSpec {
  name: string
  color: string
  description: string
}

export interface DiscussionLookup {
  repositoryId: string
  discussionsEnabled: boolean
  categoryId: string | null
  discussionId: string | null
}

/**
 * Everything the runner does on GitHub. One instance per repository. All writes go through
 * here, so the dry-run decorator can intercept them and bodies are redacted in one place.
 */
export interface GitHub {
  readonly repo: string
  readonly dryRun: boolean
  /** Open issues (PRs excluded), optionally with a label. */
  listIssues(label?: string): Promise<Issue[]>
  /** Titles of every issue, open or closed, for idempotent creation. */
  allIssueTitles(): Promise<string[]>
  issueComments(n: number): Promise<IssueComment[]>
  /** PRs in every state, newest first. */
  listPrs(): Promise<PullRequest[]>
  listLabels(): Promise<LabelSpec[]>
  addLabels(n: number, labels: string[]): Promise<void>
  removeLabel(n: number, label: string): Promise<void>
  comment(n: number, body: string): Promise<void>
  createIssue(i: { title: string; body: string; labels: string[] }): Promise<{ number: number; url: string }>
  /** Opens a PR, or returns the open PR that already exists for the branch. */
  openPr(p: { head: string; base: string; title: string; body: string; draft?: boolean }): Promise<{ number: number; url: string }>
  upsertLabel(l: LabelSpec): Promise<'created' | 'updated' | 'unchanged'>
  findDiscussion(category: string, title: string): Promise<DiscussionLookup>
  createDiscussion(repositoryId: string, categoryId: string, title: string, body: string): Promise<string>
  addDiscussionComment(discussionId: string, body: string, replyToId?: string): Promise<string>
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export class GraphQLError extends Error {
  constructor(
    readonly types: string[],
    message: string,
  ) {
    super(message)
  }
  get notFound(): boolean {
    return this.types.includes('NOT_FOUND') || /could not resolve to a node/i.test(this.message)
  }
}

const API = 'https://api.github.com'

interface RestIssue {
  number: number
  title: string
  body: string | null
  labels: ({ name: string } | string)[]
  user: { login: string } | null
  created_at: string
  html_url: string
  pull_request?: unknown
}
interface RestPull {
  number: number
  title: string
  state: 'open' | 'closed'
  merged_at: string | null
  closed_at: string | null
  created_at: string
  draft?: boolean
  html_url: string
  head: { ref: string }
}

const toIssue = (i: RestIssue): Issue => ({
  number: i.number,
  title: i.title,
  body: i.body ?? '',
  labels: i.labels.map(l => (typeof l === 'string' ? l : l.name)),
  author: i.user?.login ?? 'ghost',
  createdAt: i.created_at,
  url: i.html_url,
})

export const toPr = (p: RestPull): PullRequest => ({
  number: p.number,
  title: p.title,
  state: p.merged_at ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED',
  headRefName: p.head.ref,
  url: p.html_url,
  isDraft: p.draft ?? false,
  createdAt: p.created_at,
  mergedAt: p.merged_at,
  closedAt: p.closed_at,
})

const nextLink = (link: string | null) => link?.match(/<([^>]+)>;\s*rel="next"/)?.[1]

export class HttpGitHub implements GitHub {
  readonly dryRun = false
  private readonly owner: string
  private readonly name: string

  constructor(
    readonly repo: string,
    private readonly tokens: TokenProvider,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    const [owner = '', name = ''] = repo.split('/')
    this.owner = owner
    this.name = name
  }

  private async request(method: string, url: string, body?: unknown): Promise<Response> {
    const res = await this.fetchFn(url.startsWith('http') ? url : `${API}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.tokens.token()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'pez-bot',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return res
  }

  private async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, body)
    if (!res.ok) throw new GitHubError(res.status, `${method} ${path} → ${res.status}: ${redactor.string(await res.text())}`)
    return (res.status === 204 ? undefined : await res.json()) as T
  }

  private async paginate<T>(path: string, max = 1000): Promise<T[]> {
    const out: T[] = []
    let url: string | undefined = `${path}${path.includes('?') ? '&' : '?'}per_page=100`
    while (url && out.length < max) {
      const res = await this.request('GET', url)
      if (!res.ok) throw new GitHubError(res.status, `GET ${url} → ${res.status}: ${await res.text()}`)
      out.push(...((await res.json()) as T[]))
      url = nextLink(res.headers.get('link'))
    }
    return out.slice(0, max)
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.request('POST', '/graphql', { query, variables })
    if (!res.ok) throw new GitHubError(res.status, `GraphQL → ${res.status}: ${await res.text()}`)
    const j = (await res.json()) as { data?: T; errors?: { type?: string; message: string }[] }
    if (j.errors?.length) {
      throw new GraphQLError(
        j.errors.map(e => e.type ?? 'UNKNOWN'),
        j.errors.map(e => e.message).join('; '),
      )
    }
    return j.data as T
  }

  private get base() {
    return `/repos/${this.repo}`
  }

  async listIssues(label?: string): Promise<Issue[]> {
    const q = label ? `&labels=${encodeURIComponent(label)}` : ''
    const items = await this.paginate<RestIssue>(`${this.base}/issues?state=open${q}`)
    return items.filter(i => !i.pull_request).map(toIssue)
  }

  async allIssueTitles(): Promise<string[]> {
    const items = await this.paginate<RestIssue>(`${this.base}/issues?state=all`, 5000)
    return items.filter(i => !i.pull_request).map(i => i.title)
  }

  async issueComments(n: number): Promise<IssueComment[]> {
    const items = await this.paginate<{ id: number; user: { login: string } | null; body: string | null; created_at: string }>(
      `${this.base}/issues/${n}/comments`,
    )
    return items.map(c => ({ id: c.id, author: c.user?.login ?? 'ghost', body: c.body ?? '', createdAt: c.created_at }))
  }

  async listPrs(): Promise<PullRequest[]> {
    const items = await this.paginate<RestPull>(`${this.base}/pulls?state=all&sort=created&direction=desc`, 300)
    return items.map(toPr)
  }

  async listLabels(): Promise<LabelSpec[]> {
    const items = await this.paginate<{ name: string; color: string; description: string | null }>(`${this.base}/labels`)
    return items.map(l => ({ name: l.name, color: l.color, description: l.description ?? '' }))
  }

  async addLabels(n: number, labels: string[]): Promise<void> {
    if (labels.length) await this.rest('POST', `${this.base}/issues/${n}/labels`, { labels })
  }

  async removeLabel(n: number, label: string): Promise<void> {
    try {
      await this.rest('DELETE', `${this.base}/issues/${n}/labels/${encodeURIComponent(label)}`)
    } catch (e) {
      if (!(e instanceof GitHubError && e.status === 404)) throw e
    }
  }

  async comment(n: number, body: string): Promise<void> {
    await this.rest('POST', `${this.base}/issues/${n}/comments`, { body: redactor.string(body) })
  }

  async createIssue(i: { title: string; body: string; labels: string[] }): Promise<{ number: number; url: string }> {
    const r = await this.rest<RestIssue>('POST', `${this.base}/issues`, {
      title: redactor.string(i.title),
      body: redactor.string(i.body),
      labels: i.labels,
    })
    return { number: r.number, url: r.html_url }
  }

  async openPr(p: { head: string; base: string; title: string; body: string; draft?: boolean }): Promise<{ number: number; url: string }> {
    try {
      const r = await this.rest<RestPull>('POST', `${this.base}/pulls`, {
        head: p.head,
        base: p.base,
        title: redactor.string(p.title),
        body: redactor.string(p.body),
        draft: p.draft ?? false,
      })
      return { number: r.number, url: r.html_url }
    } catch (e) {
      if (!(e instanceof GitHubError && e.status === 422 && /already exists/i.test(e.message))) throw e
      const open = await this.rest<RestPull[]>('GET', `${this.base}/pulls?state=open&head=${encodeURIComponent(`${this.owner}:${p.head}`)}`)
      const existing = open[0]
      if (!existing) throw e
      return { number: existing.number, url: existing.html_url }
    }
  }

  async upsertLabel(l: LabelSpec): Promise<'created' | 'updated' | 'unchanged'> {
    const path = `${this.base}/labels/${encodeURIComponent(l.name)}`
    let cur: { color: string; description: string | null } | undefined
    try {
      cur = await this.rest('GET', path)
    } catch (e) {
      if (!(e instanceof GitHubError && e.status === 404)) throw e
    }
    if (!cur) {
      await this.rest('POST', `${this.base}/labels`, l)
      return 'created'
    }
    if (cur.color.toLowerCase() === l.color.toLowerCase() && (cur.description ?? '') === l.description) return 'unchanged'
    await this.rest('PATCH', path, { new_name: l.name, color: l.color, description: l.description })
    return 'updated'
  }

  async findDiscussion(category: string, title: string): Promise<DiscussionLookup> {
    const repo = await this.graphql<{
      repository: { id: string; hasDiscussionsEnabled: boolean; discussionCategories: { nodes: { id: string; name: string }[] } }
    }>(
      `query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          id hasDiscussionsEnabled
          discussionCategories(first: 25) { nodes { id name } }
        }
      }`,
      { owner: this.owner, name: this.name },
    )
    const r = repo.repository
    const cat = r.discussionCategories.nodes.find(c => c.name.toLowerCase() === category.toLowerCase())
    const out: DiscussionLookup = { repositoryId: r.id, discussionsEnabled: r.hasDiscussionsEnabled, categoryId: cat?.id ?? null, discussionId: null }
    if (!cat) return out
    let after: string | null = null
    for (let page = 0; page < 20; page++) {
      const d: {
        repository: { discussions: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { id: string; title: string }[] } }
      } = await this.graphql(
        `query($owner: String!, $name: String!, $cat: ID!, $after: String) {
          repository(owner: $owner, name: $name) {
            discussions(first: 50, after: $after, categoryId: $cat) {
              pageInfo { hasNextPage endCursor }
              nodes { id title }
            }
          }
        }`,
        { owner: this.owner, name: this.name, cat: cat.id, after },
      )
      const hit = d.repository.discussions.nodes.find(n => n.title === title)
      if (hit) return { ...out, discussionId: hit.id }
      if (!d.repository.discussions.pageInfo.hasNextPage) break
      after = d.repository.discussions.pageInfo.endCursor
    }
    return out
  }

  async createDiscussion(repositoryId: string, categoryId: string, title: string, body: string): Promise<string> {
    const r = await this.graphql<{ createDiscussion: { discussion: { id: string } } }>(
      `mutation($repo: ID!, $cat: ID!, $title: String!, $body: String!) {
        createDiscussion(input: { repositoryId: $repo, categoryId: $cat, title: $title, body: $body }) { discussion { id } }
      }`,
      { repo: repositoryId, cat: categoryId, title, body: redactor.string(body) },
    )
    return r.createDiscussion.discussion.id
  }

  async addDiscussionComment(discussionId: string, body: string, replyToId?: string): Promise<string> {
    const r = await this.graphql<{ addDiscussionComment: { comment: { id: string } } }>(
      `mutation($id: ID!, $body: String!, $reply: ID) {
        addDiscussionComment(input: { discussionId: $id, body: $body, replyToId: $reply }) { comment { id } }
      }`,
      { id: discussionId, body: redactor.string(body), reply: replyToId ?? null },
    )
    return r.addDiscussionComment.comment.id
  }
}

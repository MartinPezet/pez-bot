import type { GitHub } from '../github/client.js'
import { GraphQLError } from '../github/client.js'
import type { Logger } from '../log.js'
import { kv, type DB } from '../state/db.js'

/**
 * The daily digest: one long-lived discussion per project in DIGEST_REPO. The day's first
 * batch is a top-level comment headed with the date; later batches that day reply to it.
 * Nothing is posted for an empty batch.
 */

export interface DigestEvent {
  at: Date
  emoji: string
  text: string
  url?: string | undefined
}

export class DigestBatch {
  readonly events: DigestEvent[] = []
  readonly sections: string[] = []

  add(emoji: string, text: string, url?: string, at = new Date()): void {
    this.events.push({ at, emoji, text, url })
  }

  /** A pre-formatted markdown block (the morning summary). */
  addSection(markdown: string): void {
    if (markdown.trim()) this.sections.push(markdown.trim())
  }

  get empty(): boolean {
    return this.events.length === 0 && this.sections.length === 0
  }
}

export class DigestSetupError extends Error {}

const timeFmt = (tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

export function renderBatch(b: DigestBatch, tz: string): string {
  const t = timeFmt(tz)
  const lines = b.events.map(e => `- ${t.format(e.at)} ${e.emoji} ${e.text}${e.url ? ` — ${e.url}` : ''}`)
  return [...(lines.length ? [lines.join('\n')] : []), ...b.sections].join('\n\n')
}

/** `YYYY-MM-DD` of `now` in `tz`. */
export const dayKey = (now: Date, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)

/** "📅 Mon 5 Oct 2026" */
export const dayHeader = (now: Date, tz: string) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
      .formatToParts(now)
      .map(p => [p.type, p.value]),
  )
  return `📅 ${parts.weekday} ${parts.day} ${parts.month} ${parts.year}`
}

export interface DigestOptions {
  gh: GitHub
  db: DB
  category: string
  title: string
  autoCreate: boolean
  tz: string
  log?: Logger
}

export class Digest {
  constructor(private readonly o: DigestOptions) {}

  private get cacheKey() {
    return `${this.o.gh.repo}|${this.o.category}|${this.o.title}`
  }

  /** Finds (or, with autoCreate, creates) the project's discussion. Throws DigestSetupError with instructions. */
  async resolveDiscussion(): Promise<string> {
    const cached = kv.getJson<{ key: string; id: string }>(this.o.db, 'digest.discussion')
    if (cached?.key === this.cacheKey) return cached.id
    const { gh, category, title } = this.o
    const f = await gh.findDiscussion(category, title)
    if (!f.discussionsEnabled) {
      throw new DigestSetupError(`Discussions are not enabled on ${gh.repo}: turn them on in Settings → General → Features.`)
    }
    if (!f.categoryId) {
      throw new DigestSetupError(
        `Create a discussion category named "${category}" in ${gh.repo} with the Announcement format (Discussions → Categories → New category).`,
      )
    }
    let id = f.discussionId
    if (!id) {
      if (!this.o.autoCreate) {
        throw new DigestSetupError(
          `Create a discussion titled "${title}" in the "${category}" category of ${gh.repo}. ` +
            'Announcement categories only let maintainers start discussions; set DIGEST_AUTO_CREATE=true if the bot has maintain rights.',
        )
      }
      id = await gh.createDiscussion(f.repositoryId, f.categoryId, title, `Daily digest for ${title}, posted by pez-bot.`)
      this.o.log?.info({ title }, 'created digest discussion')
    }
    if (!gh.dryRun) kv.setJson(this.o.db, 'digest.discussion', { key: this.cacheKey, id })
    return id
  }

  /** Posts the batch. Returns false when there was nothing to post. */
  async post(batch: DigestBatch, now = new Date()): Promise<boolean> {
    if (batch.empty) return false
    const { gh, db, tz } = this.o
    const body = renderBatch(batch, tz)
    const dayCacheKey = `digest.day.${dayKey(now, tz)}`

    for (let attempt = 1; ; attempt++) {
      const discussionId = await this.resolveDiscussion()
      const dayComment = kv.get(db, dayCacheKey)
      try {
        if (dayComment) {
          await gh.addDiscussionComment(discussionId, body, dayComment)
        } else {
          const id = await gh.addDiscussionComment(discussionId, `${dayHeader(now, tz)}\n\n${body}`)
          if (!gh.dryRun) kv.set(db, dayCacheKey, id)
        }
        return true
      } catch (e) {
        // A cached id that no longer exists (comment or discussion deleted): forget both and start the day again.
        if (attempt === 1 && e instanceof GraphQLError && e.notFound) {
          this.o.log?.warn({ dayComment }, 'digest: cached discussion or day comment is gone; recreating')
          kv.del(db, dayCacheKey)
          kv.del(db, 'digest.discussion')
          continue
        }
        throw e
      }
    }
  }
}

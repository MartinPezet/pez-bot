import type { Issue, IssueComment } from './client.js'

/**
 * Prompt-injection guard: only issues and comments written by ALLOWED_AUTHORS (plus the
 * bot's own comments, which the runner wrote) ever reach a prompt or drive a state change.
 */

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export const isAllowedAuthor = (login: string, allowed: string[]) => allowed.some(a => same(a, login))

export function partitionByAuthor(issues: Issue[], allowed: string[]): { allowed: Issue[]; ignored: Issue[] } {
  const out = { allowed: [] as Issue[], ignored: [] as Issue[] }
  for (const i of issues) (isAllowedAuthor(i.author, allowed) ? out.allowed : out.ignored).push(i)
  return out
}

export const trustedComments = (comments: IssueComment[], allowed: string[], botLogin: string) =>
  comments.filter(c => isAllowedAuthor(c.author, allowed) || same(c.author, botLogin))

/** Markdown thread for prompts. */
export const renderComments = (comments: IssueComment[]) =>
  comments.map(c => `**@${c.author}** (${c.createdAt}):\n${c.body}`).join('\n\n---\n\n') || '(none)'

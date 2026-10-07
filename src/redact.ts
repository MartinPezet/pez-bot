/** Value-based secret redaction for logs, comments, PR bodies and the digest. */

const PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub classic / OAuth / App tokens
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PATs
  /sk-ant-[A-Za-z0-9_-]{10,}/g, // Anthropic API keys and OAuth tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(?<=:\/\/)[^\s:@/]+:[^\s@/]+(?=@)/g, // user:password@ in URLs
]

export const REDACTED = '[REDACTED]'

export class Redactor {
  private secrets: string[] = []

  /** Register exact secret values. Short values are ignored to avoid shredding normal text. */
  add(...values: (string | undefined)[]): void {
    for (const v of values) {
      if (v && v.length >= 8 && !this.secrets.includes(v)) this.secrets.push(v)
    }
    this.secrets.sort((a, b) => b.length - a.length)
  }

  string(s: string): string {
    let out = s
    for (const secret of this.secrets) out = out.split(secret).join(REDACTED)
    for (const p of PATTERNS) out = out.replace(p, REDACTED)
    return out
  }

  deep(v: unknown, seen = new WeakSet<object>()): unknown {
    if (typeof v === 'string') return this.string(v)
    if (v instanceof Error) {
      // Keep it an Error of the same class so log serializers still report its type.
      const copy = Object.create(Object.getPrototypeOf(v) as object) as Error
      Object.assign(copy, v)
      copy.message = this.string(v.message)
      copy.stack = v.stack ? this.string(v.stack) : undefined
      return copy
    }
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v)) return '[Circular]'
    seen.add(v)
    if (Array.isArray(v)) return v.map(x => this.deep(x, seen))
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.deep(x, seen)]))
  }
}

/** Process-wide redactor; secrets are registered as soon as they are known. */
export const redactor = new Redactor()

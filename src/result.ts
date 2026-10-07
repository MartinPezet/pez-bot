import type { ZodError } from 'zod'

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] }

export const formatIssues = (e: ZodError): string[] =>
  e.issues.map(i => {
    const msg = /received undefined$/.test(i.message) ? 'required' : i.message
    return `${i.path.length ? i.path.join('.') : '(root)'}: ${msg}`
  })

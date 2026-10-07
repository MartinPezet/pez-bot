import { appendFile, mkdirSync } from 'node:fs'
import path from 'node:path'
import { Writable } from 'node:stream'
import pino from 'pino'
import { redactor, type Redactor } from './redact.js'

export type Logger = pino.Logger

/** Appends to `runner-YYYY-MM-DD.log`, one file per UTC day, so retention can delete whole days. */
class DailyFile extends Writable {
  constructor(private readonly dir: string) {
    super()
    mkdirSync(dir, { recursive: true })
  }
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    appendFile(path.join(this.dir, `runner-${new Date().toISOString().slice(0, 10)}.log`), chunk, cb)
  }
}

export function createLogger(opts: { level: string; logDir?: string; redact?: Redactor }): Logger {
  const r = opts.redact ?? redactor
  const streams: pino.StreamEntry[] = [{ stream: process.stdout }]
  if (opts.logDir) streams.push({ stream: new DailyFile(opts.logDir) })
  return pino(
    {
      level: opts.level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { log: obj => r.deep(obj) as Record<string, unknown> },
      hooks: {
        logMethod(args, method) {
          const cleaned = args.map(a => (typeof a === 'string' ? r.string(a) : a)) as typeof args
          method.apply(this, cleaned)
        },
      },
    },
    pino.multistream(streams),
  )
}

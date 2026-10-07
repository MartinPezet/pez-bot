import type { DB } from '../state/db.js'
import type { Reading } from './passive.js'

/**
 * Where usage readings live. Swap the probes (or this whole interface) when Anthropic ships an
 * official way to read plan usage; the budget rules only see Readings.
 */
export interface UsageGauge {
  record(readings: Reading[]): void
  /** Readings newer than `since`, newest first. */
  recent(since: Date): Reading[]
  /** Fetch fresh readings now. Throws with a reason when no probe could read usage. */
  probe(): Promise<Reading[]>
}

export interface Probe {
  name: string
  run(): Promise<Reading[]>
}

interface Row {
  at: string
  bucket: string
  utilization: number | null
  status: string | null
  resets_at: string | null
  source: string
}

export class SqliteGauge implements UsageGauge {
  constructor(
    private readonly db: DB,
    private probes: Probe[] = [],
  ) {}

  setProbes(probes: Probe[]): void {
    this.probes = probes
  }

  record(readings: Reading[]): void {
    const ins = this.db.prepare('INSERT INTO usage_readings (at, bucket, utilization, status, resets_at, source) VALUES (?, ?, ?, ?, ?, ?)')
    this.db.transaction(() => {
      for (const r of readings) ins.run(r.at.toISOString(), r.bucket, r.utilization, r.status, r.resetsAt?.toISOString() ?? null, r.source)
    })()
  }

  recent(since: Date): Reading[] {
    const rows = this.db.prepare('SELECT * FROM usage_readings WHERE at >= ? ORDER BY at DESC, id DESC').all(since.toISOString()) as Row[]
    return rows.map(r => ({
      bucket: r.bucket,
      utilization: r.utilization,
      status: (r.status as Reading['status']) ?? null,
      resetsAt: r.resets_at ? new Date(r.resets_at) : null,
      source: r.source,
      at: new Date(r.at),
    }))
  }

  /** Tries each probe in order; the first that yields a utilization wins. */
  async probe(): Promise<Reading[]> {
    const errors: string[] = []
    for (const p of this.probes) {
      try {
        const r = await p.run()
        this.record(r)
        if (r.some(x => x.utilization !== null)) return r
        errors.push(`${p.name}: no utilization reported`)
      } catch (e) {
        errors.push(`${p.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    throw new Error(errors.join('; ') || 'no usage probes configured')
  }
}

const ANSI = /\u001b\[[0-9;]*m/g
const FAILURE_LINE = /\berror\b|\bFAIL(ED)?\b/i
const UNPARSED = '(failure output not recognised)'

/** One key per failing line, with line/column numbers dropped so unrelated edits don't shift the comparison. */
export function failureKeys(log: string): Set<string> {
  const keys = new Set<string>()
  for (const raw of log.replace(ANSI, '').split('\n')) {
    if (!FAILURE_LINE.test(raw)) continue
    keys.add(raw.trim().replace(/\(\d+,\d+\)/g, '').replace(/:\d+(:\d+)?/g, ''))
  }
  return keys
}

/** Failures in the branch's gate output that the default branch doesn't already have. Unreadable output counts as new. */
export function newFailures(headLog: string, baseLog: string): string[] {
  const head = failureKeys(headLog)
  if (!head.size) return [UNPARSED]
  const base = failureKeys(baseLog)
  return [...head].filter(k => !base.has(k))
}

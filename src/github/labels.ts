import type { GitHub, Issue, LabelSpec } from './client.js'

/** Labels are the state machine: exactly one `state:` label per open issue. */
export const STATES = [
  'state:inbox',
  'state:needs-decision',
  'state:ready',
  'state:proposing',
  'state:proposal-review',
  'state:approved',
  'state:building',
  'state:pr-review',
  'state:blocked',
] as const
export type State = (typeof STATES)[number]

export const URGENT = 'urgent'

export const FIXED_LABELS: LabelSpec[] = [
  { name: 'state:inbox', color: 'ededed', description: 'New, waiting for triage' },
  { name: 'state:needs-decision', color: 'd93f0b', description: 'Waiting on a maintainer' },
  { name: 'state:ready', color: '0e8a16', description: 'Triaged and specifiable; runner will propose' },
  { name: 'state:proposing', color: 'c5def5', description: 'Runner is writing the OpenSpec proposal' },
  { name: 'state:proposal-review', color: '1d76db', description: 'Proposal PR open; merge it to approve' },
  { name: 'state:approved', color: '0052cc', description: 'Proposal merged; runner will build' },
  { name: 'state:building', color: 'c5def5', description: 'Runner is implementing' },
  { name: 'state:pr-review', color: '5319e7', description: 'Implementation PR open' },
  { name: 'state:blocked', color: 'b60205', description: 'Runner hit a problem; see latest comment' },
  { name: 'type:feature', color: 'fbca04', description: 'New capability' },
  { name: 'type:bug', color: 'd73a4a', description: 'Something is wrong' },
  { name: 'type:chore', color: 'cfd3d7', description: 'Maintenance, tooling, refactor' },
  { name: 'type:spike', color: 'f9d0c4', description: 'Research or decision; never automated' },
  { name: 'priority:p1', color: 'b60205', description: 'Blocks users or data correctness' },
  { name: 'priority:p2', color: 'fbca04', description: 'Default' },
  { name: 'priority:p3', color: 'c2e0c6', description: 'Nice to have' },
  { name: 'size:s', color: 'c2e0c6', description: 'Under a day' },
  { name: 'size:m', color: 'bfdadc', description: '1-3 days' },
  { name: 'size:l', color: '5319e7', description: 'Too big; split before building' },
  { name: URGENT, color: 'e11d21', description: 'Jumps the queue; set by a maintainer only' },
]

export const TYPES = ['feature', 'bug', 'chore', 'spike'] as const
export const PRIORITIES = ['p1', 'p2', 'p3'] as const
export const SIZES = ['s', 'm', 'l'] as const

export const areaLabels = (areas: string[]): LabelSpec[] =>
  areas.map(a => ({ name: `area:${a}`, color: '006b75', description: `Area: ${a}` }))

/** Every label the runner may apply for a project. */
export const allowedLabels = (areas: string[]): Set<string> =>
  new Set([...FIXED_LABELS.map(l => l.name), ...areaLabels(areas).map(l => l.name)])

export const stateOf = (i: Pick<Issue, 'labels'>): State | undefined =>
  STATES.find(s => i.labels.includes(s))

export const isUrgent = (i: Pick<Issue, 'labels'>) => i.labels.includes(URGENT)

/** p1 → 1 … p3 → 3; unlabelled counts as p2. */
export const priorityOf = (i: Pick<Issue, 'labels'>): number =>
  Number(i.labels.find(l => /^priority:p[1-3]$/.test(l))?.slice(-1) ?? 2)

/** Queue order: urgent first, then priority, then age (issue number). */
export const byQueueOrder = (a: Issue, b: Issue) =>
  Number(isUrgent(b)) - Number(isUrgent(a)) || priorityOf(a) - priorityOf(b) || a.number - b.number

/** Moves an issue to `state`, removing any other state label. Mutates `issue.labels`. */
export async function setState(gh: GitHub, issue: Issue, state: State): Promise<void> {
  const stale = issue.labels.filter(l => l.startsWith('state:') && l !== state)
  if (!issue.labels.includes(state)) await gh.addLabels(issue.number, [state])
  for (const l of stale) await gh.removeLabel(issue.number, l)
  issue.labels = [...issue.labels.filter(l => !stale.includes(l) && l !== state), state]
}

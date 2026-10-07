import path from 'node:path'

/** Volume layout inside the container. DATA_DIR overrides it for local runs and tests. */
export function paths(dataDir = process.env.DATA_DIR ?? '/data') {
  const state = path.join(dataDir, 'state')
  return {
    data: dataDir,
    repo: path.join(dataDir, 'repo'),
    worktrees: path.join(dataDir, 'worktrees'),
    state,
    db: path.join(state, 'runner.db'),
    firewall: path.join(state, 'firewall.json'),
    logs: path.join(dataDir, 'logs'),
  }
}

export type Paths = ReturnType<typeof paths>

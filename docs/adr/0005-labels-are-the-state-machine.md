# Labels are the state machine

Issue state lives in `state:*` labels on GitHub, so the owner can see and change it from the GitHub UI and GitHub stays the source of truth. SQLite holds only runner-local facts (job runs, usage readings, digest IDs, checkpoints, update history, caches, the lease); losing it costs history, not backlog state.

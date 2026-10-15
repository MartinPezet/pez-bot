# Architecture

How the pieces fit and the mechanics the code alone doesn't explain. Read when a change touches more than one module or crosses the runner/agent boundary. Operator-facing behaviour (commands, env vars, `.backlog-runner.json`, security model) lives in `README.md`; the reasons behind choices live in `docs/adr/`.

## Shape

```
┌──────────────────────── runner container ───────────────────────────────┐
│ tini (PID 1)                                                              │
│  └─ entrypoint.sh (root): firewall up → self-check → chown volumes        │
│       │                   └─ root loop: re-resolve firewall every 15 min  │
│       └─ setpriv → node dist/cli.js daemon   (uid runner, no caps)        │
│            ├─ Scheduler (croner → one in-process queue, SQLite lease)     │
│            ├─ Jobs: sync · work (propose | build) · triage · summary ·    │
│            │        update · cleanup · setup · migrate-prd                │
│            ├─ GitHub layer (GraphQL + REST via fetch; DRY_RUN → log only) │
│            ├─ Digest (Discussions, batched per job)                       │
│            ├─ UsageGauge · BudgetRules · RunWindows                       │
│            └─ sudo -u agent → claude -p … / install / gates               │
└───────────┬─────────────────────────────────────────────────────────────┘
            │ internal network `testnet` (no egress)
   ┌────────┴────────┐
   postgres-test     redis-test
```

`src/` folders map one-to-one onto the boxes above.

## State

- **GitHub is the source of truth.** `state:*` labels are the state machine (flow diagram in `README.md`).
- **SQLite holds only runner-local facts:** job runs, usage readings, digest IDs, checkpoints, update history, caches, and the job lease.
- **Project config is read from the target repo's default branch at job start**, never from a worktree, so agent edits can't change config or inject prompt overrides.

## Job wrapper

Every job runs through one wrapper: take the lease → insert a `job_runs` row → run → record outcome, duration and est. cost → flush the digest batch → heartbeat → per-job cleanup → health ping (or `/fail`). CLI invocations that find the lease held exit 75; read-only commands (`status`, `usage`) skip it.

## Checkpoints (build and propose)

The Claude wrapper watches the stream-json output. On `rate_limit_event.status == "rejected"`, window end + grace, or SIGTERM, it sends **SIGINT** (clean turn end), then SIGTERM after 30 s. SIGTERM alone exits 143 with no result. The runner then commits leftovers as `wip: checkpoint …`, pushes `change/issue-N` (build only; a propose just re-runs), returns the issue to `approved`/`ready`, writes `checkpoints` + `paused_until`, and posts to the digest. The next build finds the branch and resumes.

## Stop signals

Agents end with `NEEDS_DECISION:`, `NEEDS_SPLIT:` or `BLOCKED:`. The parser takes the **last** match in the final result text (multiline `^(NEEDS_DECISION|NEEDS_SPLIT|BLOCKED):\s*(.*)`), because agents sometimes quote the protocol earlier. Triage instead returns `--json-schema` output, re-validated with zod.

## Gotchas

- **Claude Code allowlist syntax** is `Bash(git diff *)` (space before `*`), not the older `Bash(git diff:*)`.
- **`DISABLE_AUTOUPDATER=1`, never `DISABLE_UPDATES`**: the latter also blocks `claude update`/`claude install`, which the `update` job needs.
- **An empty `--allowedTools` list makes the CLI reject the call.** Omit the flag instead.
- **Agent umask:** sudo unions umasks, so `sudoers.agent` sets `umask=0002`; otherwise the runner can't commit or delete agent-written files.
- **Firewall DNS** is allowed to the resolvers in `/etc/resolv.conf`, not just `127.0.0.11` (only present on user-defined networks).
- **Dry run covers git:** `DRY_RUN=1` also skips `git push` and remote branch deletion.
- **Schedule overrides are read at daemon start**; changes need a restart.
- **GitHub Discussions:** no title filter (page and match exactly, then cache the node ID); `replyToId` must be a top-level comment; no mutation creates categories.
- **Superpowers can't be version-pinned**, so its rollback uninstalls it.

## Tests

Unit tests use fakes for `Git`, `GitHub`, `Claude`, `Clock` and `Fs` (`test/fakes.ts`) and never shell out. Window tests cover Europe/London DST switches, midnight-crossing windows, and Friday/Sunday-night anchoring. `scripts/e2e-dry-run.sh` exercises the whole stack against a sandbox repo.

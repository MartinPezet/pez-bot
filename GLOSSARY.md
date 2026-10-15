# pez-bot

A containerised runner that works through one GitHub backlog unattended, turning issues into approved proposals and then implementation PRs.

## Repos and people

**Target repo**:
The single GitHub repo whose backlog the runner works on; supplies `.backlog-runner.json`, `openspec/` and prompt overrides.
_Avoid_: project repo, client repo

**Digest repo**:
The central repo holding one digest discussion per target repo.

**Owner**:
The human who reviews and merges; listed in `allowedAuthors`.
_Avoid_: user, maintainer (in docs; GitHub's own UI says maintainer)

**Allowed author**:
A GitHub login whose issues and comments the runner may act on; everything else is ignored.

## Users inside the container

**Runner**:
The OS user that holds secrets and state and makes every GitHub write; also the daemon process itself.

**Agent**:
The OS user that runs Claude, installs and gates; it never sees secrets.
_Avoid_: worker, sandbox user

## Work items

**Item**:
An open issue in the target repo carrying exactly one state label.
_Avoid_: ticket, task, card

**State**:
The `state:*` label on an item; the set of states is the state machine.
_Avoid_: status, stage, triage label (triage labels like `ready-for-agent` belong to this repo's own dev backlog, not to items)

**Proposal**:
An OpenSpec change under `openspec/changes/` opened as a PR; merging it is the owner's approval to build.
_Avoid_: spec, plan, RFC

**Implementation PR**:
The PR a build opens for an approved item.

**Urgent**:
The owner-only label that jumps the queue and ignores windows and the soft budget, but not WIP limits.

**Spike**:
An item of `type:spike`; never proposed or built, always sent to `needs-decision`.

**Stop signal**:
A final `NEEDS_DECISION:` / `NEEDS_SPLIT:` / `BLOCKED:` line from an agent telling the runner how to move the item.

## Jobs

**Job**:
One scheduled unit of runner work (`sync`, `work`, `triage`, `summary`, `update`, `cleanup`, `setup`, `migrate-prd`), run one at a time.
_Avoid_: task, run (a run is one execution of a job)

**Propose**:
The `work` path that writes a proposal for a `ready` item.

**Build**:
The `work` path that implements an `approved` item: apply, gates, fix loop, PR.

**Gate**:
A command from `.backlog-runner.json` `gates` that must pass before a build opens its PR.
_Avoid_: check, CI (CI is GitHub's; gates run inside the container)

**Fix loop**:
Up to `maxFixAttempts` Claude rounds that repair failing gates.

**Checkpoint**:
Work in progress committed and pushed to `change/issue-N` when a job is interrupted, so the next build resumes.

**Lease**:
The SQLite lock that guarantees one job at a time across containers.

## Budget

**Window**:
A recurring time range in `RUN_WINDOWS` when Claude jobs may start.

**Usage gauge**:
The runner's best reading of 5-hour and weekly plan utilisation; may be unknown.

**Budget gate**:
The rule set deciding whether a Claude job may start given usage, windows and urgency.
_Avoid_: quota, limit (limits are Anthropic's; the gate is ours)

**WIP limit**:
The maximum open proposal PRs or implementation PRs before the runner stops starting new work.

## Reporting

**Digest**:
The per-target-repo GitHub Discussion the runner posts to, one top-level comment per day with replies per event.
_Avoid_: log, report, feed

**Summary**:
The weekday 07:30 digest post describing queue state.

**Dry run**:
`DRY_RUN=1` mode where every GitHub write and push is logged instead of performed; Claude still runs.

# pez-bot

A containerised runner that works through one GitHub backlog unattended, turning issues into reviewed proposals and then implementation PRs.

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
An OpenSpec change under `openspec/changes/` written for an item. It reaches the owner inside the implementation PR, not as a PR of its own.
_Avoid_: spec, plan, RFC

**Proposal review**:
A second agent, with a fresh context and read-only access, checking a proposal against its item before it is built. Passing it approves the item; gaps go back to the writer.
_Avoid_: spec review, approval (approval is the owner merging the implementation PR)

**Implementation PR**:
The PR a build opens for an approved item, holding the proposal and the code; merging it is the owner's only approval.

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
The `work` path that writes a proposal for a `ready` item and gets it through proposal review.

**Build**:
The `work` path that implements an `approved` item: apply, gates, fix loop, PR.

**Gate**:
A command from `.backlog-runner.json` `gates` that must pass before a build opens its PR.
_Avoid_: check, CI (CI is GitHub's; gates run inside the container)

**Branch test env**:
The dummy env vars the bot commits alongside its own code so its gates can boot the app. It can add variables but never replace ones the owner's config sets; production values stay the owner's.
_Avoid_: test secrets, env config

**Fix loop**:
Up to `maxFixAttempts` Claude rounds that repair failing gates, a failed CI run, or review feedback on the item's open PR.

**Review feedback**:
New comments from an allowed author on an item's open implementation PR. The runner sends the item back to build to address them.
_Avoid_: PR comments, change request

**Checkpoint**:
Work in progress committed and pushed to `change/issue-N` when a job is interrupted, so the next build resumes.

**Lease**:
The SQLite lock that guarantees one job at a time across containers.

## Budget

**Window**:
A recurring time range in `RUN_WINDOWS` when the daemon may start Claude jobs. Manual runs ignore it.

**Usage gauge**:
The runner's best reading of 5-hour and weekly plan utilisation; may be unknown.

**Budget gate**:
The rule set deciding whether a Claude job may start given usage, windows and urgency.
_Avoid_: quota, limit (limits are Anthropic's; the gate is ours)

**WIP limit**:
The maximum open implementation PRs, counting approved items that will open one, before the runner stops starting new work.

## Reporting

**Digest**:
The per-target-repo GitHub Discussion the runner posts to, one top-level comment per day with replies per event.
_Avoid_: log, report, feed

**Summary**:
The weekday 07:30 digest post describing queue state.

**Dry run**:
`DRY_RUN=1` mode where every GitHub write and push is logged instead of performed; Claude still runs.

**Failed run**:
A run of a job that ended `error` or `blocked`. Pauses and checkpoints don't count, because they recover by themselves.

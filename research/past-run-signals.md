# Signals available from past runs

Research for #15. Question: what does pez-bot already know, or could know cheaply, about past runs, for a future learning loop that derives lessons from them?

Sources: this codebase at `87927b3` (paths relative to the repo root), the Claude Code headless and Agent SDK docs, and the GitHub REST and GraphQL docs (linked inline).

## Summary table

| Signal | Where it lives | Retention | Gap |
|---|---|---|---|
| Job outcome, duration, cost, turns | SQLite `job_runs` | Forever (never pruned) | No attempt count, gate name, stop kind, model or token split |
| Fix-loop attempts, gate failures | Log lines; blocked-issue comment | Logs: `RETENTION_DAYS` (14). Comments: forever | Not structured; a successful run keeps no record |
| Stop signals | Issue comment, digest line, `job_runs.detail` (build only) | Comments: forever | Propose records `detail = 'NEEDS_DECISION'` without the reason |
| Claude stream-json | Parsed live; only `result` fields and readings kept | Not persisted | Full transcript discarded (`--no-session-persistence`) |
| Usage readings | SQLite `usage_readings` | `RETENTION_DAYS` | None for learning purposes |
| Checkpoints / pauses | `wip: checkpoint` commits, `job_runs.outcome`, kv `usage.paused_until` | Branch until cleanup | No `checkpoints` table exists (see the docs drift below) |
| Digest posts | GitHub Discussion comments | Forever (on GitHub) | Free text only; kv keeps only comment IDs |
| PR merged vs closed | GitHub, via `listPrs()` | Forever (on GitHub) | Read only for proposals; implementation PR outcomes are never recorded |
| Owner reviews, change requests | GitHub only | Forever (on GitHub) | Not fetched at all; client has no review methods |
| Label history | GitHub issue events | Forever (on GitHub) | Not fetched |

## SQLite (`/data/state/runner.db`)

The schema has one migration, `src/state/db.ts:8-50`. There is no `checkpoints` table.

- **`job_runs`** (`src/state/db.ts:10-21`): `job, issue, started_at, ended_at, outcome, detail, est_cost_usd, turns`.
  - Written in the job wrapper: `startRun` at `src/jobs/runner.ts:107`, `finishRun` at `src/jobs/runner.ts:139` → `src/state/jobs.ts:22-31`.
  - `job` is overwritten with the sub-kind (`build`/`propose`) for work runs (`src/jobs/work.ts:60`, `COALESCE(?, job)` in `src/state/jobs.ts:29`).
  - Outcomes: `ok | noop | error | blocked | paused | checkpointed | skipped` (`src/state/jobs.ts:3`).
  - `detail` holds the PR URL on success (`src/jobs/build.ts:122`), `firstLine(reason)` on a block (`src/jobs/common.ts:217`), or the gate's skip reason.
  - `est_cost_usd`/`turns` are summed across the apply call and every fix call (`sumCost`, `src/jobs/common.ts:172-175`). The run doesn't record how many Claude calls it made.
  - Read by: `recentRuns`/`recentFinished` (`src/state/jobs.ts:33-38`), `pez-bot status` (`src/status.ts:81`), and the duration estimator (`src/windows/estimate.ts:9-22`, median of the last 10 `ok`/`blocked` runs).
  - **Retention: none.** Cleanup never deletes from `job_runs` (`src/jobs/cleanup.ts:85-88` prunes only `usage_readings` and `digest.day.*`). This makes it the best long-lived local record.
- **`usage_readings`** (`src/state/db.ts:30-39`): per-bucket utilization, status and reset time, from stream-json `rate_limit_event`s and probes (`src/usage/gauge.ts:40-45`). Deleted after `RETENTION_DAYS` (`src/jobs/cleanup.ts:86`, default 14, `src/config/env.ts:54`). Not linked to a `job_runs.id`, so it joins on time only.
- **`updates`** (`src/state/db.ts:40-48`, written at `src/jobs/update.ts:31`): component upgrades and rollbacks, never pruned. Useful for "did behaviour change after a CLI upgrade?".
- **`kv`** (`src/state/db.ts:22`): mostly current-state flags (`usage.paused_until`, `gate.weekly`, `disk.low`). The past-run facts it holds:
  - `recovered.<n>`: crash-recovery timestamps (`src/jobs/sync.ts:36-44`).
  - `blocked-worktree.<dir>`: when a worktree was kept (`src/jobs/runner.ts:141`).
  - `digest.pending`: undelivered digest events.

  Only `digest.day.*` is pruned by age.

## Claude stream-json

- Every call runs `claude -p --output-format stream-json --verbose ... --no-session-persistence` (`src/exec/claude.ts:47-65`). With `--no-session-persistence`, the CLI writes no `.jsonl` transcript. Cleanup still sweeps `/home/agent/.claude/projects/*.jsonl` older than retention, as a belt-and-braces step (`src/jobs/cleanup.ts:77-78`).
- **The stream is parsed live and thrown away.** `StreamState.push` (`src/exec/claude.ts:74-91`) keeps three things: `rate_limit_event` readings, the final `result` message, and the last `assistant.error`.
- `finish` (`src/exec/claude.ts:93-110`) then keeps these `result` fields: `result` text, `structured_output`, `num_turns`, `total_cost_usd`, `is_error`, `subtype`. The text reaches GitHub (PR body, truncated to 4000 chars, or a stop-signal comment). Only `turns` and cost reach SQLite.
- The run log gets one `claude finished` line with stop reason, turns, cost and error (`src/exec/claude.ts:165`). It also gets stderr on a crash (`src/exec/claude.ts:159`).
- **Fields the `result` message already carries but the runner drops** ([`SDKResultMessage`](https://code.claude.com/docs/en/agent-sdk/typescript)):
  - `duration_ms`, `duration_api_ms`, `usage` (tokens), `modelUsage` (per-model cost and tokens)
  - `permission_denials` (tools the agent tried and was refused)
  - `subtype` (`error_max_turns`, `error_during_execution`, …), `errors[]`, `stop_reason`, `terminal_reason`, `session_id`

  The [headless docs](https://code.claude.com/docs/en/headless) confirm `permission_denials` on the result and `system/api_retry` events with an `error` category.
- **Cheap to add:** persist a small JSON blob of these result fields per Claude call. It needs no new parsing, because `this.result` already holds the object.
- **Medium cost:** tee raw stream lines to `/data/logs/claude-<runId>-<n>.jsonl` under the existing log retention. The full transcript (every tool call and result) is the richest signal for "what did the agent try?". It is large, and it needs the redactor (`src/redact.ts`), because tool output can echo env values.

## Fix loop and gate failures

- The gates are the project's test commands, run in `runGates` (`src/jobs/common.ts:285-291`). It stops at the first failing gate and returns `$ <cmd>` plus a 150-line tail. (`src/jobs/gate.ts` is the *budget* gate: windows and usage, not tests.)
- The fix loop (`src/jobs/build.ts:90-103`) runs up to `maxFixAttempts` times. Each iteration logs `gates failed, fixing` with `attempt` (`src/jobs/build.ts:91`). Nothing else records the attempt number.
- **On success**, the attempt count, failing gate and output are lost except in the 14-day log. The PR body says only "Gates passed".
- **On exhaustion**, the block comment carries `Gates still failing after N fix attempts` and a 60-line tail (`src/jobs/build.ts:107-112`), kept forever on the issue. `job_runs.detail` keeps the first line.
- Propose has a one-shot `openspec validate` fix (`src/jobs/propose.ts:52-67`). Its failure is visible only through a block comment.
- Other build blocks, each in a comment and in `detail`: install failure, merge conflict on resume, no change folder, timeout, fatal Claude error, no commits (`src/jobs/build.ts:49-103`, `113`).
- **Cheap to add:** columns or a JSON `detail` on `job_runs`: `fix_attempts`, `failed_gate` (the command), `gate_tail_hash`. Increment the counter in the loop. A first-pass pass/fail per gate is also one line in `runGates`.

## Stop signals

- `stopSignal` takes the last `NEEDS_DECISION|NEEDS_SPLIT|BLOCKED:` line (`src/jobs/common.ts:13-19`).
- **Build:** `block()` with `Agent stopped: **KIND**` plus the detail. The comment and digest keep the full text; `job_runs.detail` keeps the first line.
- **Propose** (`src/jobs/propose.ts:36-43`): the issue moves to `needs-decision`, and a comment holds the detail. `job_runs` records `outcome='ok'` and `detail=<KIND>`, so stop signals are countable per kind, but the reason lives only on GitHub.
- **Missing:** an outcome that tells a stop-signal "ok" apart from a real "ok". Today you have to match `detail IN ('NEEDS_DECISION','NEEDS_SPLIT','BLOCKED')`.

## Checkpoints and pauses

There is no `checkpoints` table. `docs/agents/ARCHITECTURE.md:31,40` and ADR-0005 say there is, which is docs drift worth fixing. A pause (`src/jobs/common.ts:224-263`) leaves these traces:

- a `wip: checkpoint (#n)` commit pushed to `change/issue-N` (build only)
- `job_runs.outcome` set to `paused` or `checkpointed`, with `detail` set to why
- kv `usage.paused_until` (a rate-limit pause only, and overwritten each time)
- an issue comment and a digest line

Recoveries after a crash are in kv `recovered.<n>` and an issue comment (`src/jobs/sync.ts:35-53`). **History per issue** (how many pauses before a PR) comes from `job_runs WHERE issue = ?`, which already works.

## Digest posts

- `DigestBatch` events (`emoji, text, url, at`) are rendered to markdown (`src/digest/digest.ts:41-46`). They are posted as one Discussion comment per day, with later batches as replies (`src/digest/digest.ts:108-136`).
- SQLite keeps only comment IDs (`digest.day.<date>`, pruned after retention) and the discussion ID.
- **The events themselves are not stored locally.** They are emoji-tagged text, so on GitHub they can only be parsed loosely. Nearly every digest event has a structured twin (a `job_runs` row or an issue comment), so the digest adds little for learning.
- **Cheap to add:** a `digest_events` table if they're wanted. Probably not needed.

## PR merged vs closed

- The client reads PRs with `listPrs()`: REST `GET /repos/{o}/{r}/pulls?state=all`, capped at 300 (`src/github/client.ts:227-230`). It maps to `{state: OPEN|CLOSED|MERGED, mergedAt, closedAt, headRefName, …}` (`src/github/client.ts:23-33,130-140`).
- PRs map to issues by branch name: `proposal/issue-N-*` and `change/issue-N`.
- **Proposals:** `sync.promote` acts on merged versus closed (`src/jobs/sync.ts:56-73`) but records nothing locally beyond a digest line. A closed proposal also gets a "closed without merging" issue comment.
- **Implementation PRs:** the runner never looks at their outcome. The morning summary lists merges from the last 24 h (`src/jobs/summary.ts:37-38`). A merged PR closes the issue through `Closes #N` in its body (`src/jobs/build.ts:117`). A closed-unmerged implementation PR goes unnoticed. After 7 days, cleanup deletes its remote branch (`src/jobs/cleanup.ts:23-29`).
- **Cheap to add:** a scheduled pass (or one inside `sync`) that matches `listPrs()` to `job_runs.detail` URLs and records `merged`/`closed` with timestamps. GitHub keeps this forever, so the record can also be rebuilt later. The extra data needs nothing beyond the existing REST call.

## Owner PR reviews and change requests

The existing client cannot read any of this today. `GitHub` exposes only `issueComments` (`src/github/client.ts:59,220-225`), which returns issue-thread comments only, not review comments. The client does have a generic `graphql()` (`src/github/client.ts:192-203`), so a new read is a small method rather than new plumbing.

- **REST** ([reviews](https://docs.github.com/en/rest/pulls/reviews), [review comments](https://docs.github.com/en/rest/pulls/comments)):
  - `GET /repos/{owner}/{repo}/pulls/{n}/reviews`: `state`, `body`, `user`, `submitted_at`, `author_association`.
  - `GET /repos/{owner}/{repo}/pulls/{n}/comments`: line comments, with `path`, `line`, `diff_hunk`, `body`, `pull_request_review_id`, `in_reply_to_id`.
- **GraphQL** ([PullRequest](https://docs.github.com/en/graphql/reference/pulls)):
  - `reviewDecision`: `APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED`.
  - `latestReviews` and `reviews { state body author submittedAt }`, with review `state` one of `APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING`.
  - `reviewThreads { isResolved isOutdated path comments }`.
  - `merged`, `mergedAt`, `mergedBy`, `additions`, `deletions`, `changedFiles`, `timelineItems`.

  One query per PR gets review state, line comments and diff size together.
- **Owner follow-up commits:** if the owner pushes fixes to the bot's branch before merging, the extra commits not authored by the bot (`BOT_GIT_EMAIL`) are a strong "what the agent got wrong" signal. They're readable from the PR's `commits` or from `git log` on the merged branch.
- Filter to `allowedAuthors`, as `trustedComments` does (`src/github/authors.ts`), so untrusted text never feeds lessons. This matters: review text that becomes a lesson becomes prompt input.

## Label history and issue comments

- Bot comments are a structured log already: `🚧 **Runner blocked**`, `⏸️ **Paused**`, `♻️`, `🤖 Couldn't write a proposal yet`. The summary job already counts blocks per issue by matching `BLOCK_HEADER` (`src/jobs/summary.ts:6,66-71`).
- Owner relabels show human overrides, for example `blocked → approved` after a fix, or `needs-decision → ready`. They're available through [`GET /repos/{o}/{r}/issues/{n}/events`](https://docs.github.com/en/rest/issues/events), whose `labeled`/`unlabeled` entries carry `label.name`, `actor` and `created_at`. Not fetched today.

## Run logs

`/data/logs/runner-YYYY-MM-DD.log` holds pino JSON, redacted (`src/log.ts:9-29`). Cleanup deletes logs older than `RETENTION_DAYS` (`src/jobs/cleanup.ts:79-83`, README `RETENTION_DAYS`). The logs have per-attempt fix lines and `claude finished` lines, but no `runId` field, so they join to `job_runs` by time only.

## Implications for the learning loop

1. **Use `job_runs` as the spine.** It is the only local record kept forever, keyed by issue. Extend it rather than add a parallel store.
2. **Cheapest high-value additions**, each a few lines:
   - `fix_attempts` and `failed_gate` on build runs
   - a JSON column for the dropped Claude `result` fields (`permission_denials`, `subtype`, `errors`, `usage`, `modelUsage`, `duration_ms`), one entry per Claude call
   - a separate outcome or flag for stop-signal runs
   - a `runId` on log lines
3. **Read the human verdict from GitHub, don't mirror it.** Merged versus closed, `reviewDecision`, review bodies, line comments and owner follow-up commits are kept forever on GitHub. One GraphQL query per PR, through the existing `graphql()` helper, fetches them all. A periodic "harvest" can backfill them into a `pr_outcomes` table keyed by PR number and issue.
4. **Transcripts are the expensive option.** Teeing stream-json to disk under log retention gives "what did the agent try?", but it is large and needs redaction. Defer it until lessons from structured signals prove too shallow.
5. **Retention mismatch.** The richest local detail (logs, usage readings) expires after 14 days, while outcomes on GitHub are permanent. A learning loop that runs less often than every 14 days must snapshot what it needs into `job_runs` or a lessons table first.
6. **Trust boundary.** Lessons derived from comments or reviews become prompt input. Keep the `allowedAuthors` filter and the redactor on that path.
7. **Docs drift to fix separately:** `ARCHITECTURE.md` and ADR-0005 mention a `checkpoints` table that does not exist.

# Headless Claude options for a reviewer and a reviser

Research for #12 (parent #9). Question: which `claude -p` features fit a pre-PR **reviewer** (reads the branch, returns findings) and an **author/reviser** (revises against those findings), and what does each cost in usage?

Sources: official Claude Code docs (fetched 2026-10-15) and this repo at `main` (`87927b3`). Local CLI checked: `claude --version` → 2.1.201; several features below need a newer CLI, so check the image's pinned version.

## How the runner calls the CLI today

`claudeArgs()` in `src/exec/claude.ts` always passes:

`-p --output-format stream-json --verbose --model … --max-turns … --permission-mode … --permission-prompts none --setting-sources user --strict-mcp-config --no-session-persistence`, plus `--json-schema` when given and `--allowedTools …` only when the list is non-empty.

- The result line's `structured_output`, `num_turns` and `total_cost_usd` are read by `StreamState.finish()`.
- `askClaude()` (`src/jobs/common.ts`) picks the allowlist per kind and sets `permissionMode: 'dontAsk'` for triage only; every other kind uses `PERMISSION_MODE` from env (bypass, justified by the firewall check).
- **`--no-session-persistence` is on for every call**, so no run can be resumed today. The docs: "sessions are not saved to disk and cannot be resumed" ([CLI reference](https://code.claude.com/docs/en/cli-reference)).

## 1. `--json-schema` structured output

- How it works: the agent may use tools as normal; the schema is applied "after the agent completes its workflow", the SDK "validates the output against it, re-prompting on mismatch" ([structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs)). Result lands in `structured_output` on the final `result` message ([headless](https://code.claude.com/docs/en/headless#get-structured-output)), which `StreamState` already captures.
- Failure modes: subtype `error_max_structured_output_retries`; or `success` with no `structured_output`, which the docs say to treat as failure ([structured outputs, error handling](https://code.claude.com/docs/en/agent-sdk/structured-outputs#error-handling)).
- Schema dialect: validated as JSON Schema **draft-07**; zod needs `target: "draft-7"`. An invalid schema now fails at startup (v2.1.205+; before that it was silently ignored). `format` is annotation only. This matches ADR-0010 and `triageJsonSchema()` (drops `$schema`, emits draft-7).
- Fit: the **reviewer** is the natural user. A findings schema (e.g. `verdict: approve|revise|block`, `findings[]: {severity, file, line?, issue, suggestion}`) gives the runner something it can validate with zod, count, gate on, and hand to the reviser, exactly like triage. The reviser's output is a diff on the branch, so it needs no schema; it can keep the existing stop-signal protocol (`NEEDS_DECISION:`/`BLOCKED:`).
- Cost: re-prompts on a schema miss are extra turns; keep the schema flat with few required fields (docs' own advice).

## 2. A read-only reviewer: `--allowedTools` is not a sandbox

- `--allowedTools` lists "tools that execute without prompting"; "To restrict which tools are available, use `--tools` instead" ([CLI reference](https://code.claude.com/docs/en/cli-reference)). So under `bypassPermissions` (the build/propose default here) an allowlist restricts nothing.
- Triage is read-only today because of **`dontAsk`**: it "denies every call that would otherwise prompt", but still runs what needs no approval in manual mode, "file reads in your working directories and the read-only command set", plus anything the allowlist covers ([headless, auto-approve tools](https://code.claude.com/docs/en/headless#auto-approve-tools)). With `--permission-prompts none` the denial is final and Claude is told not to retry ([headless](https://code.claude.com/docs/en/headless#turn-off-permission-prompts-in-unattended-runs)).
- Hard removal of tools:
  - `--tools "Read,Glob,Grep,Bash"` restricts the built-in set (on Linux the default set leaves out Glob/Grep, so name them explicitly). It does not affect MCP tools (already off via `--strict-mcp-config`).
  - `--disallowedTools "Edit" "Write" "NotebookEdit"`: a bare name removes the tool from context; a scoped rule like `Bash(rm *)` only denies matching calls ([CLI reference](https://code.claude.com/docs/en/cli-reference)).
- Allowlist syntax: `Bash(git diff *)`. "The space before `*` is important: without it, `Bash(git diff*)` would also match `git diff-index`" ([headless, create a commit](https://code.claude.com/docs/en/headless#create-a-commit)). Same gotcha as `docs/agents/ARCHITECTURE.md`.
- Empty list: the CLI rejects `--allowedTools` with no values (ARCHITECTURE gotcha; `claudeArgs()` already omits it). A reviewer with *no* tools should pass `--tools ""` instead.
- Cheapest variant: put the diff in the prompt. The docs' own reviewer example pipes `git diff` / `gh pr diff` into `claude -p` "so Claude doesn't need Bash permission to read it" ([headless, build script](https://code.claude.com/docs/en/headless#add-claude-to-a-build-script)). The runner already holds the worktree, so it can compute the diff itself.
- Backstop: the reviewer still runs as `agent` behind the firewall; a throwaway worktree (as triage uses `d.wt.fresh('triage/readonly')`) means even a stray write never reaches the branch.

## 3. Session reuse for the reviser: `--session-id` / `--resume`

- Mechanics: `--session-id <uuid>` fixes the ID up front (no need to parse it from output); `--resume <id>` continues it; `--fork-session` resumes into a new ID, leaving the original intact ([CLI reference](https://code.claude.com/docs/en/cli-reference)). `-p` sessions are excluded from `--continue` and the picker but resumable by ID ([sessions](https://code.claude.com/docs/en/sessions#loop--p-agent-sdk-and-background-sessions)).
- Prerequisite: drop `--no-session-persistence` for the author run (and the reviser's resume).
- Storage: transcripts are `~/.claude/projects/<cwd with non-alphanumerics as ->/<session-id>.jsonl`, kept 30 days by default (`cleanupPeriodDays`), relocatable with `CLAUDE_CONFIG_DIR` ([sessions, where transcripts are stored](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)). Here that is `/home/agent/.claude/projects/…` (`AGENT_HOME` in `src/exec/run.ts`).
- Lookup by ID: searches the current project dir and its git worktrees, then every other project on the machine; the cross-project search needs v2.1.223+ ([CLI reference, `--resume`](https://code.claude.com/docs/en/cli-reference)). A transcript's absolute path also works as the `--resume` value.
- What a resume restores: full history including tool calls/results and the model. Not restored: `--mcp-config`, `--settings`, `--add-dir` (pass again; `claudeArgs()` always does). A `-p` resume starts in the permission mode a new `-p` run would. The system prompt recorded on the first request is reused until compaction ([sessions, what a resumed session restores](https://code.claude.com/docs/en/sessions#what-a-resumed-session-restores); [CLI reference, system prompt flags](https://code.claude.com/docs/en/cli-reference#system-prompt-flags-in-resumed-conversations)).
- Checkpoint (SIGINT) and restart:
  - SIGINT ends the turn cleanly; SIGTERM leaves it unfinished with no result. On resume, "Claude Code leaves the interrupted turn as it is, and your next prompt drives the conversation"; `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` continues it instead ([headless, SIGTERM](https://code.claude.com/docs/en/headless#stop-a-run-with-sigterm)). A tool still running when the process died is marked cut off, not re-run.
  - A daemon/container restart preserves the session because `/home/agent/.claude` is the named volume `claude-config` (`compose.yaml:30`, `deploy/docker-compose.yml:39`). It is lost on a recreated volume, after 30 days, or if an `update` changes the transcript format (the docs call the format internal). In those cases the resume fails with `No conversation found with session ID` and the runner must fall back to a fresh run.
- Don't resume one session from two processes: "messages from both interleave into one transcript" ([sessions, branch a session](https://code.claude.com/docs/en/sessions#branch-a-session)). Use `--fork-session` if a second consumer needs the author's context.
- Cost reporting gotcha: on `--resume`, `total_cost_usd` is "the conversation's whole total, earlier runs' spend included" ([headless](https://code.claude.com/docs/en/headless#pipe-data-through-claude)). `sumCost()` and the `job_runs` est. cost would double-count a resumed reviser unless the runner subtracts the author run's figure. `--max-budget-usd` ignores restored totals.

## 4. Subagents (`--agents`)

- Definition: `--agents '{"reviewer":{"description":…,"prompt":…,"tools":[…],"disallowedTools":[…],"model":"sonnet","maxTurns":…}}'`; with `-p` it can also be a file path (v2.1.281+), validated at startup (v2.1.242+) ([CLI reference](https://code.claude.com/docs/en/cli-reference); [subagents](https://code.claude.com/docs/en/sub-agents)). If both lists are set, `disallowedTools` is applied first, then `tools`.
- Isolation: a subagent runs in its own context window and "doesn't see your conversation history"; only its result returns to the parent. Nesting is allowed up to three levels by default (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`) ([subagents](https://code.claude.com/docs/en/sub-agents)).
- Already reachable: the build/propose allowlists include `Task`, `Agent` and `Skill` (`WRITE` in `src/jobs/common.ts`), so the author can spawn subagents today.
- Fit for review: an in-run `reviewer` subagent is cheap to wire, but:
  - the findings come back as free text to the **author**, which decides what to act on (self-grading);
  - the runner can't schema-validate them, because `--json-schema` applies to the parent's final output only;
  - the runner can't gate the PR on them or post them anywhere.
  - Good for an author's self-check before finishing; poor as the independent pre-PR gate.
- Observability: subagent messages carry `parent_tool_use_id`; `--forward-subagent-text` (v2.1.211+) adds their text ([headless, follow subagent messages](https://code.claude.com/docs/en/headless#follow-subagent-messages)). Rate-limit events and the checkpoint flow are unchanged. A SIGINT mid-subagent loses that subagent's partial work.

## 5. Relative usage cost

The docs give mechanisms, not ratios:

- Every request re-sends the conversation, re-read "at the cached token rate".
- The cache lives 1 h on a subscription (5 min on API keys or usage credits); after that the next request "reprocesses your full context".
- Subagents "count toward the same usage limits".

([costs](https://code.claude.com/docs/en/costs#why-usage-climbs-in-a-long-session); [sub-agents](https://code.claude.com/docs/en/sub-agents)). The table ranks the options cheapest first:

| Approach | Fixed context per request | Notes |
|---|---|---|
| Reviewer, fresh, diff in prompt, `--json-schema`, few/no tools | system prompt + diff | Cheapest and independent of author history. Can run on a smaller model (add a `review` model key). |
| Reviewer as subagent of the author | same as above, plus a summary added to the author | Same spend, but the output is unstructured and the author grades itself. |
| Reviser, fresh run (findings + branch diff in prompt) | system prompt + findings + diff, plus re-reads | Re-explores the files it touches. Survives restarts, checkpoints and volume loss. Same shape as today's build resume-from-branch. |
| Reviser via `--resume` of the author session | **the whole author transcript** (often 100k+ tokens) | Saves re-exploration. The first request reprocesses the full history uncached when the review gap is longer than the cache TTL, and every later turn carries it (cached). Near the auto-compact window it gets compacted anyway. Breaks if the transcript is gone. |

## Implications for the reviewer/reviser design

- **Reviewer = a new read-only job kind modeled on triage.**
  - Fresh worktree, `dontAsk` + `--permission-prompts none`.
  - `--disallowedTools Edit Write NotebookEdit` (or `--tools Read,Glob,Grep,Bash`) for hard removal, since the allowlist alone doesn't restrict under bypass.
  - Allowlist only `Bash(git diff *)`, `Bash(git log *)`, `Bash(git show *)`.
  - The runner puts the branch diff in the prompt.
  - Output: a draft-07 findings schema re-validated with zod (ADR-0010 pattern). The runner, not the agent, posts findings and decides the verdict.
- **Reviser: default to a fresh run with findings + diff**, the same shape as today's build resume-from-branch. Treat `--resume` as an optional optimisation:
  - store a runner-chosen `--session-id` with the checkpoint;
  - drop `--no-session-persistence` for author runs only;
  - fall back to a fresh run when the transcript is missing;
  - fix cost accounting for cumulative `total_cost_usd`.

  This trade-off is worth an ADR if adopted.
- **Don't use subagents as the gate.** They can't return schema-checked findings to the runner and they let the author grade itself. They're fine as an optional author self-check, which the current allowlist already permits.
- **Pin and check the CLI version** in the image. `--permission-prompts` (2.1.259) is already required. Cross-project `--resume` by ID (2.1.223) and `--agents` validation (2.1.242) matter for this design.
- **Resume across restarts works with today's deploy** (`claude-config` volume), but the transcripts mix with the agent's settings. If resume is adopted, consider `CLAUDE_CONFIG_DIR` or `cleanupPeriodDays` so retention is deliberate.

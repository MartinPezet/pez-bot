# pez-bot

A self-hosted Docker service that works through a GitHub-hosted backlog unattended, using Claude Code in headless mode. It turns issues into OpenSpec proposals, waits for you to approve them (by merging the proposal PR), implements them, runs your gates, and opens implementation PRs for review. It never merges, never pushes to your default branch and never closes issues.

It is project-agnostic: the target repo is an input, and everything project-specific lives in that repo (`.backlog-runner.json`, `openspec/`, optional prompt overrides).

```
issue [state:inbox]
   │ triage (Claude, read-only codebase access) at the start of each run window
   ▼
state:ready ◄── state:needs-decision ◄── you answer in a comment
   │ work: propose (Claude writes openspec/changes/issue-N-*)
   ▼
proposal PR [state:proposal-review] ── you MERGE = approve, close = needs-decision
   │ sync promotes merged proposals
   ▼
state:approved
   │ work: build (apply → gates → fix loop)
   ▼
implementation PR [state:pr-review] ── you review and merge → issue closes

anything failing ──► state:blocked + comment + draft PR with partial work
usage limit / window end ──► work pushed to change/issue-N, issue requeued, resumed later
weekdays 07:30 ──► morning summary in the digest discussion
```

Labels are the state machine. PR merges are the only approvals.

## Contents

- [First run](#first-run)
- [Your daily loop](#your-daily-loop)
- [Commands](#commands)
- [Testing against a sandbox repo](#testing-against-a-sandbox-repo)
- [Environment variables](#environment-variables)
- [Project config: `.backlog-runner.json`](#project-config-backlog-runnerjson)
- [Usage budget and run windows](#usage-budget-and-run-windows)
- [Security model](#security-model)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## First run

### 1. GitHub credentials

**GitHub App (recommended).** Create an App under your account (Settings → Developer settings → GitHub Apps):

- Repository permissions: **Contents** read/write, **Issues** read/write, **Pull requests** read/write, **Discussions** read/write, **Metadata** read.
- No webhook needed.
- Install it on the target repo **and** the digest repo. Both must be under the same owner, so one installation covers them.
- Note the App ID and the installation ID (the number at the end of the installation's settings URL), and generate a private key.
- Put the key in `./secrets/gh-app.pem` on the host, owned by root with mode `0400`:

  ```bash
  sudo chown root:root secrets/gh-app.pem && sudo chmod 0400 secrets/gh-app.pem
  ```

  The container refuses to start if the agent user could read it.

  **On Docker Desktop (Windows or macOS)** bind-mounted files always look world-readable inside the container, so the key file can't pass that check. Put the key in `.env` instead, base64-encoded on one line, and leave `GH_APP_PRIVATE_KEY_FILE` empty. In PowerShell:

  ```powershell
  [Convert]::ToBase64String([IO.File]::ReadAllBytes("gh-app.pem"))
  ```

  Paste the output as `GH_APP_PRIVATE_KEY=…`. The key then lives only in the root and runner processes' environment, which the agent user can't read.

PRs and comments then appear as `your-app[bot]`, and you review and merge them as yourself.

**Classic PAT (fallback).** Create a bot user, add it as a collaborator on both repos, and give it a classic PAT with the `repo` scope. Set `GH_TOKEN`. Fine-grained PATs don't work for a bot that is only a collaborator on a personal repo.

### 2. Claude credentials

On any machine with Claude Code, run `claude setup-token` and put the result in `CLAUDE_CODE_OAUTH_TOKEN` (Pro/Max plan). Alternatively set `ANTHROPIC_API_KEY`.

### 3. The digest

In `DIGEST_REPO` (a central repo shared by all your projects):

1. Enable Discussions (Settings → General → Features).
2. Create a category named `Daily Digest` (or your `DIGEST_CATEGORY`) with the **Announcement** format.
3. Start a discussion in it titled exactly your project's `displayName` (for example `EarthScope`). Announcement categories only let maintainers start discussions; the bot only comments. Or set `DIGEST_AUTO_CREATE=true` if the bot has maintain rights.

### 4. Configure and start

```bash
cp .env.example .env    # fill it in; keep DRY_RUN=1 for now
docker compose up -d
docker compose logs -f runner
```

That builds the image locally from `docker/Dockerfile`. **To deploy on a server**, use [`deploy/docker-compose.yml`](deploy/docker-compose.yml) instead: it pulls the image CI pushed to your registry, so the server only needs that file, `.env` and `secrets/`:

```bash
docker login <your-registry>
docker compose pull && docker compose up -d
```

Set `RUNNER_IMAGE=<your-registry>/pez-bot:latest` in `.env` (or a specific `:<sha>` to pin or roll back).

### 5. Set up the target repo

```bash
docker compose exec runner pez-bot setup
```

This creates the labels, checks the digest discussion, and, if the repo lacks `.backlog-runner.json` or `openspec/` (or an `openspec/config.yaml` context), opens **one PR** scaffolding them. Edit that PR (gates, areas, test service versions, `allowedAuthors`, and the TODOs in the context), merge it, then run `setup` again: it creates the `area:` labels and should end with `Setup complete.`

### 6. Move an existing PRD into issues (optional)

```bash
docker compose exec runner pez-bot migrate-prd --path PRD.md --ignore-budget
```

Claude converts the PRD into `.backlog-runner/migration/backlog.json` and `skipped.md` and the runner opens a PR with just those files. Review and edit them in the PR, merge, then:

```bash
docker compose exec runner pez-bot migrate-prd --apply
```

This creates the issues (`state:inbox`) and skips titles that already exist, so it's safe to re-run.

### 7. Dry run, then go live

With `DRY_RUN=1` every GitHub write (labels, comments, PRs, pushes, the digest) is logged as `dry-run: would …` instead of performed. Claude still runs, so dry runs spend usage. Watch a few cycles:

```bash
docker compose exec runner pez-bot sync
docker compose exec runner pez-bot work --ignore-budget
docker compose logs runner | grep 'dry-run: would'
```

When you're happy, set `DRY_RUN=0` in `.env` and `docker compose up -d`.

## Your daily loop

1. Read the 07:30 summary in the digest discussion.
2. Answer `needs-decision` questions as issue comments; triage picks them up at the next window.
3. Review proposal PRs: cheap, high-leverage review. Merge to approve, or close with a comment.
4. Review implementation PRs and merge.
5. For `blocked`: read the comment, fix or answer, and relabel `state:ready` (re-propose) or `state:approved` (re-build).
6. Add `urgent` to an issue to jump the queue (only you set it; triage never touches it).

## Commands

Run as `docker compose exec runner pez-bot <cmd>` (preferred) or `docker compose run --rm runner <cmd>`. A command run while the daemon is mid-job waits its turn: it exits with code 75 ("skipped") rather than overlapping.

| Command | What it does |
|---|---|
| `daemon` | The scheduler (default) |
| `sync` | Fetch, recover interrupted issues, promote merged/closed proposals. No Claude. |
| `work [--ignore-budget]` | Sync, then build or propose one item, if the window and budget allow. `--ignore-budget` skips both. |
| `triage [--ignore-budget]` | Triage inbox items and answered questions. |
| `summary` | Post the morning summary to the digest (if there's anything to say). |
| `update` | Update Claude Code, OpenSpec and Superpowers, with smoke test and rollback. |
| `cleanup` | Worktrees, merged/closed branches, logs, transcripts, SQLite vacuum; disk guard. |
| `status` | Queue counts, current and recent jobs, costs, versions, usage, gate, next window, disk, health. |
| `setup` | Labels, Discussions checks, scaffolding PR. |
| `migrate-prd [--path PRD.md] [--ignore-budget]` | PRD → `backlog.json` PR. |
| `migrate-prd --apply` | Create issues from the merged `backlog.json`. |
| `updates resume` | Clear the 7-day update pause after a rollback. |
| `usage [--probe]` | Gauge readings, gate state and window schedule. `--probe` takes a fresh reading. |
| `healthcheck` | Exit 0 if healthy (the Docker `HEALTHCHECK`). |

Schedule (in the project's time zone): `sync` every 20 min, `work` every 5 min and continuously while it finds work inside a window, `triage` at the start of each window, `summary` weekdays 07:30, `update` 03:00 and on start, `cleanup` 04:00 and after every job. Override with `schedule` in `.backlog-runner.json` (restart to apply).

## Testing against a sandbox repo

Before pointing it at a real project, create a throwaway repo (for example `you/pez-bot-sandbox`) with a tiny Node project whose `pnpm typecheck/lint/test` pass, a digest discussion, and a few issues. Then:

```bash
TARGET_REPO=you/pez-bot-sandbox scripts/e2e-dry-run.sh
```

The script runs the whole stack with `DRY_RUN=1` under a separate compose project (its own volumes), runs `setup`, `sync`, `summary` and `status`, checks the health check and firewall, and prints every intended write. Set `E2E_CLAUDE=1` to include `triage`, `work` and a usage probe (these spend plan usage). `KEEP=1` leaves the stack running.

## Environment variables

Account-level settings live in `.env`, not in project config, because the usage budget is shared across everything you run. `.env.example` lists them all with comments.

| Variable | Default | Meaning |
|---|---|---|
| `TARGET_REPO` | image build arg | `owner/name` of the repo to work on. Overrides the value baked into the image. |
| `GH_APP_ID`, `GH_APP_INSTALLATION_ID`, `GH_APP_PRIVATE_KEY_FILE` | | GitHub App auth (all three). |
| `GH_APP_PRIVATE_KEY` | | The App key inline (base64 of the `.pem`), instead of `GH_APP_PRIVATE_KEY_FILE`. Use on Docker Desktop. |
| `GH_TOKEN` | | Classic PAT, instead of the App. |
| `CLAUDE_CODE_OAUTH_TOKEN` | | From `claude setup-token`. |
| `ANTHROPIC_API_KEY` | | Instead of the OAuth token. |
| `DIGEST_REPO` | | `owner/name` of the repo holding the digest discussions. |
| `DIGEST_CATEGORY` | `Daily Digest` | Discussion category (Announcement format). |
| `DIGEST_AUTO_CREATE` | `false` | Let the bot create the project's discussion. |
| `DRY_RUN` | `0` | Log GitHub writes and pushes instead of doing them. |
| `PERMISSION_MODE` | `acceptEdits` | Claude permission mode. `bypassPermissions` is only used behind a verified firewall (all Claude jobs require one). |
| `USAGE_PROBE` | `on` | Actively probe usage when there's no fresh reading. |
| `USAGE_MAX_AGE_MIN` | `30` | How fresh a usage reading must be; also the minimum time between probes. |
| `USAGE_UNKNOWN_POLICY` | `allow` | With no fresh reading and a failed probe: `allow` (run, and report it in the digest) or `block`. |
| `WEEKLY_STOP_PCT` | `80` | No non-urgent Claude job at or above this weekly utilisation. |
| `WEEKLY_HARD_STOP_PCT` | `95` | Not even urgent work at or above this. |
| `FIVE_HOUR_START_MAX_PCT` | `60` | No non-urgent job at or above this 5-hour utilisation. |
| `RUN_WINDOWS` | `mon-fri 09:00-12:00; mon-fri 22:00-02:00` | When Claude jobs may start, in the project time zone. A window belongs to the day it starts. Days: `mon`…`sun`, ranges (`mon-fri`), lists (`sat,sun`) or `daily`. |
| `WINDOW_GRACE_MIN` | `20` | A job still running this long after its window closes is checkpointed. |
| `URGENT_IGNORES_WINDOWS` | `true` | `urgent` issues may start outside windows. |
| `TZ` | `Europe/London` | Process time zone; the project's `timezone` drives windows and the digest. |
| `KEEP_BLOCKED_WORKTREES_DAYS` | `3` | Keep a blocked job's worktree this long for inspection. |
| `RETENTION_DAYS` | `14` | Logs, transcripts and usage readings older than this are deleted. |
| `MIN_FREE_DISK_GB` | `10` | Disk guard threshold. |
| `HEALTH_PING_URL` | | healthchecks.io / Uptime Kuma push URL: pinged after each job, `/fail` on errors. Its host is added to the firewall. |
| `EXTRA_ALLOWED_DOMAINS` | | Comma-separated extra hosts for the egress firewall (for example a private registry your install needs). |
| `INSTALL_SUPERPOWERS` | `false` | Install and update the Superpowers plugin. |
| `CLAUDE_CHANNEL` | `stable` | Claude Code release channel used by `update`. |
| `LOG_LEVEL` | `info` | |
| `BOT_GIT_NAME`, `BOT_GIT_EMAIL` | `pez-bot` | Commit identity. For an App, use `your-app[bot]` and `<app-user-id>+your-app[bot]@users.noreply.github.com`. |
| `RUNNER_IMAGE` | `pez-bot:local` | Image to run (compose). |
| `POSTGRES_TEST_IMAGE`, `REDIS_TEST_IMAGE` | `postgres:16-alpine`, `redis:7-alpine` | Sidecars; match production's major versions. |

## Project config: `.backlog-runner.json`

Read from the target repo's default branch before every job and validated strictly; unknown keys are errors. If it's missing or invalid, no project job runs and `status` shows exactly what's wrong.

| Field | Default | Meaning |
|---|---|---|
| `displayName` | required | Project name; also the digest discussion title. |
| `defaultBranch` | repo default | |
| `install` | required | Install command, for example `["pnpm","install","--frozen-lockfile"]`. |
| `gates` | required | Commands that must pass, in order, for example `[["pnpm","typecheck"],["pnpm","lint"],["pnpm","test"]]`. |
| `areas` | required | Allowed `area:` labels (lower-kebab-case). |
| `wip.proposalsInReview`, `wip.prsInReview` | `3`, `3` | Open proposal/implementation PRs before the runner stops starting new ones. `urgent` doesn't bypass these. |
| `maxFixAttempts` | `2` | Fix rounds after failing gates. |
| `testServices.postgres` | | `{ "version": "16", "env": "DATABASE_URL", "database": "app_test", "schema": "public" }`: the URL variable gates receive, and what's reset (schema dropped and recreated) before every build's gates. Optional `vars` also hands out the parts separately, for apps that don't read a URL: `{ "host": "DB_HOST", "port": "DB_PORT", "user": "DB_USER", "password": "DB_PASSWORD", "database": "DB_DATABASE" }` (any subset). |
| `testServices.redis` | | `{ "version": "7", "env": "REDIS_URL" }`: flushed before every build's gates. Optional `vars`: `{ "host": …, "port": …, "password": … }`. |
| `testServices.*.version` | | Production's major version. Before each build the runner checks the sidecar's actual version; on a mismatch builds are held (issues untouched), the digest says once what to set (`POSTGRES_TEST_IMAGE` / `REDIS_TEST_IMAGE`), and `setup` reports it. |
| `extraTestEnv` | `{}` | Extra env vars for installs and gates (for example the dummy values your app's env validation requires). Any name is allowed, but values that look like real credentials (`ghp_…`, `sk-ant-…`, private keys, `user:pass@` URLs) are rejected: this file is committed, so use dummies. |
| `timezone` | `Europe/London` | For windows, cron and the digest. |
| `schedule` | | Cron overrides: `sync`, `summary`, `update`, `cleanup`. |
| `allowedAuthors` | required | GitHub logins whose issues and comments the runner acts on. Everything else is ignored (and noted once in the digest). |
| `models` | `sonnet` each | Model per job: `propose`, `build`, `fix`, `triage`, `migrate`. Opus burns Pro limits fastest. |
| `claude.maxTurns`, `claude.timeoutMin` | `150`, `90` | Per Claude call. |
| `claude.extraAllowedTools` | `[]` | Extra tool rules for propose/build, for example `["Bash(node ace *)"]`. |

**Prompt overrides:** put `.backlog-runner/prompts/<name>.md` (`propose`, `apply`, `fix`, `validate-fix`, `triage`, `prd-to-backlog`) on the default branch to replace a built-in prompt. Templates use `{{VARIABLE}}` placeholders; see `src/prompts/`.

**Project context:** agents read `openspec/config.yaml` (`context:`), and `openspec/project.md` if present.

## Usage budget and run windows

The runner shares your Pro plan with you, so every Claude job (propose, build, fix, triage, migrate-prd) passes a gate first:

1. **Windows:** a job only starts inside `RUN_WINDOWS` and only if the time left covers its estimate (the median of the last 10 runs of that kind; defaults propose 20 min, build 60, triage 15). A job still running `WINDOW_GRACE_MIN` after the window closes is checkpointed. Inside a window the next job starts as soon as the previous one finishes.
2. **Budget:** weekly ≥ `WEEKLY_STOP_PCT` holds non-urgent work until the weekly reset; 5-hour ≥ `FIVE_HOUR_START_MAX_PCT` holds non-urgent work; `urgent` ignores both (and windows) but never starts at ≥ `WEEKLY_HARD_STOP_PCT`.
3. **Limit hit mid-run:** the run stops, work in progress is committed and pushed to `change/issue-N`, the issue goes back to its queue (not blocked), and nothing starts until the reset time.

**How usage is read.** There's no official API yet, so the `UsageGauge` combines:

- **Passive:** every Claude run uses `--output-format stream-json`; each `rate_limit_event` is recorded. It's documented, but it often carries only a status (`allowed`, `allowed_warning`, `rejected`), with a utilisation figure only near a threshold.
- **Probe:** with no fresh reading, a one-turn Haiku call (one tiny request, at most once per `USAGE_MAX_AGE_MIN`) whose stream carries the same events. (`claude -p "/usage"` was tried and doesn't help: headless, it reports only the session's own cost and tokens, not plan limits.)

In practice the percentages are often unknown until usage nears a threshold. The digest says so once per occurrence, and with the default `USAGE_UNKNOWN_POLICY=allow` work continues, relying on the passive `allowed_warning`/`rejected` handling as the safety net. Set `block` if you'd rather hold non-urgent work whenever usage is unknown.

`pez-bot usage` shows the readings, gate state and windows. The rules apply to the runner only; nothing here ever limits your own use of Claude.

## Security model

- **Two users.** `runner` holds the GitHub credentials, state and logs and does every GitHub write and `git push`. `agent` runs Claude, installs and gates (agent-written code) through `sudo -u agent env -i …`, so it sees only Claude's own auth and the test service URLs. It can't read the runner's environment, `/data/state`, logs or the App key.
- **Structured outputs.** Agents end with stop-signal lines (`NEEDS_DECISION:`, `NEEDS_SPLIT:`, `BLOCKED:`) or return schema-validated JSON (triage). The runner validates and applies them; only labels from the allowed set are ever applied, and `urgent` is never set or removed by the bot.
- **Prompt-injection guard.** Only issues and comments by `allowedAuthors` (plus the bot's own comments) reach prompts or move state.
- **Egress firewall.** Default-deny (IPv4 and IPv6), modelled on Anthropic's devcontainer `init-firewall.sh`. Allowed: Anthropic API and auth hosts, Claude Code downloads, GitHub (published `/meta` ranges plus its content hosts), the npm registry, the health ping host, `EXTRA_ALLOWED_DOMAINS`, DNS to the configured resolvers, and the sidecar network. Verified at start (`example.com` must fail, GitHub and Anthropic must succeed) and re-resolved every 15 minutes. Claude jobs are refused unless the check passed. The runner process drops `NET_ADMIN`/`NET_RAW` before it starts.
- **No repo-supplied hooks or MCP servers** in unattended runs (`--setting-sources user --strict-mcp-config`).
- **Redaction** of tokens and keys in logs, comments, PR bodies and the digest.
- The Docker socket is never mounted.

## Troubleshooting

**An item is `state:blocked`.** The latest bot comment says why; a draft PR holds any partial work, and its worktree is kept for `KEEP_BLOCKED_WORKTREES_DAYS` under the `worktrees` volume. Fix or answer, then relabel `state:ready` (re-propose) or `state:approved` (re-build; it resumes from `change/issue-N` if that branch exists). If the default branch itself is red, every build blocks: fix main first.

**The firewall check fails.** `status` and the logs show the reason (also in the digest). Typical causes:

- No `NET_ADMIN`/`NET_RAW` (check `cap_add`).
- DNS for an allowed host failing at start.
- A host your install needs that isn't allowed: add it to `EXTRA_ALLOWED_DOMAINS`.

`docker compose exec runner cat /data/state/firewall.json` shows the last result. Restart the container to re-run setup.

**Claude Code was rolled back.** The digest says which version failed its smoke test. Updates pause for 7 days. When a fixed version is out, run:

```bash
docker compose exec runner pez-bot updates resume
```

The next `update` (03:00, on restart, or run by hand) then tries again. History is in `status`.

**Usage shows unknown.** Run `pez-bot usage --probe` to see why the probe failed. The digest reported it once. With `USAGE_UNKNOWN_POLICY=allow` work continues; set `block` to hold non-urgent work instead.

**The digest isn't posting.** `pez-bot setup` prints the exact problem (Discussions off, category missing, discussion title doesn't match `displayName`). Events are kept and posted once it's fixed.

**Disk low.** The disk guard cleans aggressively. If it's still below `MIN_FREE_DISK_GB`, Claude jobs are skipped, the container reports unhealthy and the digest says so.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run dev -- status     # tsx, against DATA_DIR (default /data)
```

Unit tests fake GitHub, git, Claude and subprocesses; nothing shells out. CI (`.github/workflows/image.yml`) runs typecheck and tests, builds the image (amd64, arm64 optional on manual runs), and pushes `:sha` and `:latest` to `REGISTRY_URL` on pushes to `main` and weekly.

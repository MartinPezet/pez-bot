# pez-bot: containerised backlog runner — PLAN

Status: **approved 2026-10-05** with the decisions in §8.

Research was done on 2026-10-04 against current docs. Version-specific facts are tagged `[verified]` (seen in official docs today), `[observed]` (third-party reports, not official) or `[unverified]` (I'll confirm during the named milestone).

---

## 1. What I verified (and what changed since the reference draft)

### Claude Code
- **Install:** `curl -fsSL https://claude.ai/install.sh | bash -s <version|stable|latest>` installs the native binary to `~/.local/share/claude/versions/<v>`, with a launcher symlink at `~/.local/bin/claude`. `claude install <version>` reinstalls a given version; I'll use it for rollback. The installer keeps the two newest versions plus the active one. `[verified]`
- **Updates:** `DISABLE_AUTOUPDATER=1` (env, or `env` in settings.json) stops the background updater. `claude update` and `claude install` still work, which is what we want. `DISABLE_UPDATES` would block those too, so we **don't** set it. `autoUpdatesChannel: "stable"` in settings picks the release channel. `[verified]`
- **Headless flags:** `-p`, `--output-format text|json|stream-json` (stream-json needs `--verbose`), `--permission-mode default|acceptEdits|plan|auto|dontAsk|bypassPermissions`, `--allowedTools`, `--disallowedTools`, `--max-turns`, `--model`, `--json-schema` (validated output in `structured_output` on the result message), `--permission-prompts none` (v2.1.259+), `--no-session-persistence`, `--max-budget-usd`. `[verified]`
  - **Allowlist syntax changed.** Docs now use `Bash(git diff *)`, with a space before `*`. The reference uses `Bash(git diff:*)`. I'll convert the allowlist and test that the old form is still accepted.
  - **Don't use `--bare`.** It skips plugins (so no Superpowers) and *never reads OAuth credentials*, so it needs `ANTHROPIC_API_KEY`. Instead: `--setting-sources user` and `--strict-mcp-config`, so a target repo's `.claude/settings.json` hooks and `.mcp.json` don't run unattended.
  - **SIGTERM** makes `claude -p` exit 143 and record no result. **SIGINT** ends the turn cleanly. The runner sends SIGINT first, then SIGTERM. `[verified]`
- **Auth:** `CLAUDE_CODE_OAUTH_TOKEN` comes from `claude setup-token`, which is documented as "for CI and scripts" and needs a subscription. `ANTHROPIC_API_KEY` is the alternative. `claude auth status` returns JSON with `authMethod`, which `status` and the health check use. `[verified]`
- **Plugins:** `claude plugin install superpowers@claude-plugins-official` (Superpowers is now in the official marketplace), `claude plugin update <id>`, `claude plugin list --json`. `[verified]`
- **Hosts Claude Code needs:** `api.anthropic.com`, `platform.claude.com` (OAuth token exchange and refresh, including for claude.ai accounts), `claude.ai`, `downloads.claude.ai` (installer, updates, plugin executables), `registry.npmjs.org`, `github.com` (plugin marketplaces), `storage.googleapis.com` (plugin metadata). Datadog telemetry hosts are optional; `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` turns them off. `[verified]`

### Anthropic's devcontainer `init-firewall.sh` `[verified]`
It uses iptables with an ipset `hash:net`. It adds GitHub `/meta` `web+api+git` CIDRs (merged with `aggregate`), resolves each allowed domain's A records with `dig` **once at start**, allows DNS, SSH, loopback and the host's `/24`, and sets every default policy to DROP. Its self-check expects `example.com` to fail and `api.github.com/zen` to succeed. Weaknesses I'll fix:
1. **IPs resolved once go stale.** `registry.npmjs.org` (Cloudflare) and the Anthropic hosts rotate addresses. I'll re-resolve every 30 minutes and before every Claude job. Additions are atomic: build a temp ipset, then `ipset swap`.
2. **IPv4 only.** The script never touches ip6tables. I'll set ip6tables to default DROP (or disable IPv6 in compose via `sysctls`).
3. **"Host network /24" is too broad.** It reaches the home LAN gateway. I'll allow only Docker DNS (127.0.0.11), the sidecar subnet and the health-ping host.
4. **GitHub ranges:** `/meta` has no separate `codeload` or `objects` keys. Those hosts sit under `web`, and `objects.githubusercontent.com` / `raw.githubusercontent.com` also need DNS resolution. I'll resolve them explicitly as well. `[unverified until M2]`

### OpenSpec `[verified]`
- Current version **1.14.0** (`@fission-ai/openspec`). It has moved to the "OPSX" workflow. **Project context now lives in `openspec/config.yaml` under `context:`.** `project.md` is legacy, and `openspec init`/`update --force` cleans it up.
- Commands: `openspec init --tools none` (non-interactive), `openspec list [--specs] [--json]`, `openspec validate <id> --strict [--no-interactive]`, `openspec archive <id> --yes`, `openspec update`.
- **Impact:** the reference prompts say "read `openspec/project.md`". I'll change them to read `openspec/config.yaml` (and `project.md` if present), and `setup` will scaffold `config.yaml` with the EarthScope `project.md` content as `context:`. Decided: `config.yaml` (§8.6).
- I'll pin the OpenSpec version and update it through the `update` job. The project moves fast, and `archive` has gained a "semantic merge" mode, so M4 needs a check that `archive --yes` is still deterministic.

### GitHub Discussions GraphQL `[verified]`
- `repository.discussionCategories(first:25)` lists categories (at most 25 per repo). `repository.discussions(categoryId:, first:, after:)` lists by category. **There's no title filter**, so I'll page through and match the title exactly, then cache the node ID.
- `createDiscussion(input:{repositoryId, categoryId, title, body})`.
- `addDiscussionComment(input:{discussionId, body, replyToId})`. `replyToId` must be a **top-level** comment, since GitHub threads only one level deep. That fits the day-comment → replies design exactly.
- **No mutation creates categories.** You were right: `setup` can only check for the category and tell you to create it.

### Reading Pro-plan usage headlessly: options ranked

| # | Mechanism | Cost | Gives | Reliability / breakage risk |
|---|---|---|---|---|
| A | **Passive `rate_limit_event`** in `stream-json` | free (part of every job) | `rate_limit_info.status` ∈ `allowed`/`allowed_warning`/`rejected`, `resetsAt?`, `utilization?` `[verified type]`. Observed extras: `rateLimitType` (`five_hour`/`seven_day`), `surpassedThreshold`, `unifiedWindows.{five_hour,seven_day}.{utilization,resetsAt}` `[observed]` | **Official** (in the SDK type docs). But `utilization` is optional and only appears near a threshold, so a plain `allowed` tells you "under the warning threshold" and nothing more. Good for detecting `rejected` and warnings; weak as a gauge. **Low breakage risk.** |
| B | **`claude -p "/usage"`** | **no model call** (local command) | Docs `[verified]`: "When you send a command such as `/context` or `/usage` as a prompt, its output arrives as an assistant message." `/usage` shows plan usage limits on Pro. | Official entry point, but the output is **human-readable text**, so I'd scrape it with a regex. **Medium risk:** wording changes break the parser. Mitigations: fixture tests, and on parse failure fall back to C and report it. Internally it hits the same endpoint as D, so it may get 429s if called too often, but once per 30 min is fine. `[unverified that -p output includes 5h/weekly %, checked in M5]` |
| C | **One-token Haiku probe** (`claude -p --model haiku --max-turns 1 "Reply with OK"` with stream-json) | ~1 tiny request | Whatever A gives. | Official, but has A's weakness: often no number. Shows status and reset times reliably. |
| D | Raw `GET api.anthropic.com/api/oauth/usage` with `anthropic-beta: oauth-2025-04-20` | free | Exact `five_hour`/`seven_day` utilisation and resets | **Undocumented.** Known to 429 aggressively and stay rate-limited for hours ([anthropics/claude-code#31637](https://github.com/anthropics/claude-code/issues/31637), closed "not planned"). Needs the OAuth token outside Claude Code, which may be a terms-of-use grey area. **High risk. I won't use it.** |
| E | Raw `/v1/messages` call reading `anthropic-ratelimit-unified-5h-utilization` / `-7d-` headers | 1 token | Exact numbers on every call | Undocumented headers, same OAuth-token-outside-Claude-Code concern. **High risk. I won't use it.** |
| F | Status line JSON `rate_limits.five_hour/seven_day.used_percentage` | — | Exact numbers | **Officially documented** `[verified]`, but only fires in the interactive TUI, not in `-p`. Not usable today. It's the most likely official route later, so the gauge interface is shaped to match it. |

**Proposal:** `UsageGauge` = passive A, plus active probe B with fallback C. A reading stores `{bucket, utilization|null, status, resetsAt, source, at}`. Gate logic treats `utilization:null, status:allowed` as **unknown value** for the gates, not as zero. The unknown-usage policy then applies, so with `block`, an A-only world blocks a lot. If B turns out not to report percentages in `-p`, raise it with you before M5 lands, because that decides whether `USAGE_UNKNOWN_POLICY=block` is livable.

---

## 2. Places I think the requirements are wrong or need adjusting

1. **A fine-grained PAT won't work for a bot account on your personal repo.** GitHub docs: fine-grained PATs can't be used to contribute to repos where the user is a collaborator, and their resource owner must be the token's own user or an org. A fine-grained PAT is also "scoped to the one repo", which conflicts with also needing Discussions write on `DIGEST_REPO`. **Recommendation:** make the **GitHub App** the primary path. It works on personal repos, gets installed on both repos, needs Contents/Issues/Pull requests/Discussions read-write plus Metadata read, and its PRs show as `yourapp[bot]`. Support a **classic PAT** (`repo` scope) for a bot user as the simple fallback. Keep fine-grained PATs only for org-owned repos.
2. **A stripped environment isn't enough on its own.** If Claude (and the gate commands, which run agent-written code) run under the **same uid** as the runner, they can read `/proc/<runner>/environ`, the App private key, gh config and SQLite. **Proposal:** two users. `runner` owns secrets and state. `agent` runs `claude`, install and gates, through a narrow `sudo -u agent` rule with `env_reset` and an explicit env allowlist. Worktrees are group-writable by both. This is the one structural change I'd make to your security model.
3. **The runner's git must not leave a credential on disk.** No `gh auth setup-git` and no `hosts.yml`. Pushes go through a per-invocation `GIT_ASKPASS` that reads the token from the runner's memory, so `agent` can never reuse it.
4. **"Cost" on a Pro plan is notional.** `total_cost_usd` is a client-side API-price estimate, not money spent. I'll record it as `est_cost_usd` plus tokens and turns, and label it that way in `status`.
5. **`--json-schema` beats parsing JSON out of prose for triage.** The CLI validates the output and puts it in `result.structured_output`. The runner still re-validates it with zod and enforces the label allowlist.
6. **Crash recovery should change.** The reference blocks anything left in `proposing`/`building`. With checkpoint/resume and a SQLite job log, a container restart mid-job is normal (updates, reboots). Decided: requeue (§8.2).
7. **`docker compose run --rm runner <cmd>` starts a second container** next to the daemon, which could break "one job at a time". I'll add a SQLite lease (`job_lock` row with pid, host and heartbeat). CLI jobs refuse or wait if the daemon holds it. Read-only commands (`status`, `usage`) skip the lock. I'll document `docker exec` as the main way to run commands.
8. **Window start rule vs. "start next job immediately":** these can starve a long build late in a window. That's the intended behaviour, and I just want you to know it happens: with the 09:00–12:00 window and a 60-minute median build, no build starts after 11:00.
9. **The health check must not call the network.** The Docker `HEALTHCHECK` reads results that the daemon caches in SQLite (GitHub auth check every 30 min, last firewall check, disk). Otherwise a GitHub blip would mark the container unhealthy and churn restarts.

---

## 3. Architecture

```
┌──────────────────────── runner container ───────────────────────────────┐
│ tini (PID 1)                                                              │
│  └─ entrypoint.sh (root): firewall up → self-check → chown volumes        │
│       └─ setpriv → node dist/cli.js daemon   (uid runner, no caps)        │
│            ├─ Scheduler (croner, one in-process queue, SQLite lease)      │
│            ├─ Jobs: sync · work · triage · summary · update · cleanup     │
│            ├─ GitHub layer (GraphQL+REST via fetch; DRY_RUN → log only)   │
│            ├─ Digest (Discussions, batched per job)                       │
│            ├─ UsageGauge · BudgetRules · RunWindows                       │
│            └─ sudo -u agent → claude -p … / pnpm install / gates          │
└───────────┬─────────────────────────────────────────────────────────────┘
            │ internal network `testnet` (no egress)
   ┌────────┴────────┐
   postgres-test     redis-test
```

**Decisions:**
- **GitHub API over HTTP, not the `gh` CLI**, from the runner (Node 22's `fetch`, with no Octokit dependency). This makes dry-run and mocks trivial and keeps tokens in memory. `gh` stays in the image only for you to debug by hand.
- **Git via `execa`** as `runner` for fetch/push/worktree, and as `agent` only inside worktrees, run by Claude itself.
- **One process, one job at a time.** Croner triggers push onto an in-memory queue, deduplicated by job name. `work` re-queues itself straight away while a window is open and the budget allows.
- **Labels are the state machine**, ported exactly from `run.mts`. SQLite holds only runner-local facts: job runs, usage readings, digest IDs, checkpoints, update history and caches. GitHub stays the source of truth.

---

## 4. Module layout

```
src/
  cli.ts                  # arg parsing (node:util parseArgs), command dispatch
  config/
    env.ts                # zod schema for account-level env vars
    project.ts            # zod schema for .backlog-runner.json + loader (reads from origin/<default>)
  state/
    db.ts                 # better-sqlite3, migrations, WAL
    lock.ts               # job lease
  log.ts                  # pino + redaction (secret values + token patterns)
  redact.ts
  exec/
    run.ts                # execa wrapper: user (runner|agent), env allowlist, timeouts, tail()
    git.ts                # Git interface + impl
    claude.ts             # Claude interface: stream-json runner, rate_limit_event tap, SIGINT/SIGTERM
  github/
    client.ts             # GitHub interface; HttpGitHub + DryRunGitHub (decorator that logs writes)
    auth.ts               # PAT | App (JWT RS256 via node:crypto, installation token refresh @ T-10min)
    labels.ts             # label set, setState()
    authors.ts            # allowlist filtering for issues/comments
  digest/
    digest.ts             # event batching, post-only-if-nonempty, day-thread resolution & recovery
  usage/
    gauge.ts              # UsageGauge interface + CompositeGauge
    passive.ts            # rate_limit_event parser
    probe-usage-cmd.ts    # `/usage` scraper
    probe-haiku.ts
    rules.ts              # BudgetRules (pure)
  windows/
    windows.ts            # parse "mon-fri 09:00-12:00; …", tz/DST maths (pure, Intl-based)
    estimate.ts           # rolling median durations
  jobs/
    sync.ts  work.ts  propose.ts  build.ts  triage.ts  summary.ts  update.ts  cleanup.ts
    setup.ts  migrate-prd.ts
  prompts/                # built-in prompts (genericised; override from target repo)
    propose.md apply.md fix.md triage.md prd-to-backlog.md validate-fix.md
  scheduler.ts
  health.ts               # healthcheck command + dead man's switch
docker/
  Dockerfile  entrypoint.sh  init-firewall.sh  sudoers.agent  healthcheck.sh
compose.yaml  .env.example  .github/workflows/image.yml
test/                     # vitest, fakes for Git/GitHub/Claude/Clock
scripts/e2e-dry-run.sh
```

**Dependencies (runtime):** `execa`, `croner`, `zod`, `pino`, `better-sqlite3`. **Dev:** `typescript`, `vitest`, `tsx`, `@types/*`. That's the whole list. Timezones use `Intl`, App JWTs use `node:crypto`, HTTP uses `fetch`, and arg parsing uses `util.parseArgs`.

---

## 5. Config schema

### 5a. `.backlog-runner.json` (target repo, default branch) — zod, strict

```jsonc
{
  "displayName": "EarthScope",                       // digest discussion title
  "defaultBranch": "main",                           // optional; else repo default from API
  "install": ["pnpm", "install", "--frozen-lockfile"],
  "gates": [["pnpm","typecheck"], ["pnpm","lint"], ["pnpm","test"]],
  "areas": ["borehole-log","ags","projects","auth","billing","infra","observability","marketing"],
  "wip": { "proposalsInReview": 3, "prsInReview": 3 },
  "maxFixAttempts": 2,
  "testServices": {
    "postgres": { "version": "16", "env": "DATABASE_URL", "database": "app_test", "schema": "public" },
    "redis":    { "version": "7",  "env": "REDIS_URL" }
  },
  "extraTestEnv": { "NODE_ENV": "test" },            // non-secret only; validated against a deny-pattern
  "timezone": "Europe/London",
  "schedule": { "sync": "*/20 * * * *", "summary": "30 7 * * 1-5" },   // overrides; all optional
  "allowedAuthors": ["martinpezet"],
  "models": { "propose": "sonnet", "build": "sonnet", "fix": "sonnet", "triage": "sonnet", "migrate": "sonnet" },
  "claude": { "maxTurns": 150, "timeoutMin": 90, "extraAllowedTools": ["Bash(node ace *)"] }
}
```

When the file is missing or invalid, every job except `setup`, `status`, `usage`, `update` and `cleanup` refuses to run. The zod issues are printed with their JSON paths, `status` shows them, and the digest gets one post per distinct error.

**Sidecar versions vs config:** compose image tags can't come from a file inside the cloned repo. `setup` and the startup check compare the configured versions with `SELECT version()` and `INFO server`, and refuse gates on a major-version mismatch, telling you what to set in `.env` (`POSTGRES_TEST_IMAGE`, `REDIS_TEST_IMAGE`).

### 5b. Env vars (account-level) — zod

| Var | Default | Notes |
|---|---|---|
| `TARGET_REPO` | build ARG | `owner/name` |
| `GH_TOKEN` \| `GH_APP_ID`+`GH_APP_INSTALLATION_ID`+`GH_APP_PRIVATE_KEY_FILE` | — | exactly one mode |
| `CLAUDE_CODE_OAUTH_TOKEN` \| `ANTHROPIC_API_KEY` | — | exactly one |
| `DIGEST_REPO`, `DIGEST_CATEGORY` | —, `Daily Digest` | |
| `DIGEST_AUTO_CREATE` | `false` | |
| `DRY_RUN` | `0` | |
| `PERMISSION_MODE` | `acceptEdits` | `bypassPermissions` only after firewall check passes |
| `USAGE_PROBE` | `on` | |
| `USAGE_MAX_AGE_MIN` | `30` | |
| `USAGE_UNKNOWN_POLICY` | `allow` | `block\|allow`; `allow` posts an error to the digest (§8.8) |
| `WEEKLY_STOP_PCT` / `WEEKLY_HARD_STOP_PCT` / `FIVE_HOUR_START_MAX_PCT` | `80` / `95` / `60` | |
| `RUN_WINDOWS` | `mon-fri 09:00-12:00; mon-fri 22:00-02:00` | |
| `WINDOW_GRACE_MIN` | `20` | |
| `URGENT_IGNORES_WINDOWS` | `true` | |
| `TZ` | `Europe/London` | project `timezone` overrides for window maths |
| `KEEP_BLOCKED_WORKTREES_DAYS` / `RETENTION_DAYS` / `MIN_FREE_DISK_GB` | `3` / `14` / `10` | |
| `HEALTH_PING_URL` | — | host added to firewall |
| `EXTRA_ALLOWED_DOMAINS` | — | comma list |
| `INSTALL_SUPERPOWERS` | `false` | |
| `CLAUDE_CHANNEL` | `stable` | §8.7 |
| `LOG_LEVEL` | `info` | |

Prompt overrides: `.backlog-runner/prompts/<name>.md` in the target repo, read from the default branch at job start. A stray worktree file can't inject one.

---

## 6. Jobs (behaviour summary)

All jobs share one wrapper: take the lease → insert a `job_runs` row → run → record the outcome, duration and est. cost → flush the digest batch → heartbeat → per-job cleanup → health ping (or `/fail`).

| Job | Claude? | Trigger | Notes |
|---|---|---|---|
| `sync` | no | cron `*/20`, plus before every `work` | fetch/ff default branch; recover stuck → requeue (§8.2); promote proposal PRs (merged → approved, closed → needs-decision + comment); **filter by allowed authors** |
| `work` | yes | loop inside windows; urgent outside them if `URGENT_IGNORES_WINDOWS` | pick: urgent first, then approved builds before ready proposals (reference: "finish before starting"), then priority, then age; WIP limits; budget and window gates; one item |
| ↳ build | | | resume from existing `change/issue-N` (merge default branch in, conflict → blocked); install → reset test DB/Redis → apply → gates → fix loop → PR, or draft PR + blocked |
| ↳ propose | | | worktree off default branch → propose prompt → stop signals → `openspec validate --strict` (+1 fix pass) → commit only `openspec/changes/<id>` → PR |
| `triage` | yes | the first `work` tick of each window, if anything is in `state:inbox` or there are answered `needs-decision` items/approved splits | fresh read-only worktree; tools `Read,Glob,Grep,Bash(openspec list *)`, `--permission-mode dontAsk`, `--json-schema`; runner applies labels/comments/states/child issues; strips any `urgent` change |
| `summary` | no | weekdays 07:30 | deterministic digest post; flags as specified |
| `update` | smoke test only | 03:00 when idle, plus on start | record → `claude update` → smoke (`--version` + 1-turn Haiku must echo a nonce) → rollback with `claude install <prev>` + 7-day pause; same pattern for OpenSpec (`npm i -g @fission-ai/openspec@x`) and Superpowers (`claude plugin update`) |
| `cleanup` | no | after every job, plus 04:00 | as specified; disk guard |

**Mid-run limits and checkpoints** (shared by build and propose): the Claude wrapper watches the stream. On `rate_limit_event.status == "rejected"`, or a window deadline plus grace, or SIGTERM, it sends SIGINT and then SIGTERM after 30 s. The runner then `commitLeftovers("wip: checkpoint …")` and pushes the branch (build only; a propose is just re-run), sets the issue back to its previous state (`approved`/`ready`), writes `checkpoints` + a `paused_until` row, and posts to the digest. The next build of that issue finds the branch and resumes.

**Stop signals:** `^(NEEDS_DECISION|NEEDS_SPLIT|BLOCKED):\s*(.*)` with the multiline flag, taken from the **last** match in the final result text, not the first. Agents sometimes quote the protocol earlier in their output.

---

## 7. Milestones and tests

As specified. Unit tests use fakes for `Git`, `GitHub`, `Claude`, `Clock` and `Fs`, and never shell out. Window and DST tests cover the Europe/London switches (2026-03-29 and 2026-10-25), a window that crosses midnight, and Friday-night/Sunday-night anchoring. Per milestone I'll show `vitest` output and a short "what works" note. M2 can be exercised locally with `docker compose up`. **I can't run Docker or reach your sandbox repo from this Windows session unless Docker Desktop is available here**, so I'll check that at M2.

---

## 8. Decisions (approved 2026-10-05)

1. **GitHub auth:** GitHub App is the primary, documented path. `GH_TOKEN` (classic PAT on a bot user) stays supported as a fallback.
2. **Crash recovery:** an issue stuck in `proposing`/`building` with no live lease goes **back to its queue** (`ready`/`approved`) and resumes from its branch. It is blocked only if the same issue is recovered twice within 24 h.
3. **Urgent does not bypass WIP limits.** Urgent only changes queue order, the weekly gate (up to the hard stop) and windows.
4. **The 07:30 summary posts to the digest.**
5. **Two users:** `runner` (secrets, state, GitHub writes) and `agent` (Claude, install, gates).
6. **OpenSpec context:** `setup` scaffolds `openspec/config.yaml` `context:`. Prompts read it, and `project.md` too if present.
7. **Claude Code channel:** `stable` by default (`CLAUDE_CHANNEL`).
8. **Unknown usage:** `USAGE_UNKNOWN_POLICY` defaults to **`allow`**. Each time usage becomes unknown, the runner logs an error and posts a ⚠️ digest line once per occurrence, saying why (for example, the `/usage` probe couldn't be parsed). Passive `rejected`/warning handling stays the safety net.

---

## 9. Implementation notes (M2–M8 built, 2026-10-07)

Where the build differs from or adds to the plan above:

- **CI was pulled forward** into M2 (`.github/workflows/image.yml`), at your request.
- **Agent umask:** sudo unions umasks, so agent-written files came out 0644/0755 and the runner couldn't commit or remove them. `sudoers.agent` now sets `umask=0002`.
- **Dry run covers git too:** `DRY_RUN=1` also skips `git push` and remote branch deletion, since those are GitHub writes.
- **The firewall allows DNS only to the resolvers in `/etc/resolv.conf`**, not just Docker's 127.0.0.11. That address is only present on user-defined networks; a plain `docker run` uses the host's resolver.
- **The firewall is refreshed every 15 minutes** by a root loop in the entrypoint, not before every Claude job: the runner has no capabilities left to do it.
- **Gate notes:** an urgent item that runs while the weekly gate is engaged is posted as 🚨.
- **Work runs sync first**, so state is fresh before picking an item.
- **Spikes are never proposed:** `type:spike` issues in `state:ready` are skipped by `work`, and triage forces spikes and `size:l` to `needs-decision`.
- **Superpowers rollback** uninstalls the plugin, because plugins can't be pinned to a version.
- **The `/usage` parser is unverified against real output.** The CLI on the dev machine wasn't logged in, so it's built from the documented behaviour plus a guessed format with fixture tests. If it fails in the container, the digest reports it once and `allow` keeps work going; send me the output of `pez-bot usage --probe` and I'll tune the parser.
- **Schedule changes need a restart:** cron overrides in `.backlog-runner.json` are read at daemon start.

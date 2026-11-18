# Context

Active memory across sessions. Rewritten at the end of every session that changes code or docs (see `RULES.md`). Keep it to what git, `gh issue list` and the code can't tell you, under ~30 lines.

## Current status

- M2–M8 built and running (2026-10-07). Agent docs layer in place (2026-10-15); `PLAN.md` retired.
- Local UI (`npm run ui`, ADR-0015) merged via #21 (2026-11-08). Tested with a seeded database and the local CLI; never run against a live runner container, because Docker wasn't running on the dev machine.
- The UI's log shows failed runs from `job_runs`. The learning loop (#9) is still design-only, so nothing there "catches" errors yet; when it lands, its findings need adding to the UI.
- PR #19 merged (2026-11-08): `sync` checks CI on open review PRs. Failed implementation PRs go back to build with the CI log, capped by `maxFixAttempts`; failed proposals or unreadable logs block. Never seen working on real GitHub.
- earth-scope #21 / PR #72: CI reads now work (2026-11-18), but the fix-ci run blocked because it was handed only the last 200 log lines, which were Postgres service-container output from job cleanup. Branch `fix/ci-log-failing-step` sends the failing step instead (checked against the real job log: 103 lines ending in the failed `boreholes.spec.ts:68` test). #23 (merged) reports unreadable CI on the issue and in the morning summary.
- Run windows now pace only the daemon (branch `claude/run-windows-88e349`, 2026-11-17): one-off CLI runs (and so UI buttons) skip the window check and get no window deadline, but still pass the budget gate unless `--ignore-budget`. Flag is `createApp(..., { manual: true })` in `cli.ts` → `GateDeps.manual`. Committed, no PR yet.
- #24 merged (2026-11-18): `sync` sends review PRs with new comments from `allowedAuthors` back to build (prompt `fix-review`, watermark kv `review.seen.<pr>`). Tested with fakes only. Doesn't need CI permissions, so it can fix earth-scope #72 from the owner's comments.

## Next steps

- After deploying `fix/ci-log-failing-step`, relabel earth-scope #21 `state:pr-review` (not `approved`, which would re-run apply). The next `work` sync should send it back with the Playwright failure in the fix-ci prompt; `block()` reset the CI fix count.
- Test the runner-only firewall rule (ADR-0016) in a real container before relying on it: only syntax-checked so far, because Docker is broken on the dev machine. Expect `firewall: verified` with no `WARNING`.
- Try `npm run ui` against the real container.
- Once `fix/trust-bot-issues` is deployed, earth-scope #74–77 (bot-authored split children of #71, ignored until now) get triaged at the next run window; check they land in `state:ready` or `state:needs-decision`.
- Review `docs/agents/INTENT.md` and the ADRs for anything misremembered from `PLAN.md`.

## Known issues

- Usage readings are usually unknown until a threshold event arrives; the `allow` policy covers it (ADR-0008).
- `status` doesn't print `job_runs.detail`; use `failures` for the reason a run failed.

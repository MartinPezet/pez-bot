# Context

Active memory across sessions. Rewritten at the end of every session that changes code or docs (see `RULES.md`). Keep it to what git, `gh issue list` and the code can't tell you, under ~30 lines.

## Current status

- M2–M8 built and running (2026-10-07). Agent docs layer in place (2026-10-15); `PLAN.md` retired.
- Web UI moved into the daemon on `feat/ui-in-container` (ADR-0017, 2026-11-09), because the owner's server has no npm. Off unless `UI_TOKEN` is set. Unit tests plus a browser run of the daemon outside Docker; the image build, the firewall rule, the published port and SIGTERM forwarding have never run, because Docker is broken on the dev machine.
- The UI's log shows failed runs from `job_runs`. The learning loop (#9) is still design-only, so nothing there "catches" errors yet; when it lands, its findings need adding to the UI.
- PR #19 merged (2026-11-08): `sync` checks CI on open review PRs. Failed implementation PRs go back to build with the CI log, capped by `maxFixAttempts`; failed proposals or unreadable logs block. Never seen working on real GitHub.
- earth-scope #21 / PR #72: CI reads now work (2026-11-18), but the fix-ci run blocked because it was handed only the last 200 log lines, which were Postgres service-container output from job cleanup. #27 (merged) sends the failing step instead (checked against the real job log: 103 lines ending in the failed `boreholes.spec.ts:68` test). #23 (merged) reports unreadable CI on the issue and in the morning summary.
- PR #26 (merged, 2026-11-17): run windows now pace only the daemon. One-off CLI runs (and so UI buttons) skip the window check and get no window deadline, but still pass the budget gate unless `--ignore-budget`. Flag is `createApp(..., { manual: true })` in `cli.ts` → `GateDeps.manual`.
- #24 merged (2026-11-18): `sync` sends review PRs with new comments from `allowedAuthors` back to build (prompt `fix-review`, watermark kv `review.seen.<pr>`). Tested with fakes only. Doesn't need CI permissions, so it can fix earth-scope #72 from the owner's comments.

## Next steps

- After deploying #27, relabel earth-scope #21 `state:pr-review` (not `approved`, which would re-run apply). The next `work` sync should send it back with the Playwright failure in the fix-ci prompt; `block()` reset the CI fix count.
- On the server, set `UI_TOKEN` and check the UI end to end, including the agent-block `curl` in the README. Treat the UI as unproven until that `curl` fails as expected.
- Test the runner-only firewall rule (ADR-0016) in a real container before relying on it: only syntax-checked so far, because Docker is broken on the dev machine. Expect `firewall: verified` with no `WARNING`.
- Once #25 is deployed, earth-scope #74–77 (bot-authored split children of #71, ignored until now) get triaged at the next run window; check they land in `state:ready` or `state:needs-decision`.
- Review `docs/agents/INTENT.md` and the ADRs for anything misremembered from `PLAN.md`.

## Known issues

- Usage readings are usually unknown until a threshold event arrives; the `allow` policy covers it (ADR-0008).
- `status` doesn't print `job_runs.detail`; use `failures` for the reason a run failed.

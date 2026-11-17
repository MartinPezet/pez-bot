# Context

Active memory across sessions. Rewritten at the end of every session that changes code or docs (see `RULES.md`). Keep it to what git, `gh issue list` and the code can't tell you, under ~30 lines.

## Current status

- M2–M8 built and running (2026-10-07). Agent docs layer in place (2026-10-15); `PLAN.md` retired.
- Local UI (`npm run ui`, ADR-0015) merged via #21 (2026-11-08). Tested with a seeded database and the local CLI; never run against a live runner container, because Docker wasn't running on the dev machine.
- The UI's log shows failed runs from `job_runs`. The learning loop (#9) is still design-only, so nothing there "catches" errors yet; when it lands, its findings need adding to the UI.
- PR #19 merged (2026-11-08): `sync` checks CI on open review PRs. Failed implementation PRs go back to build with the CI log, capped by `maxFixAttempts`; failed proposals or unreadable logs block. Never seen working on real GitHub.
- earth-scope #21 / PR #72 has failed `E2E Tests` since 2026-11-13 and the runner never sent it back. Most likely cause (not verified, couldn't see the App's permissions): CI reads fail and `sync` treated that as green. #23 (merged) now posts a ❌ error comment on the issue and a digest event once per PR, and the morning summary lists it under "Needs you now" until a read works (kv `ci.unreadable.<pr>`).
- Run windows now pace only the daemon (branch `claude/run-windows-88e349`, 2026-11-17): one-off CLI runs (and so UI buttons) skip the window check and get no window deadline, but still pass the budget gate unless `--ignore-budget`. Flag is `createApp(..., { manual: true })` in `cli.ts` → `GateDeps.manual`. Committed, no PR yet.
- Branch `feat/pr-review-feedback`: `sync` sends review PRs with new comments from `allowedAuthors` back to build (prompt `fix-review`, watermark kv `review.seen.<pr>`). Tested with fakes only. Doesn't need CI permissions, so it can fix earth-scope #72 from the owner's comments.

## Next steps

- Accept the App's updated permissions on the installation (Settings → Installed GitHub Apps → Configure), then check the runner log no longer shows `FORBIDDEN` for `could not read CI status`.
- After deploying `feat/pr-review-feedback`, the next `work` should post 💬 on earth-scope #21 and push a fix to PR #72. Every earlier owner comment on open review PRs counts once on first sight.
- Test the runner-only firewall rule (ADR-0016) in a real container before relying on it: only syntax-checked so far, because Docker is broken on the dev machine. Expect `firewall: verified` with no `WARNING`.
- Try `npm run ui` against the real container.
- Once `fix/trust-bot-issues` is deployed, earth-scope #74–77 (bot-authored split children of #71, ignored until now) get triaged at the next run window; check they land in `state:ready` or `state:needs-decision`.
- Review `docs/agents/INTENT.md` and the ADRs for anything misremembered from `PLAN.md`.

## Known issues

- Usage readings are usually unknown until a threshold event arrives; the `allow` policy covers it (ADR-0008).
- `status` doesn't print `job_runs.detail`; use `failures` for the reason a run failed.

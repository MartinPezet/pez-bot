# Context

Active memory across sessions. Rewritten at the end of every session that changes code or docs (see `RULES.md`). Keep it to what git, `gh issue list` and the code can't tell you, under ~30 lines.

## Current status

- M2–M8 built and running (2026-10-07). Agent docs layer in place (2026-10-15); `PLAN.md` retired.
- Local UI (`npm run ui`, ADR-0015) merged via #21 (2026-11-08). Tested with a seeded database and the local CLI; never run against a live runner container, because Docker wasn't running on the dev machine.
- The UI's log shows failed runs from `job_runs`. The learning loop (#9) is still design-only, so nothing there "catches" errors yet; when it lands, its findings need adding to the UI.
- PR #19 merged (2026-11-08): `sync` checks CI on open review PRs. Failed implementation PRs go back to build with the CI log, capped by `maxFixAttempts`; failed proposals or unreadable logs block. Never seen working on real GitHub.
- earth-scope #21 / PR #72 has failed `E2E Tests` since 2026-11-13 and the runner never sent it back. Most likely cause (not verified, couldn't see the App's permissions): CI reads fail and `sync` treated that as green. #23 (merged) now posts a ❌ error comment on the issue and a digest event once per PR, and the morning summary lists it under "Needs you now" until a read works (kv `ci.unreadable.<pr>`).
- Run windows now pace only the daemon (branch `claude/run-windows-88e349`, 2026-11-17): one-off CLI runs (and so UI buttons) skip the window check and get no window deadline, but still pass the budget gate unless `--ignore-budget`. Flag is `createApp(..., { manual: true })` in `cli.ts` → `GateDeps.manual`. Committed, no PR yet.

## Next steps

- Add **Checks: read**, **Commit statuses: read** and **Actions: read** to the GitHub App and re-approve the installation. Then a `work` run should move earth-scope #21 to `state:approved` with a 🔁 comment. If the digest still shows ⚠️ `Can't read CI`, permissions are still missing.
- Test the runner-only firewall rule (ADR-0016) in a real container before relying on it: only syntax-checked so far, because Docker is broken on the dev machine. Expect `firewall: verified` with no `WARNING`.
- Try `npm run ui` against the real container.
- Review `docs/agents/INTENT.md` and the ADRs for anything misremembered from `PLAN.md`.

## Known issues

- Usage readings are usually unknown until a threshold event arrives; the `allow` policy covers it (ADR-0008).
- `status` doesn't print `job_runs.detail`; use `failures` for the reason a run failed.

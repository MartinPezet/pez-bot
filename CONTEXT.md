# Context

Active memory across sessions. Rewritten at the end of every session that changes code or docs (see `RULES.md`). Keep it to what git, `gh issue list` and the code can't tell you, under ~30 lines.

## Current status

- M2–M8 built and running (2026-10-07). Agent docs layer in place (2026-10-15); `PLAN.md` retired.
- Local UI (`npm run ui`, ADR-0015) merged via #21 (2026-11-08). Tested with a seeded database and the local CLI; never run against a live runner container, because Docker wasn't running on the dev machine.
- The UI's log shows failed runs from `job_runs`. The learning loop (#9) is still design-only, so nothing there "catches" errors yet; when it lands, its findings need adding to the UI.
- PR #19 (`fix/block-on-failed-ci`): `sync` checks CI on open review PRs. Failed implementation PRs go back to build with the CI log, capped by `maxFixAttempts`; failed proposals or unreadable logs block. Tested with fakes only, never against real GitHub.

## Next steps

- Test the runner-only firewall rule (ADR-0016) in a real container before relying on it: only syntax-checked so far, because Docker is broken on the dev machine. Expect `firewall: verified` with no `WARNING`, and a failed PR moving to `state:approved` rather than `state:blocked`.
- Add **Checks: read**, **Commit statuses: read** and **Actions: read** to the GitHub App and re-approve the installation; until then CI reads fail (logged as `could not read CI status`) and nothing gets blocked.
- Try `npm run ui` against the real container.
- Review `docs/agents/INTENT.md` and the ADRs for anything misremembered from `PLAN.md`.

## Known issues

- Usage readings are usually unknown until a threshold event arrives; the `allow` policy covers it (ADR-0008).
- `status` doesn't print `job_runs.detail`; use `failures` for the reason a run failed.

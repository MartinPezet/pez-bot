# Context

Active memory across sessions. Rewritten at the end of every session that changes code or docs (see `RULES.md`). Keep it to what git, `gh issue list` and the code can't tell you, under ~30 lines.

## Current status

- M2–M8 built and running (2026-10-07). Agent docs layer in place (2026-10-15); `PLAN.md` retired.
- Local UI (`npm run ui`, ADR-0015) merged via #21 (2026-11-08). Tested with a seeded database and the local CLI; never run against a live runner container, because Docker wasn't running on the dev machine.
- The UI's log shows failed runs from `job_runs`. The learning loop (#9) is still design-only, so nothing there "catches" errors yet; when it lands, its findings need adding to the UI.
- earth-scope #21 / PR #72: CI reads work since 2026-11-18. `fix/ci-log-failing-step` (#27, merged) sends the failing CI step to fix-ci instead of the job-log tail, which was Postgres cleanup output.
- `sync` sends implementation PRs back to build on failed CI (#19) and on new owner comments (#24, prompt `fix-review`). Neither seen working on real GitHub.
- Run windows pace only the daemon (#26, merged): one-off CLI runs and UI buttons skip the window check but still pass the budget gate unless `--ignore-budget`.
- PR #28, branch `feat/agent-proposal-review` (2026-11-19, ADR-0017): proposal PRs and `state:proposal-review` are gone. `propose` → reviewer agent (`review-proposal`, read-only, JSON verdict) → revise up to `maxFixAttempts` → spec pushed to `change/issue-N`, issue `approved` → build → implementation PR. Tested with fakes only; main merged in.
- Branch `feat/wip-limit-env` (2026-11-26): WIP limit moved from `.backlog-runner.json` `wip.prsInReview` to env `MAX_PRS_IN_REVIEW` (default 3). Old `wip` fields still parse, ignored.

## Next steps

- Before deploying #28: check each target repo for `state:proposal-review` issues (`gh issue list -l state:proposal-review`) and merge/close their proposal PRs under the old image, or relabel by hand (README troubleshooting).
- After deploying #28, watch the first propose: expect a 📝 "written and reviewed" comment with reviewer notes, a pushed `change/issue-N` and no PR. Check the review prompt doesn't pass thin proposals (it's the only check before build now).
- After deploying #27, relabel earth-scope #21 `state:pr-review` (not `approved`, which would re-run apply). The next sync should send it back with the Playwright failure in the fix-ci prompt.
- earth-scope #74–77 (bot-authored split children of #71) should get triaged now that #25 is merged; check they land in `state:ready` or `state:needs-decision`.
- Test the runner-only firewall rule (ADR-0016) in a real container: only syntax-checked so far. Expect `firewall: verified` with no `WARNING`.
- Try `npm run ui` against the real container.
- After deploying `feat/wip-limit-env`: any target repo whose `.backlog-runner.json` set `wip.prsInReview` to something other than 3 needs `MAX_PRS_IN_REVIEW` in its `.env`, or it silently drops to 3.

## Known issues

- Usage readings are usually unknown until a threshold event arrives; the `allow` policy covers it (ADR-0008).
- `status` doesn't print `job_runs.detail`; use `failures` for the reason a run failed.
- A resumed build whose checkpoint already held every task, and whose apply adds nothing, blocks with "Agent produced no commits" (the branch now always starts with the spec commit).

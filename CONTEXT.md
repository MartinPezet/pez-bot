# Context

Active memory across sessions. Rewritten at the end of every session that changes code or docs (see `RULES.md`). Keep it to what git, `gh issue list` and the code can't tell you, under ~30 lines.

## Current status

- M2–M8 built and running (2026-10-07). Agent docs layer in place (2026-10-15); `PLAN.md` retired.
- Web UI moved into the daemon on `feat/ui-in-container` (ADR-0018, 2026-11-09), because the owner's server has no npm. Off unless `UI_TOKEN` is set. Unit tests plus a browser run of the daemon outside Docker; the image build, the firewall rule, the published port and SIGTERM forwarding have never run, because Docker is broken on the dev machine.
- The UI's log shows failed runs from `job_runs`. The learning loop (#9) is still design-only, so nothing there "catches" errors yet; when it lands, its findings need adding to the UI.
- earth-scope #21 / PR #72: CI reads work since 2026-11-18. `fix/ci-log-failing-step` (#27, merged) sends the failing CI step to fix-ci instead of the job-log tail, which was Postgres cleanup output.
- `sync` sends implementation PRs back to build on failed CI (#19) and on new owner comments (#24, prompt `fix-review`). Neither seen working on real GitHub.
- Run windows pace only the daemon (#26, merged): one-off CLI runs and UI buttons skip the window check but still pass the budget gate unless `--ignore-budget`.
- Branch `fix/firewall-compose-dns` (2026-11-19): under compose (user-defined networks) Docker's embedded DNS forwards upstream as root from the container netns, so the firewall's `OUTPUT DROP` broke DNS and start-up verification failed on Docker Desktop 20.10.17. Fix: port 53 open to uid 0 only when resolv.conf is `127.0.0.11`. Verified on the dev machine with the compose stack and plain `docker run`. Whether the production server was affected is not verified.
- PR #28 (merged 2026-11-19, ADR-0017): proposal PRs and `state:proposal-review` are gone. `propose` → reviewer agent (`review-proposal`, read-only, JSON verdict) → revise up to `maxFixAttempts` → spec pushed to `change/issue-N`, issue `approved` → build → implementation PR. Tested with fakes only.

## Next steps

- On the production server, run `docker compose exec runner cat /data/state/firewall.json` and `docker version --format '{{.Server.Version}}'`. `ok: true` means newer Docker forwards DNS differently and the firewall fix is a no-op there; `ok: false` means jobs were being refused.
- Before deploying #28: check each target repo for `state:proposal-review` issues (`gh issue list -l state:proposal-review`) and merge/close their proposal PRs under the old image, or relabel by hand (README troubleshooting).
- After deploying #28, watch the first propose: expect a 📝 "written and reviewed" comment with reviewer notes, a pushed `change/issue-N` and no PR. Check the review prompt doesn't pass thin proposals (it's the only check before build now).
- After deploying #27, relabel earth-scope #21 `state:pr-review` (not `approved`, which would re-run apply). The next sync should send it back with the Playwright failure in the fix-ci prompt.
- earth-scope #74–77 (bot-authored split children of #71) should get triaged now that #25 is merged; check they land in `state:ready` or `state:needs-decision`.
- On the server, set `UI_TOKEN` and check the UI end to end, including the agent-block `curl` in the README. Treat the UI as unproven until that `curl` fails as expected.

## Known issues

- Usage readings are usually unknown until a threshold event arrives; the `allow` policy covers it (ADR-0008).
- `status` doesn't print `job_runs.detail`; use `failures` for the reason a run failed.
- A resumed build whose checkpoint already held every task, and whose apply adds nothing, blocks with "Agent produced no commits" (the branch now always starts with the spec commit).

# Context

Active memory across sessions. Rewritten at the end of every session that changes code or docs (see `RULES.md`). Keep it to what git, `gh issue list` and the code can't tell you, under ~30 lines.

## Current status

- M2–M8 built and running (2026-10-07). Agent docs layer in place (2026-10-15); `PLAN.md` retired.
- Web UI served by the daemon (#22, ADR-0018), off unless `UI_TOKEN` is set. Image build, firewall rule, published port and SIGTERM forwarding never run in Docker. The learning loop (#9) is design-only, so the UI log shows only failed `job_runs`.
- Firewall DNS fix (#29): port 53 open to uid 0 only when resolv.conf is `127.0.0.11`. Verified on the dev machine; production server not checked.
- #28 (agent proposal review, ADR-0017) is deployed: earth-scope #74 got a "written and reviewed" comment on 2026-11-23. `sync` CI/comment send-backs (#19, #24) still not seen on real GitHub.
- Earth Scope (2026-11-25): 1 ticket done (#80, PR #83). The rest wait on the owner: #75, #76, #87–#94 `needs-decision`; #37 / PR #85 blocked on a question (change-plan hook); #21 / PR #72 blocked on E2E; #77, #86 depend on #74/#91.
- #30 deployed 2026-11-25 (ADR-0019): dummy test env in `.backlog-runner.env`, loaded add-only by the gates. earth-scope PR #95 (merged) added the matching `$GITHUB_ENV` step to `ci.yml`.
- earth-scope #74 rerun (2026-11-26) did the whole Stripe migration and archived the change, then blocked: Claude Code refused the agent's commits under `.github/` and `infra/`, and the runner's push of the leftovers failed silently (likely missing Workflows on the installation; the server log has the real error). Branch `fix/refused-commits-and-silent-push`: prompts treat a refused commit as "leave it uncommitted, the runner commits it", and the block comment quotes a failed push.
- Owner added the **Workflows** permission to the earth-scope App (2026-11-25). Whether the installation accepted it is not verified, and #74's failed push suggests it hadn't. Prompts let the agent add the `.backlog-runner.env` load step to CI itself; real infra tickets (#74 swaps Polar for Stripe in `ci.yml`) need workflow edits too, so the permission stays. Deploy secrets are repo-wide and readable from a bot branch: see `handover-earth-scope-deploy-secrets.md` (uncommitted, in the repo root).
- Branch `feat/wip-limit-env` (2026-11-26): WIP limit moved from `.backlog-runner.json` `wip.prsInReview` to env `MAX_PRS_IN_REVIEW` (default 3). Old `wip` fields still parse, ignored.

## Next steps

- Before rerunning earth-scope #74: accept Workflows on the App installation, check the server's `PERMISSION_MODE` (`auto` may be what refused the `.github/`/`infra/` commits), deploy `fix/refused-commits-and-silent-push`, then relabel `state:approved`. Expect a PR containing the CI and infra edits and a "Production config needed" section.
- Relabel earth-scope #21 `state:pr-review` (not `approved`) so sync sends the Playwright failure to fix-ci; answer #37 on the issue.
- On the server: `docker compose exec runner cat /data/state/firewall.json` (`ok: false` means jobs were refused before #29); set `UI_TOKEN` and check the UI end to end, including the README's agent-block `curl`.
- Test the runner-only firewall rule (ADR-0016) in a real container; expect `firewall: verified` with no `WARNING`.
- After deploying `feat/wip-limit-env`: any target repo whose `.backlog-runner.json` set `wip.prsInReview` to something other than 3 needs `MAX_PRS_IN_REVIEW` in its `.env`, or it silently drops to 3.

## Known issues

- Usage readings are usually unknown until a threshold event arrives; the `allow` policy covers it (ADR-0008).
- `status` doesn't print `job_runs.detail`; use `failures` for the reason a run failed.
- A resumed build whose checkpoint already held every task, and whose apply adds nothing, blocks with "Agent produced no commits".
- The agent's own shell doesn't see `.backlog-runner.env` entries it adds mid-run; only the runner's gates (and the next Claude call) do.

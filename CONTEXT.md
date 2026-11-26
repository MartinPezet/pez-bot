# Context

Active memory across sessions. Rewritten at the end of every session that changes code or docs (see `RULES.md`). Keep it to what git, `gh issue list` and the code can't tell you, under ~30 lines.

## Current status

- M2–M8 built and running (2026-10-07). Agent docs layer in place (2026-10-15); `PLAN.md` retired.
- Web UI served by the daemon (#22, ADR-0018), off unless `UI_TOKEN` is set. Image build, firewall rule, published port and SIGTERM forwarding never run in Docker. The learning loop (#9) is design-only, so the UI log shows only failed `job_runs`.
- Firewall DNS fix (#29): port 53 open to uid 0 only when resolv.conf is `127.0.0.11`. Verified on the dev machine; production server not checked.
- #28 (agent proposal review, ADR-0017) is deployed: earth-scope #74 got a "written and reviewed" comment on 2026-11-23. `sync` CI/comment send-backs (#19, #24) still not seen on real GitHub.
- Earth Scope (2026-11-25): 1 ticket done (#80, PR #83). The rest wait on the owner: #75, #76, #87–#94 `needs-decision`; #37 / PR #85 blocked on a question (change-plan hook); #21 / PR #72 blocked on E2E; #74 blocked because Stripe env vars weren't in the gate env; #77, #86 depend on #74/#91.
- PR #30, branch `feat/branch-test-env` (ADR-0019): the agent commits dummy test env to `.backlog-runner.env` on its branch; gates load it add-only, reserved names and credential-looking values refused. Prompts also update `.env.example` and list "Production config needed" in the PR body. Tested with fakes only.
- Owner added the **Workflows** permission to the earth-scope App (2026-11-25; whether the installation accepted it is not verified). Prompts now let the agent add the `.backlog-runner.env` load step to CI workflows itself, and nothing else; that limit isn't enforced by the runner, so workflow edits in bot PRs need review.
- Branch `feat/wip-limit-env` (2026-11-26): WIP limit moved from `.backlog-runner.json` `wip.prsInReview` to env `MAX_PRS_IN_REVIEW` (default 3). Old `wip` fields still parse, ignored.

## Next steps

- Merge and deploy #30, then relabel earth-scope #74 `state:approved`; the agent should add the `$GITHUB_ENV` load step to `ci.yml` itself. Expect the fix loop to add `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_TAX_RATE_ID`.
- Relabel earth-scope #21 `state:pr-review` (not `approved`) so sync sends the Playwright failure to fix-ci; answer #37 on the issue.
- On the server: `docker compose exec runner cat /data/state/firewall.json` (`ok: false` means jobs were refused before #29); set `UI_TOKEN` and check the UI end to end, including the README's agent-block `curl`.
- Test the runner-only firewall rule (ADR-0016) in a real container; expect `firewall: verified` with no `WARNING`.
- After deploying `feat/wip-limit-env`: any target repo whose `.backlog-runner.json` set `wip.prsInReview` to something other than 3 needs `MAX_PRS_IN_REVIEW` in its `.env`, or it silently drops to 3.

## Known issues

- Usage readings are usually unknown until a threshold event arrives; the `allow` policy covers it (ADR-0008).
- `status` doesn't print `job_runs.detail`; use `failures` for the reason a run failed.
- A resumed build whose checkpoint already held every task, and whose apply adds nothing, blocks with "Agent produced no commits".
- The agent's own shell doesn't see `.backlog-runner.env` entries it adds mid-run; only the runner's gates (and the next Claude call) do.

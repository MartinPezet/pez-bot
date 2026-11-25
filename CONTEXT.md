# Context

Active memory across sessions. Rewritten at the end of every session that changes code or docs (see `RULES.md`). Keep it to what git, `gh issue list` and the code can't tell you, under ~30 lines.

## Current status

- M2–M8 built and running (2026-10-07). Local UI (`npm run ui`, ADR-0015) merged via #21; never run against a live runner container.
- #28 (agent proposal review, ADR-0017) is deployed: earth-scope #74 got a "written and reviewed" comment on 2026-11-23.
- Earth Scope so far: 1 ticket done (#80, PR #83). Everything else waits on the owner (2026-11-25): #75, #76, #87–#94 `needs-decision`; #37 / PR #85 blocked on a question (change-plan hook); #21 / PR #72 blocked on E2E; #74 blocked because Stripe env vars weren't in the gate env; #77 and #86 depend on #74/#91.
- Branch `feat/branch-test-env` (2026-11-25, ADR-0018): the agent commits dummy test env to `.backlog-runner.env` on its branch; gates load it, add-only, reserved names and credential-looking values refused. Prompts tell it to also update `.env.example` and list "Production config needed" in the PR body. Tested with fakes only.
- GitHub App permissions per README don't include **Workflows**, and the bot has never pushed a workflow change in earth-scope. Live app settings not checked (needs a GitHub sign-in).

## Next steps

- Merge and deploy `feat/branch-test-env`, then add the README's `$GITHUB_ENV` step to earth-scope's `ci.yml` (backend-tests and e2e jobs) so GitHub CI sees the bot's vars.
- Then relabel earth-scope #74 `state:approved`; expect the fix loop to add `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_TAX_RATE_ID` to `.backlog-runner.env`.
- Relabel earth-scope #21 `state:pr-review` (not `approved`) so sync sends the Playwright failure to fix-ci; answer #37 on the issue.
- Test the runner-only firewall rule (ADR-0016) in a real container; expect `firewall: verified` with no `WARNING`.

## Known issues

- Usage readings are usually unknown until a threshold event arrives; the `allow` policy covers it (ADR-0008).
- `status` doesn't print `job_runs.detail`; use `failures` for the reason a run failed.
- A resumed build whose checkpoint already held every task, and whose apply adds nothing, blocks with "Agent produced no commits".
- The agent's own shell doesn't see `.backlog-runner.env` entries it adds mid-run; only the runner's gates (and the next Claude call) do.

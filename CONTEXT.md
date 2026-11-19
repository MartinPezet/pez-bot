# Context

Active memory across sessions. Rewritten at the end of every session that changes code or docs (see `RULES.md`). Keep it to what git, `gh issue list` and the code can't tell you, under ~30 lines.

## Current status

- M2–M8 built and running (2026-10-07). Agent docs layer in place (2026-10-15); `PLAN.md` retired.
- Local UI (`npm run ui`, ADR-0015) merged via #21 (2026-11-08). Tested with a seeded database and the local CLI; never run against a live runner container, because Docker wasn't running on the dev machine.
- The UI's log shows failed runs from `job_runs`. The learning loop (#9) is still design-only, so nothing there "catches" errors yet; when it lands, its findings need adding to the UI.
- `sync` sends implementation PRs back to build on failed CI (#19) and on new owner comments (#24, prompt `fix-review`). Neither has been seen working on real GitHub.
- earth-scope #21 / PR #72 has failed `E2E Tests` since 2026-11-13. On 2026-11-17 the runner still got `FORBIDDEN` reading CI; likely the installation hasn't accepted the App's new permissions.
- Branch `feat/agent-proposal-review` (2026-11-19, ADR-0017): proposal PRs and `state:proposal-review` are gone. `propose` → reviewer agent (`review-proposal`, read-only, JSON verdict) → revise up to `maxFixAttempts` → spec pushed to `change/issue-N`, issue `approved` → build → implementation PR. Tested with fakes only. Not yet pushed or PR'd.

## Next steps

- Before deploying `feat/agent-proposal-review`: check each target repo for `state:proposal-review` issues (`gh issue list -l state:proposal-review`) and merge/close their proposal PRs under the old image, or relabel by hand (README troubleshooting).
- After deploying it, watch the first propose: expect a 📝 "written and reviewed" comment with reviewer notes, a pushed `change/issue-N` and no PR. Check the review prompt doesn't pass thin proposals (it's the only check before build now).
- Accept the App's updated permissions on the installation (Settings → Installed GitHub Apps → Configure), then check the runner log no longer shows `FORBIDDEN` for `could not read CI status`.
- After deploying `fix-review`, the next `work` should post 💬 on earth-scope #21 and push a fix to PR #72.
- Test the runner-only firewall rule (ADR-0016) in a real container: only syntax-checked so far. Expect `firewall: verified` with no `WARNING`.
- Try `npm run ui` against the real container.

## Known issues

- Usage readings are usually unknown until a threshold event arrives; the `allow` policy covers it (ADR-0008).
- `status` doesn't print `job_runs.detail`; use `failures` for the reason a run failed.
- A resumed build whose checkpoint already held every task, and whose apply adds nothing, blocks with "Agent produced no commits" (the branch now always starts with the spec commit).

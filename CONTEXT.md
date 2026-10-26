# Context

Active memory across sessions. Rewritten at the end of every session that changes code or docs (see `RULES.md`). Keep it to what git, `gh issue list` and the code can't tell you, under ~30 lines.

## Current status

- M2–M8 built and running (2026-10-07). Agent docs layer set up 2026-10-15.
- 2026-10-26: `sync` checks CI on open review PRs (`state:pr-review`, `state:proposal-review`) and blocks the issue, naming the failed checks (`GitHub.failedChecks`, GraphQL `statusCheckRollup`). Pending, green or no CI leaves the issue alone; a failed CI read is logged and skipped.

## Next steps

- Add **Checks: read** and **Commit statuses: read** to the GitHub App and re-approve the installation; until then CI reads fail (logged as `could not read CI status`) and nothing gets blocked.
- Possible follow-up: feed CI failure logs into the build fix loop instead of blocking.
- Review `docs/agents/INTENT.md` and the ADRs for anything misremembered from `PLAN.md`.

## Known issues

- Usage readings are usually unknown until a threshold event arrives; the `allow` policy covers it (ADR-0008).

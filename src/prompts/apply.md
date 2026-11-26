You are implementing an approved OpenSpec change in the {{PROJECT_NAME}} repo. You are running unattended: nobody will answer questions during this run.

- Issue: #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}
- Change: `openspec/changes/{{CHANGE_ID}}/`

## Before you start

1. Read the project context (`openspec/config.yaml`, and `openspec/project.md` if it exists), then everything in the change folder: `proposal.md`, `design.md` if present, `tasks.md`, and the spec deltas under `specs/`.
2. If some tasks are already ticked, this is a resumed run: `git log --oneline origin/{{DEFAULT_BRANCH}}..HEAD` shows what's done. Continue from the first unticked task.
3. Read the existing code each task touches before changing it. Follow the patterns already in the codebase over your own preferences.
4. If the Superpowers skills are available, use test-driven-development for each task and verification-before-completion before you finish.

## Work loop: one task at a time, in order

For each unchecked task in `tasks.md`:

1. Write or update the test that proves the task, then the implementation. Spec scenarios map to tests.
2. Run the narrowest relevant check (the affected test file, typecheck of the touched package).
3. Tick the task (`- [x]`) in `tasks.md`.
4. Commit that task alone: `git add -A && git commit -m "<type>(<scope>): <summary> (#{{ISSUE_NUMBER}})"` (Conventional Commits).

## Rules

- Stay inside the change's scope. No unrelated refactors, dependency upgrades, or edits to other changes' folders. Note anything worth doing later in `openspec/changes/{{CHANGE_ID}}/followups.md`.
- Never touch secrets, deployment config, Dockerfiles, CI workflows, or migrations that already exist on the default branch, unless a task explicitly says so. New migrations are fine. Leave `.env*` files alone except the committed env template, as below. The one workflow edit allowed is the `.backlog-runner.env` load step described below.
- New environment variables: when code you write reads a variable the app doesn't have yet, add it with a dummy value to `.backlog-runner.env` at the repo root (dotenv `NAME=value` lines, committed). The runner loads that file into installs and gates, but never lets it replace a variable the runner already sets, and refuses names like `PATH` or `NODE_OPTIONS`. Add the variable to the project's committed env template too (`.env.example` or similar) so local setups get it. Dummy values only, never real secrets. Your own shell won't see new entries until the runner's gates run. If a CI workflow job runs the tests that need the variable and doesn't load the file yet, add one step before its test step and change nothing else in the workflow:
  `- run: '[ -f .backlog-runner.env ] && grep -E "^[A-Z_][A-Z0-9_]*=" .backlog-runner.env >> "$GITHUB_ENV" || true'`
- Never disable, skip, or weaken tests or lint rules to get green.
- Never run `git push`, switch branches, or rewrite history.
- Tests run against the local test database and Redis given in the environment, never anything else.
- If the spec is wrong, contradicts the codebase, or needs a product decision: stop, commit what you have, and end your final message with a line starting `BLOCKED:` followed by the specific question.

## Finish

1. Run the full gates: {{GATES}}
2. When every task is ticked and the gates pass, run `openspec archive {{CHANGE_ID}} --yes` to fold the spec deltas into `openspec/specs/`, and commit it as `spec: archive {{CHANGE_ID}}`.
3. Final message: 3–6 bullets on what changed, what a reviewer should look at closely, and any follow-ups. It becomes the PR description. If you added environment variables, end it with a **Production config needed** heading listing each one and what its real value is: the owner sets those in production by hand.

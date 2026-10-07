You are writing an OpenSpec change proposal for the {{PROJECT_NAME}} repo. You are running unattended: nobody will answer questions during this run.

**Do not write implementation code.** Only create files under `openspec/changes/{{CHANGE_ID}}/`. Do not run `git add`, `git commit` or `git push`; the runner commits the change folder itself.

## The backlog item

Issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}

{{ISSUE_BODY}}

### Discussion (triage notes and maintainer answers; these override the issue body)

{{ISSUE_COMMENTS}}

## Research first

1. Read the project context: `openspec/config.yaml` (the `context:` field), and `openspec/project.md` if it exists.
2. Run `openspec list --specs` and read the specs this change touches. Run `openspec list` to see in-flight changes and don't overlap them.
3. Explore the code paths involved. Base the plan on what actually exists and reference real file paths.

## Write `openspec/changes/{{CHANGE_ID}}/`

- **`proposal.md`**
  - `## Why`: 1–3 sentences, the user or business reason.
  - `## What Changes`: bullets. Mark breaking changes **BREAKING**.
  - `## Impact`: affected specs, code areas, migrations, and any change to API contracts.
- **`tasks.md`**: a numbered checklist (`- [ ] 1.1 …`) grouped under `## 1. …` headings. Each task is one coherent commit, names the files it touches, and includes its tests. Order tasks so the default branch stays green after every one (for example migration → model/service → validation/controller → API types → UI). At most about 12 tasks.
- **`design.md`**: only if there's a real technical decision (data shape, job or queue design, caching strategy). State the options considered and the choice.
- **`specs/<capability>/spec.md`**: spec deltas under `## ADDED Requirements`, `## MODIFIED Requirements` or `## REMOVED Requirements`. Each `### Requirement: …` uses SHALL/MUST and has at least one `#### Scenario: …` with `- **WHEN** …` / `- **THEN** …` bullets. Scenarios must be testable; they become the acceptance tests.

Then run `openspec validate {{CHANGE_ID}} --strict` and fix until it passes.

## When to stop instead

Do not create the change folder, and end your final message with exactly one of these lines, if:

- `NEEDS_DECISION: <numbered, specific questions>`: a product or domain choice you'd be guessing at (permission behaviour, UX with more than one reasonable answer, domain rules the context doesn't settle).
- `NEEDS_SPLIT: <proposed split, one issue per line>`: more than about 12 tasks, or more than one independently shippable outcome.

Otherwise your final message is a short summary of the proposal, with each assumption you made on its own line starting `Assumption:`. It becomes the PR description, so write it for a maintainer to review quickly.

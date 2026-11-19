You are reviewing an OpenSpec change proposal for the {{PROJECT_NAME}} repo before it is built. Another agent wrote it; you have a fresh context and nobody will answer questions during this run. Your review replaces the owner's: once you pass it, the runner implements it without a human looking first.

**Read only.** Do not edit, create or delete any file.

## The backlog item

Issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}

{{ISSUE_BODY}}

### Discussion (triage notes and maintainer answers; these override the issue body)

{{ISSUE_COMMENTS}}

## What to read

1. The proposal: everything under `openspec/changes/{{CHANGE_ID}}/` (`proposal.md`, `tasks.md`, `design.md` if present, `specs/`).
2. The project context: `openspec/config.yaml`, and `openspec/project.md` if it exists.
3. Enough of the code the tasks name to check the plan matches what exists.

## Check

- **Nothing missing:** every requirement, acceptance criterion, example and maintainer answer in the issue and discussion maps to a task and, where it describes behaviour, a spec scenario. This is the main question.
- **Nothing extra:** no work the issue didn't ask for.
- **Buildable:** tasks name real files, are ordered so the default branch stays green, and each includes its tests. Scenarios are testable.
- **Assumptions:** each assumption the proposal makes is safe to make without asking. One that settles a product or domain choice is not.

Small wording or style points are not gaps. Only flag what would make the implementation wrong or incomplete.

## Return

- `verdict`: `pass` if nothing above fails; `revise` if the writer can fix the gaps from the issue and the code alone; `needs-decision` if a gap needs the owner's answer.
- `gaps`: one specific, actionable line per problem (what is missing or wrong, and where). Empty on `pass`.
- `questions`: for `needs-decision`, the numbered questions for the owner.
- `notes`: one or two sentences for the owner on what you checked and anything a PR reviewer should look at.

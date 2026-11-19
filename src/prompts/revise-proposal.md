A reviewer checked the OpenSpec proposal in `openspec/changes/{{CHANGE_ID}}/` against issue #{{ISSUE_NUMBER}} ({{ISSUE_TITLE}}) and found gaps. Fix every one. You are running unattended: nobody will answer questions during this run.

**Do not write implementation code.** Only edit files under `openspec/changes/{{CHANGE_ID}}/`, and no `git` commands.

## Gaps

{{GAPS}}

## The backlog item, for reference

{{ISSUE_BODY}}

### Discussion (these override the issue body)

{{ISSUE_COMMENTS}}

Then run `openspec validate {{CHANGE_ID}} --strict` and fix until it passes.

If a gap can only be closed by a product or domain decision, end your final message with a line `NEEDS_DECISION: <numbered, specific questions>`. Otherwise your final message lists what you changed.

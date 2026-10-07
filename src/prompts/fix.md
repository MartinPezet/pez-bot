You are fixing a failed verification run for OpenSpec change `{{CHANGE_ID}}` (issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}) in the {{PROJECT_NAME}} repo. You are running unattended.

Start by reading the project context (`openspec/config.yaml`, and `openspec/project.md` if it exists) and `openspec/changes/{{CHANGE_ID}}/` for context (it may already be under `openspec/changes/archive/`), and `git log --oneline origin/{{DEFAULT_BRANCH}}..HEAD` to see what's been done.

Gate output:

```
{{GATE_OUTPUT}}
```

Find the root cause and fix it (use the systematic-debugging skill if available). Same rules as the implementation run: stay in scope, never weaken tests or lint rules, never push. Commit the fix as `fix(<scope>): <summary> (#{{ISSUE_NUMBER}})`.

If the failure already exists on the default branch or is outside this change's scope, don't fix it: end your final message with a line starting `BLOCKED:` explaining what's failing and why it isn't this change.

You are fixing a failed verification run for OpenSpec change `{{CHANGE_ID}}` (issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}) in the {{PROJECT_NAME}} repo. You are running unattended.

Start by reading the project context (`openspec/config.yaml`, and `openspec/project.md` if it exists) and `openspec/changes/{{CHANGE_ID}}/` for context (it may already be under `openspec/changes/archive/`), and `git log --oneline origin/{{DEFAULT_BRANCH}}..HEAD` to see what's been done.

Gate output:

```
{{GATE_OUTPUT}}
```

The runner already compared this output with the default branch. Only these failures are new in this change:

```
{{NEW_ERRORS}}
```

Failures not listed there exist on `origin/{{DEFAULT_BRANCH}}` too: leave them alone. Fix only the new ones.

Find the root cause and fix it (use the systematic-debugging skill if available). Same rules as the implementation run: stay in scope, never weaken tests or lint rules, never push. Commit the fix as `fix(<scope>): <summary> (#{{ISSUE_NUMBER}})`.

Don't end with `BLOCKED:` because of failures that also exist on the default branch; the runner has already excluded them. Use `BLOCKED:` only if a new failure is outside this change's scope and you can't fix it. Run commands from the repo root with `git -C` or `npm --prefix`; never `cd` to an absolute path.

You are addressing review comments on the open PR for OpenSpec change `{{CHANGE_ID}}` (issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}) in the {{PROJECT_NAME}} repo. You are running unattended.

Start by reading the project context (`openspec/config.yaml`, and `openspec/project.md` if it exists) and `openspec/changes/{{CHANGE_ID}}/` for context (it may already be under `openspec/changes/archive/`), and `git log --oneline origin/{{DEFAULT_BRANCH}}..HEAD` to see what's been done.

Review comments from the owner, oldest first (inline comments start with the file and line):

```
{{FEEDBACK}}
```

Do what they ask, within this change's scope. If a comment asks you to fix failing tests or CI, run the gates ({{GATES}}) to find the failure; you can't see GitHub Actions. Same rules as the implementation run: never weaken tests or lint rules, never push. Commit each fix as `fix(<scope>): <summary> (#{{ISSUE_NUMBER}})`. If your tools refuse a `git commit` (a permission or safety check, not a hook or a test failure), don't stop and don't look for another way to commit: leave those changes in the working tree and carry on. The runner commits whatever is left uncommitted when you finish and pushes it with the rest. Name those paths in your final message.

If a comment is a question or needs no code change, make no commits and answer it in your final message. If a comment asks for something outside this change, or you can't do it without guessing, end your final message with a line starting `BLOCKED:` explaining what's needed. Run commands from the repo root with `git -C` or `npm --prefix`; never `cd` to an absolute path.

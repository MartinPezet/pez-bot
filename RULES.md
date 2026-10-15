# Rules

## Commits

Format: `<gitmoji>: <Description>`, for example `✨: Add run-window grace period` or `🔥💄: Remove unused styles`.

- Gitmoji from [gitmoji.dev](https://gitmoji.dev/). Stack several when a commit spans types, most significant first.
- Description: imperative, sentence case, no trailing period, under 72 characters including the emoji.
- Body (after a blank line) says *why* whenever the diff doesn't make it obvious.
- Squash-merging a PR appends ` (#N)`; leave it.

| Emoji | Use for | Emoji | Use for |
|---|---|---|---|
| ✨ | New feature | ♻️ | Refactor |
| 🐛 | Bug fix | 🔥 | Remove code or files |
| 🚑️ | Critical hotfix | 🎨 | Structure or format |
| ✅ | Add or update tests | ⚡️ | Performance |
| 📝 | Docs (incl. agent docs) | 🏷️ | Types |
| 🔧 | Config files | 🔒️ | Security |
| 🐳 | Docker | 👷 | CI |
| ⬆️ | Upgrade dependencies | 🔊 | Logging |
| 💥 | Breaking change | ⏪️ | Revert |

## Branches and PRs

Work on a branch, open a PR into `main`, squash-merge. `main` stays green: run `npm run typecheck` and `npm test` before every commit.

## Docs move with the code

Update these in the same commit as the change that makes them stale:

- **`docs/agents/ARCHITECTURE.md`**: module shape, job mechanics, or a new gotcha.
- **`GLOSSARY.md`**: a new or renamed domain term. Use the existing format: bold term, one- or two-sentence definition, `_Avoid_:` synonyms. Domain language only, no implementation detail.
- **`docs/adr/`**: any decision that is hard to reverse, surprising without context, *and* the result of a real trade-off. Write `docs/adr/NNNN-kebab-slug.md` (next number after the highest existing) as a `# Title` and one paragraph: context, decision, why. Record it whenever such a decision is made, whether or not a domain-modeling skill is in use.
- **`README.md`**: anything an operator sees (commands, env vars, `.backlog-runner.json`, security model).

## Session handoff

Before the final message of any session that changed code or docs, rewrite `CONTEXT.md`: replace its three sections with the current truth and drop anything that no longer holds.

# Rules

## Commits

Format: `<gitmoji>: <Description>`, for example `✨: Add run-window grace period` or `🔥💄: Remove unused styles`.

- Gitmoji from [gitmoji.dev](https://gitmoji.dev/). Stack several when a commit spans types, most significant first.
- Description: imperative, sentence case, no trailing period, under 72 characters including the emoji.
- Body (after a blank line) says *why* whenever the diff doesn't make it obvious.
- Every commit on a branch lands on `main` as-is, so each one follows this format; no `wip`/`fixup` commits in a PR.

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
| 🔀 | Merge commit | | |

## Branches and PRs

Work on a branch, open a PR into `main`, merge with a merge commit (no squash, no rebase). Title the merge commit `🔀: Merge #N <PR title without its emoji>`. `main` stays green: run `npm run typecheck` and `npm test` before every commit.

## Verify statuses, don't trust them

A label, a PR state, a CI result or a line in `CONTEXT.md` is a claim, not a fact. Check the source before acting on it or reporting it.

- **When working:** before saying something is done, passing, merged or stuck, look it up (`gh pr view`, `gh run list`, the test output). If you can't check, say "not verified" rather than repeating the claim.
- **In the runner's code:** an unreadable status is unknown, never success. Don't turn an API error into "nothing to do" with only a log line; surface it (digest, comment, or `state:blocked`) so a stale label can't hide a real failure.

## Docs move with the code

Update these in the same commit as the change that makes them stale:

- **`docs/agents/ARCHITECTURE.md`**: module shape, job mechanics, or a new gotcha.
- **`GLOSSARY.md`**: a new or renamed domain term. Use the existing format: bold term, one- or two-sentence definition, `_Avoid_:` synonyms. Domain language only, no implementation detail.
- **`docs/adr/`**: any decision that is hard to reverse, surprising without context, *and* the result of a real trade-off. Write `docs/adr/NNNN-kebab-slug.md` (next number after the highest existing) as a `# Title` and one paragraph: context, decision, why. Record it whenever such a decision is made, whether or not a domain-modeling skill is in use.
- **`README.md`**: anything an operator sees (commands, env vars, `.backlog-runner.json`, security model).

## Session handoff

Before the final message of any session that changed code or docs, rewrite `CONTEXT.md`: replace its three sections with the current truth and drop anything that no longer holds.

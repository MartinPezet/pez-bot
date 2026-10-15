# GitHub App is the primary auth path

Fine-grained PATs can't contribute to a personal repo where the bot is only a collaborator, and one token must also write Discussions on `DIGEST_REPO`. So a GitHub App installed on both repos is the documented path (PRs show as `app[bot]`); a classic `repo`-scope PAT on a bot user stays as the fallback. Fine-grained PATs are supported only for org-owned repos.

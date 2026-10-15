# No git credential on disk

No `gh auth setup-git` and no `hosts.yml`. Pushes use a per-invocation `GIT_ASKPASS` that reads the token from the runner's memory, so the agent user can never find and reuse it.

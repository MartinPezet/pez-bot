# Two OS users: runner and agent

Claude and the gate commands run agent-written code. Under the runner's uid they could read `/proc/<runner>/environ`, the App key and SQLite, so a stripped environment alone isn't enough. `runner` owns secrets, state and every GitHub write; `agent` runs Claude, installs and gates through a narrow `sudo -u agent` rule with `env_reset` and an explicit env allowlist. Worktrees are group-writable by both.

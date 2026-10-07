#!/bin/bash
# Runs as root under tini: firewall, volume ownership, secret hand-off, then drops to `runner`.
set -euo pipefail

mkdir -p /data/repo /data/worktrees /data/state /data/logs /data/pnpm-store /run/runner

# State and logs may contain secrets-adjacent data: runner only.
chown runner:work /data/state /data/logs /run/runner
chmod 0700 /data/state /data/logs /run/runner
# Repo, worktrees and the pnpm store are shared with the agent through the `work` group.
chown runner:work /data/repo /data/worktrees /data/pnpm-store
chmod 2775 /data/repo /data/worktrees /data/pnpm-store
chown agent:work /home/agent/.local /home/agent/.claude

# The App key must be readable by runner and never by agent. Copy it somewhere runner-only,
# and refuse to start if the original mount is readable by the agent user.
if [ -n "${GH_APP_PRIVATE_KEY_FILE:-}" ]; then
  if [ ! -f "$GH_APP_PRIVATE_KEY_FILE" ]; then
    echo "entrypoint: GH_APP_PRIVATE_KEY_FILE=$GH_APP_PRIVATE_KEY_FILE does not exist" >&2
    exit 1
  fi
  if setpriv --reuid=agent --regid=work --clear-groups test -r "$GH_APP_PRIVATE_KEY_FILE"; then
    echo "entrypoint: $GH_APP_PRIVATE_KEY_FILE is readable by the agent user." >&2
    echo "entrypoint: on the host, run: sudo chown root:root <key> && sudo chmod 0400 <key>" >&2
    exit 1
  fi
  install -o runner -g runner -m 0400 "$GH_APP_PRIVATE_KEY_FILE" /run/runner/gh-app.pem
  export GH_APP_PRIVATE_KEY_FILE=/run/runner/gh-app.pem
fi

# Firewall. A failure is recorded in firewall.json; the runner then refuses all jobs.
if ! /opt/runner/docker/init-firewall.sh init; then
  echo "entrypoint: firewall setup failed; jobs will not run (see /data/state/firewall.json)" >&2
fi
# CDN-hosted IPs rotate: re-resolve and swap the allowlist every 15 minutes.
( while sleep 900; do /opt/runner/docker/init-firewall.sh refresh || true; done ) &

umask 0002
exec setpriv --reuid=runner --regid=work --init-groups --inh-caps=-all --bounding-set=-net_admin,-net_raw \
  env HOME=/home/runner node /opt/runner/dist/cli.js "$@"

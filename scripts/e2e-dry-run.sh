#!/usr/bin/env bash
# End-to-end smoke test: the whole stack with DRY_RUN=1 against a throwaway sandbox repo.
#
#   TARGET_REPO=you/pez-bot-sandbox scripts/e2e-dry-run.sh
#
# Needs a filled-in .env (real GitHub and Claude credentials). Runs under its own compose
# project, so it never touches a real runner's volumes. Claude jobs (triage, work, usage probe)
# only run with E2E_CLAUDE=1, because they spend plan usage even in dry run. KEEP=1 leaves the
# stack running afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "e2e: create .env first (cp .env.example .env)" >&2; exit 1; }

project=pez-bot-e2e
override=$(mktemp)
trap 'rm -f "$override"' EXIT
cat >"$override" <<EOF
services:
  runner:
    environment:
      DRY_RUN: "1"
${TARGET_REPO:+      TARGET_REPO: "$TARGET_REPO"}
EOF
dc() { docker compose -p "$project" -f compose.yaml -f "$override" "$@"; }
pb() { dc exec -T runner pez-bot "$@"; }

failures=0
# step <name> <allowed exit codes...> -- <command...>
step() {
  local name=$1; shift
  local allowed=()
  while [ "$1" != "--" ]; do allowed+=("$1"); shift; done
  shift
  echo "==> $name"
  set +e
  "$@"
  local code=$?
  set -e
  for a in "${allowed[@]}"; do [ "$code" = "$a" ] && return 0; done
  echo "e2e: FAILED: $name (exit $code)" >&2
  failures=$((failures + 1))
}

step "build" 0 -- dc build
step "start" 0 -- dc up -d

echo "==> waiting for the daemon"
for _ in $(seq 1 60); do
  if pb status >/dev/null 2>&1; then break; fi
  sleep 5
done

step "firewall blocks other hosts" 1 6 7 28 35 -- dc exec -T runner curl -s --connect-timeout 5 -o /dev/null https://example.com
step "firewall allows GitHub" 0 -- dc exec -T runner curl -s --connect-timeout 5 -o /dev/null https://api.github.com/zen
step "setup" 0 -- pb setup
step "sync" 0 75 -- pb sync
step "summary" 0 75 -- pb summary
step "cleanup" 0 75 -- pb cleanup
if [ "${E2E_CLAUDE:-0}" = "1" ]; then
  step "usage probe" 0 -- pb usage --probe
  step "triage" 0 75 -- pb triage --ignore-budget
  step "work" 0 75 -- pb work --ignore-budget
fi
step "status" 0 -- pb status
step "healthcheck" 0 1 -- pb healthcheck

echo "==> intended GitHub writes (dry run)"
dc logs runner 2>/dev/null | grep -o '"msg":"dry-run: would [^"]*"' | sort | uniq -c || echo "(none)"
echo "==> errors in the runner log"
dc logs runner 2>/dev/null | grep '"level":50' | tail -20 || echo "(none)"

if [ "${KEEP:-0}" != "1" ]; then
  echo "==> tearing down"
  dc down -v
fi

if [ "$failures" -gt 0 ]; then
  echo "e2e: $failures step(s) failed" >&2
  exit 1
fi
echo "e2e: all steps passed"

#!/bin/bash
# Default-deny egress, modelled on Anthropic's devcontainer init-firewall.sh
# (github.com/anthropics/claude-code/blob/main/.devcontainer/init-firewall.sh).
#
# Differences from the reference:
# - IPv6 is dropped as well (the reference only configures iptables).
# - DNS is only allowed to the resolvers in /etc/resolv.conf, not to any host on port 53.
# - Instead of the whole host /24, only directly connected non-default networks are allowed
#   (the internal sidecar network).
# - `refresh` re-resolves domains into a new ipset and swaps it in atomically, because
#   CDN-hosted addresses (npm, Anthropic) rotate.
# - The result is written to $FIREWALL_STATE_FILE for the runner and the health check.
#
# Usage: init-firewall.sh init|refresh
set -euo pipefail
IFS=$'\n\t'

MODE=${1:-init}
STATE_FILE=${FIREWALL_STATE_FILE:-/data/state/firewall.json}
SET=allowed-domains

DOMAINS=(
  api.anthropic.com platform.claude.com claude.ai downloads.claude.ai storage.googleapis.com
  registry.npmjs.org
  github.com api.github.com codeload.github.com uploads.github.com
  objects.githubusercontent.com raw.githubusercontent.com release-assets.githubusercontent.com
)
if [ -n "${HEALTH_PING_URL:-}" ]; then
  DOMAINS+=("$(echo "$HEALTH_PING_URL" | sed -E 's#^[a-z]+://([^/:]+).*#\1#')")
fi
if [ -n "${EXTRA_ALLOWED_DOMAINS:-}" ]; then
  IFS=',' read -r -a extra <<<"$EXTRA_ALLOWED_DOMAINS"
  for d in "${extra[@]}"; do d=$(echo "$d" | tr -d '[:space:]'); [ -n "$d" ] && DOMAINS+=("$d"); done
fi

write_state() { # ok error blocked allowed
  jq -n --argjson ok "$1" --arg error "$2" --arg blocked "$3" --arg allowed "$4" \
    --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{ok: $ok, checkedAt: $at, error: (if $error == "" then null else $error end), blocked: $blocked, allowed: $allowed}' \
    >"$STATE_FILE.tmp"
  chmod 0644 "$STATE_FILE.tmp"
  mv "$STATE_FILE.tmp" "$STATE_FILE"
}
fail() {
  echo "firewall: ERROR: $1" >&2
  write_state false "$1" "" ""
  exit 1
}

# Fill ipset $1 with GitHub's published ranges and every allowed domain's A records.
build_set() {
  local name=$1
  ipset create "$name" hash:net -exist
  ipset flush "$name"

  local meta
  meta=$(curl -fsS --max-time 20 https://api.github.com/meta) || { echo "failed to fetch GitHub /meta"; return 1; }
  echo "$meta" | jq -e '.web and .api and .git' >/dev/null || { echo "GitHub /meta missing web/api/git"; return 1; }
  while read -r cidr; do
    ipset add "$name" "$cidr" -exist
  done < <(echo "$meta" | jq -r '(.web + .api + .git)[]' | grep -E '^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$' | aggregate -q)

  local d ips ip
  for d in "${DOMAINS[@]}"; do
    ips=$(dig +noall +answer A "$d" | awk '$4 == "A" {print $5}')
    [ -n "$ips" ] || { echo "failed to resolve $d"; return 1; }
    while read -r ip; do
      [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "invalid IP $ip for $d"; return 1; }
      ipset add "$name" "$ip" -exist
    done <<<"$ips"
  done
}

verify() {
  if curl -s --connect-timeout 5 https://example.com >/dev/null 2>&1; then
    fail "verification failed: able to reach https://example.com"
  fi
  local gh an
  gh=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 https://api.github.com/zen || true)
  [ "$gh" != "000" ] || fail "verification failed: cannot reach https://api.github.com"
  an=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 https://api.anthropic.com/ || true)
  [ "$an" != "000" ] || fail "verification failed: cannot reach https://api.anthropic.com"
  write_state true "" "example.com blocked" "api.github.com ($gh), api.anthropic.com ($an) reachable"
  echo "firewall: verified (example.com blocked; GitHub and Anthropic reachable)"
}

init() {
  # Keep Docker's embedded DNS NAT rules across the flush.
  local dns_rules
  dns_rules=$(iptables-save -t nat | grep "127\.0\.0\.11" || true)
  iptables -F; iptables -X
  iptables -t nat -F; iptables -t nat -X
  iptables -t mangle -F; iptables -t mangle -X
  ipset destroy "$SET" 2>/dev/null || true
  if [ -n "$dns_rules" ]; then
    iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
    iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
    echo "$dns_rules" | xargs -L 1 iptables -t nat
  fi

  local err
  err=$(build_set "$SET" 2>&1) || fail "allowlist: $err"

  # IPv6: loopback only. (Compose also disables IPv6; this covers hosts where that fails.)
  if command -v ip6tables >/dev/null && ip6tables -L >/dev/null 2>&1; then
    ip6tables -F
    ip6tables -A INPUT -i lo -j ACCEPT
    ip6tables -A OUTPUT -o lo -j ACCEPT
    ip6tables -P INPUT DROP; ip6tables -P FORWARD DROP; ip6tables -P OUTPUT DROP
  fi

  # Loopback, which also carries Docker's embedded DNS (127.0.0.11).
  iptables -A INPUT -i lo -j ACCEPT
  iptables -A OUTPUT -o lo -j ACCEPT

  # DNS only to the configured resolvers (the host's resolver when not on a user-defined network).
  local ns
  while read -r ns; do
    iptables -A OUTPUT -p udp -d "$ns" --dport 53 -j ACCEPT
    iptables -A OUTPUT -p tcp -d "$ns" --dport 53 -j ACCEPT
  done < <(awk '$1 == "nameserver" && $2 ~ /^[0-9.]+$/ {print $2}' /etc/resolv.conf)

  # Directly connected networks other than the one holding the default route: the sidecars.
  local egress_if net
  egress_if=$(ip route show default | awk '{print $5; exit}')
  while read -r net; do
    [ -n "$net" ] || continue
    iptables -A INPUT -s "$net" -j ACCEPT
    iptables -A OUTPUT -d "$net" -j ACCEPT
    echo "firewall: allowing sidecar network $net"
  done < <(ip -o -4 route show scope link | awk -v e="$egress_if" '$3 != e {print $1}')

  iptables -P INPUT DROP
  iptables -P FORWARD DROP
  iptables -P OUTPUT DROP
  iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
  iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
  iptables -A OUTPUT -p tcp -m set --match-set "$SET" dst -j ACCEPT
  iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

  verify
}

refresh() {
  local err
  if ! err=$(build_set "$SET-new" 2>&1); then
    ipset destroy "$SET-new" 2>/dev/null || true
    echo "firewall: refresh failed, keeping the previous allowlist: $err" >&2
    return 0
  fi
  ipset swap "$SET-new" "$SET"
  ipset destroy "$SET-new"
  verify
}

case "$MODE" in
  init) init ;;
  refresh) refresh ;;
  *) echo "usage: $0 init|refresh" >&2; exit 64 ;;
esac

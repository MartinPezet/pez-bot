# Default-deny egress firewall, re-resolved by root

Modelled on Anthropic's devcontainer `init-firewall.sh`, with its weaknesses fixed: IPv6 is dropped too, the host `/24` is not allowed (it reaches the home LAN), and allowed hostnames are re-resolved every 15 minutes because CDN-backed hosts rotate IPs. The re-resolve runs as a root loop in the entrypoint, since the runner process has dropped `NET_ADMIN`; ipset updates are atomic via `ipset swap`. Claude jobs refuse to run unless the start-up check passed.

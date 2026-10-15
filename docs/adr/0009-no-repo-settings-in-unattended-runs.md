# Unattended Claude runs ignore repo settings and MCP

Claude runs with `--setting-sources user --strict-mcp-config` so a target repo's `.claude/settings.json` hooks and `.mcp.json` servers never execute unattended. `--bare` was rejected: it also skips plugins and never reads OAuth credentials, forcing an API key.

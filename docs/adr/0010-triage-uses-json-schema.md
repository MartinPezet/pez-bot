# Triage returns schema-validated JSON

Triage passes `--json-schema` so the CLI validates output into `structured_output`, instead of parsing JSON out of prose. The runner still re-validates with zod and enforces the label allowlist; it, not the agent, applies every label and comment.

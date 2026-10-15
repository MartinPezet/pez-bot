@RULES.md
@CONTEXT.md

## Context index

Read the doc when its trigger fires:

- `docs/agents/INTENT.md`: scoping a feature, writing an issue, or judging whether a change fits the product.
- `docs/agents/ARCHITECTURE.md`: a change spans modules, touches job mechanics, or crosses the runner/agent boundary.
- `GLOSSARY.md`: naming a domain concept in code, issues, or docs.
- `docs/adr/`: a change could reverse a past decision. Flag any conflict with an ADR explicitly.
- `README.md`: operator-facing behaviour (commands, env vars, `.backlog-runner.json`, security model).

## Agent skills

### Issue tracker

Issues live in GitHub Issues for MartinPezet/pez-bot (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.

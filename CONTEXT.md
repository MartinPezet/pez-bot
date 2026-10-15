# Context

Active memory across sessions. Rewritten at the end of every session that changes code or docs (see `RULES.md`). Keep it to what git, `gh issue list` and the code can't tell you, under ~30 lines.

## Current status

- M2–M8 built and running (2026-10-07). Latest fix: triage passes a draft-07 JSON schema without `$schema` (#6).
- Agent docs layer set up 2026-10-15: `CLAUDE.md` index, `RULES.md`, this file, `GLOSSARY.md`, `docs/adr/`, `docs/agents/{INTENT,ARCHITECTURE}.md`. `PLAN.md` retired; its content now lives in those files.

## Next steps

- Review `docs/agents/INTENT.md` and the ADRs for anything misremembered from `PLAN.md`.

## Known issues

- Usage readings are usually unknown until a threshold event arrives; the `allow` policy covers it (ADR-0008).

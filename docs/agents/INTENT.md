# Intent

Why pez-bot exists and where its edges are. Read when scoping a feature, proposing an issue, or judging whether a change fits.

## Purpose

pez-bot is a self-hosted runner that works through one GitHub backlog unattended. It uses Claude Code in headless mode to turn issues into OpenSpec proposals, has a second agent review them, and turns them into implementation PRs, while the owner only reviews and merges those.

## Who it serves

A solo developer on a Claude Pro/Max plan who shares that plan's usage with the bot. The bot must never crowd out the owner's own use: run windows and budget gates exist for that.

## Goals

- **Human approves, bot executes.** Merging the implementation PR is the only approval. It carries the proposal, which a reviewer agent has already checked against the issue (ADR-0017). Everything between is automatic.
- **Safe unattended.** Agent-written code runs as a separate user with no access to secrets, behind a default-deny egress firewall.
- **Project-agnostic.** The target repo is an input. Everything project-specific lives in that repo (`.backlog-runner.json`, `openspec/`, prompt overrides).
- **Recoverable.** Restarts, usage limits and window ends checkpoint and resume; they don't lose work or block issues.
- **Observable.** The daily digest discussion and `status` say what happened and why, without reading logs.

## Non-goals

- **Never merges, never pushes to the default branch, never closes issues.** These stay human actions.
- **One target repo per container, one job at a time.** No parallel agents, no multi-repo orchestration.
- **No hosted service.** No webhooks; polling on a schedule is enough. The only web UI is an optional, password-protected page for the owner, served by the daemon and off by default (ADR-0018).
- **No money spent.** Cost figures are estimates for a subscription plan, not billing.

---
name: booth
description: Booth coordinates parallel Claude Code sessions (decks) through a daemon. Provides signal meanings, check flow, report format, and deck lifecycle context. Activates when booth signals ([booth-check], [booth-alert], [booth-beat]) appear or when working in a booth-managed project.
---

# Booth

Booth is an AI project manager for Claude Code. It runs a daemon that dispatches tasks to parallel CC sessions (called "decks"), monitors their progress via JSONL events, and coordinates results through a managing CC session (the "DJ").

## Signals

Booth injects signals into CC sessions via the editor proxy (Ctrl+G mechanism):

| Signal | Target | Meaning |
|--------|--------|---------|
| `[booth-check]` | Deck | Self-verify your work and write a report |
| `[booth-alert]` | DJ | A deck needs attention (check complete, deck exited) |
| `[booth-beat]` | DJ | Periodic patrol — review deck states |

## Deck Modes

| Mode | Behavior |
|------|----------|
| **Auto** (default) | Complete → check → report → notify DJ → auto-kill |
| **Hold** | Complete → check → report → pause (waits for next instruction) |
| **Live** | No auto-check — human drives the session |

## Report Statuses

Decks submit reports via `booth report` CLI → daemon → SQLite:

| Status | Meaning |
|--------|---------|
| `SUCCESS` | Task completed, acceptance criteria met |
| `FAIL` | Task attempted, could not meet criteria |
| `ERROR` | Unexpected error during execution |
| `EXIT` | CC session ended (user `/exit` or crash) |

## Key Paths

| Path | Purpose |
|------|---------|
| `.booth/` | Booth runtime directory (project-local) |
| `.booth/booth.db` | Daemon state + reports (SQLite). Use `booth reports` CLI to read |
| `.booth/logs/` | Daemon logs |

## References

| Reference | Content |
|-----------|---------|
| `references/signals.md` | Signal architecture, reactor rules, check/alert/beat flow |
| `references/cli.md` | CLI command reference, workflows, troubleshooting |

## Role-Specific Skills

DJ and Deck each have dedicated skills with full operational protocols:

| Skill | Content |
|-------|---------|
| `booth-dj` | DJ management handbook — alert/beat response, deck management, report review |
| `booth-deck` | Deck execution protocol — check procedure, review loop, report format |

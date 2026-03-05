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
| `[booth-alert]` | DJ | A deck needs attention (check complete, error, exit) |
| `[booth-beat]` | DJ | Periodic patrol — review deck states |

## Deck Modes

| Mode | Behavior |
|------|----------|
| **Auto** (default) | Complete → check → report → notify DJ → auto-kill |
| **Hold** | Complete → check → report → pause (waits for next instruction) |
| **Live** | No auto-check — human drives the session |

## Report Statuses

Decks write reports to `.booth/reports/<deck>.md`:

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
| `.booth/reports/` | Deck check reports |
| `.booth/decks.json` | Active deck registry |
| `.booth/deck-archive.json` | Archived decks for resume |
| `.booth/mix.md` | DJ management guidelines (customizable) |
| `.booth/check.md` | Deck self-verification template (customizable) |
| `.booth/beat.md` | Beat patrol checklist (customizable) |

## References

Detailed protocols and specifications:

| Reference | Content |
|-----------|---------|
| `references/child-protocol.md` | Deck behavior contract, lifecycle, report format |
| `references/signals.md` | Signal architecture, injection mechanism, editor proxy |
| `references/beat.md` | Periodic patrol trigger conditions and checklist |

### Templates

Cloned to `.booth/` on init. Users customize their local copies — runtime reads `.booth/`, not the package templates.

| Template | Destination | Content |
|----------|-------------|---------|
| `templates/mix.md` | `.booth/mix.md` | DJ management handbook |
| `templates/check.md` | `.booth/check.md` | Deck self-verification framework |
| `templates/beat/work.md` | `.booth/beat.md` | Beat patrol checklist |
| `templates/plan.md` | `.booth/plan.md` | Plan persistence template |

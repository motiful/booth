# Signals Reference

## Signal Architecture

```
JSONL events → Signal module → State module → Reactor → Alerts → DJ
```

Every deck has a JSONL stream. The daemon tails it in real-time.

## Authoritative Signals

| State | Signal | Source |
|-------|--------|--------|
| working | `type=user` or `assistant(tool_use/thinking)` or `progress` | JSONL |
| idle | `subtype=turn_duration` | JSONL |
| error | `subtype=api_error` | JSONL |
| needs-attention | `[NEEDS ATTENTION]` in assistant text | JSONL |

### Design rules

- One authoritative signal per state
- No multi-signal cross-validation
- No debounce needed (turn_duration is definitive)
- capture-pane is debug only, never for core detection

## Alert Types

| Type | Trigger | Action |
|------|---------|--------|
| `deck-idle` | Deck turn completed | Daemon: check report file (see below) |
| `deck-error` | API error | DJ: investigate, retry or escalate |
| `deck-needs-attention` | Deck flagged `[NEEDS ATTENTION]` | DJ: check what it needs |

### Idle + Check Flow

When daemon detects deck idle:
1. Check if `.booth/reports/<deck>.md` exists
2. **No report** → send `[booth-check]` to deck (triggers self-verification)
3. **Report exists with terminal status** → alert DJ to read report and deliver

`[booth-check]` is idempotent — safe to resend after compaction or any interruption.

## Injected Signals

| Signal | Target | When |
|--------|--------|------|
| `[booth-alert]` | DJ | Deck state change (idle with report, error, needs-attention) |
| `[booth-check]` | Deck | Deck idle, no report file yet |
| `[booth-beat]` | DJ | Timer: DJ idle + decks working + cooldown elapsed |

## Alert Format

Alerts are injected into DJ's conversation via stop hook:

```
[booth-alert]
  [14:32:05] Deck "auth-refactor" check complete. Report ready at .booth/reports/auth-refactor.md
[/booth-alert]
```

Check signals are injected into deck's conversation:

```
[booth-check]
  Self-verify your work. Read check.md for instructions.
[/booth-check]
```

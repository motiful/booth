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
| `deck-check-complete` | Deck idle + report has terminal status | DJ: read report, deliver or retry |
| `deck-error` | API error or pane died | DJ: spin review deck or escalate to user |
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

## Alert Delivery (Dual Channel)

Alerts reach DJ through two independent channels:

1. **Passive (stop hook)**: Alerts written to `alerts.json` → stop hook reads on DJ's next turn end → injects `[booth-alert]`
2. **Active (sendMessage)**: Reactor directly injects `[booth-alert]` into DJ pane via tmux send-keys

Both channels may fire for the same alert. Redundancy is harmless — DJ sees the alert at least once regardless of its state (idle or working).

### Stop hook format

```
[booth-alert]
  [14:32:05] Deck "auth-refactor" check complete. Report ready at .booth/reports/auth-refactor.md
[/booth-alert]
```

### Check signal format

```
[booth-check] Read .booth/check.md and follow the self-verification procedure.
  Your report path: .booth/reports/<deck>.md
```

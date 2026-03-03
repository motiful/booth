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
| stopped | Pane detected dead during health check | Daemon (internal) |

### Design rules

- One authoritative signal per state
- No multi-signal cross-validation
- No debounce needed (turn_duration is definitive)
- capture-pane is debug only, never for core detection

## Alert Types

| Type | Trigger | Action |
|------|---------|--------|
| `deck-check-complete` | Deck idle + report has terminal status | DJ: read report, deliver or retry |
| `deck-error` | Error persists beyond 30s recovery window | DJ: spin review deck or escalate to user |
| `deck-needs-attention` | Deck flagged `[NEEDS ATTENTION]` | DJ: check what it needs |

### Error Recovery Window

Deck errors have a 30-second recovery window before alerting DJ:

1. Error detected (API error, pane issue)
2. Start 30s timer
3. If deck emits a `working` event within 30s → error silently absorbed, no alert
4. If 30s elapses with no recovery → alert DJ with context ("during check" or "during work")

This prevents transient errors (rate limits, network blips) from triggering unnecessary escalation.

### Idle + Check Flow (Mode-Dependent)

When daemon detects deck idle, behavior depends on mode:

**Auto mode** (default):
1. Check if `.booth/reports/<deck>.md` exists
2. **No report** → send `[booth-check]` to deck (triggers self-verification)
3. **Report exists with terminal status** → alert DJ → DJ reads report → kill deck

**Hold mode**:
1. Same check flow as auto
2. **Report exists with terminal status** → alert DJ → deck **pauses** (waits for next instruction)
3. DJ can give the deck a new task or kill it

**Live mode**:
1. Idle detected → **nothing happens** (no auto check)
2. Deck stays idle until the human interacts or DJ switches mode

`[booth-check]` is idempotent — safe to resend after compaction or any interruption.

### Mode Switching and Idle

When a deck's mode is switched to auto or hold while it is idle, the daemon immediately triggers the check flow (same as if idle was just detected). In-flight checks are not interrupted by mode switches.

### Plan Mode Auto-Approve (Mode-Dependent)

CC may enter plan mode (`EnterPlanMode` tool_use) during complex tasks, self-restricting to read-only and blocking execution.

**Detection**: JSONL `assistant` messages with `tool_use` blocks named `EnterPlanMode` or `ExitPlanMode`.

**Response by mode**:

| Mode | On EnterPlanMode | On ExitPlanMode |
|------|-----------------|-----------------|
| **Auto** | Log warning | Start 3s timer → send Enter to approve |
| **Hold** | Log warning | Start 3s timer → send Enter to approve |
| **Live** | Log only (ignored) | Log only (ignored) |

The 3s delay allows `--dangerously-skip-permissions` to auto-resolve if possible. If the deck emits a `working` event within 3s (meaning it moved on), the timer is canceled. Enter is only sent if the deck appears stuck at the approval UI.

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
[booth-check] Read /absolute/path/to/.booth/check.md and follow the self-verification procedure. Your report path: /absolute/path/to/.booth/reports/<deck>.md
```

Paths are absolute (resolved from the project root). If `.booth/check.md` does not exist, a fallback message is sent instead:

```
[booth-check] Self-verify your work. Write report to: /absolute/path/to/.booth/reports/<deck>.md with YAML frontmatter `status: SUCCESS` or `status: FAIL`.
```

If the deck was spun with `--no-loop`, an additional suffix is appended: `Skip the sub-agent review loop. Write your report directly.`

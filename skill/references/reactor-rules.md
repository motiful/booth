# Reactor Design Rules

Rules extracted from production incidents. Violating these causes silent failures.

## Rule 1: Idempotent Signals — Resend on Idle, Never on Timer

**Pattern**: Signal is idempotent → lost signal can be resent → but distinguish event-triggered vs timer-triggered to prevent pile-up.

**Why**: A deck that hits API limit / context compaction loses the check message. When it goes idle again, the daemon must resend. But a 30s poll timer resending creates infinite loops — 300 messages pile up in 2.5 hours, burning tokens when CC recovers.

**Rule**:
- **Idle signal** (event-driven, `fromIdle=true`): resend is safe. Deck completed a turn without producing output → check was lost → resend.
- **Poll timer** (periodic, `fromIdle=false`): only check for the expected output. Never resend. Polls exist to catch missed idle signals, not to drive behavior.

**Implementation**: `runCheck(deck, fromIdle)` parameter. `triggerCheck` (from idle/mode-switch) passes `true`. Poll passes `false` (default).

## Rule 2: Tail Replay on Reload — Use replayLines=0

**Pattern**: `tail -f -n N` replays the last N lines when a watcher starts. On daemon reload/restart, this replays stale JSONL events.

**Why**: A JSONL tail containing `idle→working→idle` bypasses state deduplication (which only blocks consecutive identical states). Each idle triggers handlers as if the deck just went idle — causing duplicate check sends, duplicate beats, etc.

**Rule**:
- **Daemon startup restoring existing sessions**: `replayLines=0`. State is already in DB — no replay needed.
- **New deck registration / session-changed**: `replayLines=20` (default). Need to read recent events to determine initial state.

**Implementation**: `signal.watch(id, path, replayLines)` parameter, threaded through `watchOrWait`.

## Rule 3: Beat Fires Unconditionally

**Pattern**: Periodic status reports must not gate on the recipient's state.

**Why**: Beat gated on "DJ idle" means DJ never learns about stuck decks while working. The exact time DJ is busy is when decks are most likely to need attention. CC's message queue handles delivery to a working session — messages are queued, not lost.

**Rule**:
- Beat trigger: active decks exist + cooldown elapsed. No DJ-idle check.
- Beat content: flag anomalies (stale checks >10min) — don't just list statuses.

## Rule 4: Destructive Actions Require Explicit Authorization

**Pattern**: Killing decks, stopping the daemon, and other irreversible actions must not be taken autonomously.

**Why**: A deck that appears "stuck" might be at an API limit that will resolve. A deck that "finished its task" might have follow-up work queued. Only the user or DJ (with user's mandate) should make kill decisions.

**Rule**:
- Deck kill: only by user command or DJ following mix.md protocol
- Booth stop: only by explicit user request
- No self-kill: a deck or DJ session never kills itself

# Booth

> Every idea you have becomes a running task.
> Booth manages them all — so your head stays clear.

Booth is an AI project manager for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). You keep thinking, keep branching — Booth dispatches each idea as a parallel CC session (called a **deck**), monitors progress in real-time, verifies quality against your standards, and delivers structured reports. You never lose track. You never manage folders. You just keep going.

## Signal-Reactive Orchestration

Booth's architecture is **signal-reactive** — the daemon never polls CC, never reads terminal output, and never uses cron timers to check status. Instead, it watches the authoritative JSONL event stream that CC already emits, and reacts to state transitions.

### How It Works

```
CC writes JSONL ──▶ Signal module (tail -f) ──▶ State module ──▶ Reactor ──▶ Action
```

1. **Signal**: Every CC session writes a JSONL transcript. Booth `tail -f`s each one. Specific event patterns map to exactly one deck state (`working`, `idle`, `checking`, `exited`).

2. **State**: State transitions are deduplicated (idle→idle = no-op) and persisted to SQLite. The in-memory cache serves hot-path reads; the DB is the source of truth.

3. **Reactor**: Listens to state-change events and triggers actions — send a check prompt, notify the DJ, schedule a beat, auto-approve plan mode.

### Why Not Loop / Cron / Heartbeat?

| Approach | Problem |
|----------|---------|
| **Poll loop** (capture-pane every N seconds) | Expensive, unreliable (terminal state ≠ CC state), races with CC's own TUI |
| **Cron/interval check** | Misses events between ticks, adds latency, wastes cycles when nothing changes |
| **Heartbeat from CC** | Requires CC to cooperate (it doesn't — CC has no plugin API) |
| **Signal-reactive** (Booth) | Zero-cost when idle, instant response on state change, no coupling to CC internals beyond the documented JSONL format |

The JSONL stream is CC's own audit log — it exists whether Booth watches it or not. Booth adds zero overhead to CC's operation.

### The Quality Loop

When a deck goes idle, the reactor triggers a **check flow**:

1. Send `[booth-check]` prompt to the deck → deck self-verifies its work
2. Deck writes a report with YAML frontmatter (`status: SUCCESS` or `status: FAIL`)
3. Reactor detects the report, compares git state before/after check
4. If code changed during check → re-trigger (up to 5 rounds)
5. Final report → notify the DJ (managing CC session) → open in editor

This is a **mechanism**, not a prompt. The deck doesn't need to be told "remember to check your work" — the daemon enforces it structurally.

### Deck Lifecycle

```
spin ──▶ working ◀──▶ idle ──▶ checking ──▶ idle ──▶ exited
                                   │                    ▲
                                   └── (check loop) ────┘
```

- `working`: CC is executing (tool_use, thinking, processing user input)
- `idle`: CC is at the prompt, waiting for input
- `checking`: Reactor sent a check prompt, awaiting report
- `exited`: Deck is done — killed by user, or CC session ended

Shutdown does **not** change deck status. Decks stay `working`/`idle` in the DB, and are naturally resumed on next `booth` start.

## Deck Modes

| Mode | Behavior |
|------|----------|
| **Auto** (default) | idle → check → report → notify DJ |
| **Hold** | idle → check → report → pause (waits for DJ instruction) |
| **Live** | No auto-check — human drives the session |

## Quick Start

> Heads up: the npm package is scoped as `@motiful/booth`. Don't run `npm install -g booth` — that installs an unrelated third-party package.

```bash
npm install -g @motiful/booth
cd your-project
booth init          # First-time setup
booth               # Start Booth (launches daemon + DJ)
booth spin my-task  # Create a parallel deck
booth ls            # See all deck states
booth kill my-task  # Kill a deck
booth stop          # Stop everything
```

## Architecture

```
CLI (booth) ──Unix socket──▶ Daemon ──▶ tmux sessions
                               │
                    ┌──────────┼──────────┐
                    ▼          ▼          ▼
                 Signal     State     Reactor
              (JSONL tail) (SQLite)  (event handlers)
```

- **CLI**: Thin client. Sends IPC commands, displays results.
- **Daemon**: Long-running Node.js process. Owns all state and signal processing.
- **Signal**: Spawns `tail -f` per deck JSONL. Parses events into state transitions.
- **State**: SQLite DB (`.booth/booth.db`). In-memory Map as read cache.
- **Reactor**: Event-driven. Responds to `deck:idle`, `deck:working`, etc.

All business logic is in Node.js. CC hooks are 2-line bash wrappers that call into the daemon via IPC.

## License

MIT

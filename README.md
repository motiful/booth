# Booth

> Pour in every idea you have. Booth turns them into parallel AI workers — dispatches, monitors, verifies, nudges them to commit. You stay on strategy.

## Install

```bash
npm install -g @motiful/booth
booth setup    # installs CC skill + crontab guardian
```

## Quick Start

```bash
booth              # creates .booth/, starts DJ, auto-attaches
# Inside: spin, watch, takeover, return, kill, status
# Ctrl-B D to detach from tmux
booth              # re-attaches to existing DJ
```

## Per-project Instances

Each project gets its own Booth instance, anchored by a `.booth/` directory (like `.git/`):

```
~/project-a/.booth/    → own DJ + decks, own tmux socket
~/project-b/.booth/    → separate DJ + decks, separate socket
```

- `booth` walks up from cwd to find `.booth/`
- No `.booth/` found → auto-creates one in cwd
- Socket name: `booth-<basename>-<hash8>` (deterministic, no collisions)

## Commands

### CLI

| Command | What it does |
|---------|-------------|
| `booth [<path>]` | Start DJ and attach (or re-attach if running) |
| `booth a [<name>]` | Attach to DJ, or a specific deck |
| `booth ls` | List sessions and deck registry |
| `booth kill [<name>]` | Kill a specific deck, or everything |
| `booth watch <name>` | Peek at a deck (popup in tmux, read-only outside) |
| `booth info` | Show current project's Booth status |
| `booth ps` | List all running Booth instances |
| `booth setup` | Install CC skill + crontab guardian |
| `booth -h` | Show usage |

### Inside Booth (DJ session)

Once attached, Booth speaks shorthand:

| Command | What it does |
|---------|-------------|
| `spin <name>` or `spin: <desc>` | Create a new deck |
| `watch <name>` | Observe a deck (read-only) |
| `takeover <name>` | Pause monitoring, you drive |
| `return` | Hand control back to Booth |
| `detach <name>` | Unbind (session stays, Booth stops watching) |
| `kill <name>` | Shut down a deck |
| `status` | Show all decks and their state |

Natural language works too — just say what you mean.

## How It Works

```
You <-> DJ (coordinator in tmux)
         |
         +-- deck: "api-refactor"   -> CC in ~/project/
         +-- deck: "research-auth"  -> CC in ~/motifpool/research-auth/
         +-- deck: "fix-ci"         -> CC in ~/project/.claude/worktrees/fix-ci
```

**DJ** = the Booth DJ. Your main Claude Code session, the coordinator.
**Deck** = a child CC session in tmux. An independent unit doing its own thing.

Each deck is a fully independent Claude Code process: own context window, own conversation history. The DJ monitors them via dual-channel detection (JSONL transcript + `tmux capture-pane`), detects state changes, and reports back.

### Three Distribution Modes

| Mode | Entry | Install |
|------|-------|---------|
| **CLI** | `booth` | `npm install -g @motiful/booth` |
| **CC Skill** | `/booth-skill` | `booth setup` auto-installs |
| **OpenClaw** | OpenClaw loads it | Future |

Core code is shared (`skill/` directory), three distribution channels.

### How AI Watches AI

Booth's watchdog is a background process that monitors every deck in real time — zero tokens consumed while decks are working.

**The information flow:**

```
Deck activity (JSONL transcript)
  → Watchdog detects state change (idle / error / needs-attention)
    → Writes alert to .booth/alerts.json
      → DJ's stop hook reads alerts after each turn
        → DJ sees [booth-alert] in context, takes action
```

If DJ is idle when an alert arrives (no turn running, so no stop hook), the watchdog sends a `[booth-wake]` signal via tmux to start a new turn — DJ wakes up, the turn ends, stop hook fires, alerts are consumed.

**Self-healing:** A cron job (`booth-guardian.sh`) checks every 3 minutes that the watchdog process is alive. If it crashed, the guardian restarts it automatically. You never need to babysit the babysitter.

**What you'll see:**
- `[booth-alert]` lines in DJ's output — that's the stop hook delivering deck status
- `⚠ Booth: ...` toast in tmux — only for critical errors
- Watchdog logs in `/tmp/booth-watchdog-*.log` — if you're curious about internals

### The Control Spectrum

```
Hands-on                                              Hands-off
|----|----|----|----|----|----|----|----|----|----|----|
Copilot  Takeover  Watch           Return     Detach
```

You can always intervene. That safety net is what lets you dump 10 ideas in without anxiety.

## Architecture

```
booth/
├── bin/booth.ts              # CLI entry (#!/usr/bin/env node)
├── src/
│   ├── cli.ts                # Command router (8 commands)
│   ├── commands/*.ts         # start, attach, ls, kill, watch, info, ps, setup, help
│   ├── constants.ts          # Project discovery, socket naming
│   ├── scripts.ts            # Bash script executor
│   ├── crontab.ts            # Crontab install/uninstall
│   └── skill-installer.ts    # CC skill copy + path patching
├── skill/                    # Shared brain (CC skill + bash scripts)
│   ├── SKILL.md              # Operational protocol
│   ├── booth.tmux.conf       # Booth-specific tmux config
│   ├── scripts/              # 7 bash scripts
│   └── references/           # 8 operational guides
└── dist/                     # Build output
```

TypeScript CLI is a thin shell — zero runtime dependencies, delegates all tmux ops to bash scripts.

## Requirements

- macOS or Linux
- Node.js >= 18
- `tmux`
- Claude Code CLI (`claude`)

## License

MIT

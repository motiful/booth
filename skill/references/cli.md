# CLI Reference

## Command Quick Reference

| Command | Description |
|---------|-------------|
| `booth` | Start booth (auto-init on first run), attach to tmux session |
| `booth init` | Register booth skill and check recommended skills (re-runnable) |
| `booth spin <name>` | Create a new deck (parallel CC session) |
| `booth ls` | List all active decks with status, mode, and age |
| `booth status <name>` | Show detailed info for a specific deck |
| `booth peek <name>` | View a deck's terminal output (capture-pane) |
| `booth send <name> --prompt "..."` | Send a prompt to a deck (idle/holding) |
| `booth kill <name>` | Kill a deck and remove it from state |
| `booth resume` | Resume all archived decks |
| `booth resume <name>` | Resume a specific archived deck |
| `booth resume --list` | List archived decks available for resume |
| `booth stop` | Stop booth entirely (daemon + all decks + tmux session) |
| `booth reload` | Hot-restart daemon (preserves tmux sessions and deck state) |
| `booth auto <name>` | Switch deck to auto mode |
| `booth hold <name>` | Switch deck to hold mode |
| `booth live <name>` | Switch deck to live mode |
| `booth reports` | List all reports with status and age |
| `booth reports <name>` | Print a report to stdout |
| `booth reports open <name>` | Open a report in editor |
| `booth config set <key> <value>` | Set a config value |
| `booth config get <key>` | Get a config value |
| `booth config list` | Show all config |

## spin Options

```
booth spin <name> [--prompt "..."] [--live] [--hold] [--no-loop]
```

| Flag | Effect |
|------|--------|
| `--prompt "..."` | Task description for the deck |
| `--hold` | Start in hold mode (check then pause, don't auto-kill) |
| `--live` | Start in live mode (no auto-check, human drives) |
| `--no-loop` | Skip sub-agent review loop during check phase |

Without `--prompt`, the deck starts as a bare CC session (useful with `--live`).

## resume Options

```
booth resume [<name>] [--list] [--hold] [--id <session-id>] [--pick <n>]
```

| Flag | Effect |
|------|--------|
| `--list` | List archived decks without resuming |
| `--hold` | Resume in hold mode regardless of original mode |
| `--id <session-id>` | Resume by CC session ID |
| `--pick <n>` | When multiple archives share a name, pick the nth (default: 1) |

## peek Options

```
booth peek <name> [--lines <n>]
```

Default: 50 lines. Useful for debugging — shows the raw terminal output.

## Typical Workflow

### 1. Start booth

```bash
booth              # starts daemon, launches DJ, attaches tmux
```

### 2. Spin decks

```bash
# Fire-and-forget task
booth spin fix-typo --prompt "Fix the typo in README.md line 42"

# Multi-step task (deck pauses after each check)
booth spin refactor --hold --prompt "Refactor the auth module"

# Interactive session
booth spin explore --live
```

### 3. Monitor progress

```bash
booth ls                 # quick overview
booth status fix-typo    # detailed deck info
booth peek fix-typo      # see what the deck is doing
```

DJ also receives automatic notifications (`[booth-alert]` when decks finish, `[booth-beat]` for periodic patrol).

### 4. Review results

```bash
booth reports            # list all reports
booth reports fix-typo   # read a report
```

### 5. Clean up

```bash
booth kill fix-typo      # kill a single deck
booth stop               # stop everything (daemon + all decks)
```

## Modes: auto / hold / live

| Mode | When to use |
|------|-------------|
| **Auto** (default) | Fire-and-forget tasks. Deck works, self-checks, reports, and is auto-killed. |
| **Hold** | Multi-step or iterative tasks. Deck pauses after check — DJ can give it another task via `booth send`. |
| **Live** | Interactive debugging or exploration. No automation — you drive the session directly. |

### Switching modes at runtime

```bash
booth hold fix-typo    # pause after next check instead of killing
booth auto fix-typo    # revert to fire-and-forget
booth live fix-typo    # disable auto-check entirely
```

Mode switches take effect on the next state transition. If a check is already in-flight, it completes normally. Switching to auto/hold while idle immediately triggers the check flow.

## reload vs stop

| | `booth reload` | `booth stop` |
|--|----------------|--------------|
| **What it does** | Hot-restart daemon only | Kill daemon + all decks + tmux session |
| **Deck impact** | None — tmux panes survive, state recovered from `state.json` | All decks destroyed |
| **When to use** | After updating booth code, fixing daemon bugs | Shutting down for the day, resetting everything |
| **Reversibility** | Non-destructive | Destructive — decks and in-progress work are lost |

**Rule of thumb:** Use `reload` when the daemon needs a restart. Use `stop` only when you want to tear everything down.

## Troubleshooting

### Deck stuck in "working" state

A deck shows `working` in `booth ls` but doesn't seem to be making progress.

1. **Peek at the deck:** `booth peek <name> --lines 100`
   - If CC is waiting for input (permission prompt, plan mode approval), the deck may be stuck at a UI prompt
   - If the terminal shows activity, the deck is still working — be patient
2. **Check deck age:** `booth status <name>` — if updated recently, it's still active
3. **Check for CC plan mode:** The daemon auto-approves plan mode exit in auto/hold modes (3s delay). If the deck is in live mode, plan mode won't be auto-approved
4. **Check JSONL tailing:** The daemon may have lost its JSONL tail. Try `booth reload` to reconnect
5. **Last resort:** `booth kill <name>` and re-spin

### Beat not triggering

Beat requires all three conditions simultaneously:
1. At least one deck is `working`
2. DJ is `idle`
3. Cooldown has elapsed (starts at 5 min, doubles each time, caps at 60 min)

If beat isn't firing:
- **DJ not idle:** If DJ is working (processing an alert, spinning decks), beat is suppressed. This is expected
- **No working decks:** Beat only fires when decks are active. Check `booth ls`
- **Cooldown:** After a beat, the next one is delayed (5 → 10 → 20 → 40 → 60 min). A user interaction or deck state change resets the cooldown to 5 min
- **JSONL path issue:** The daemon must be tailing DJ's JSONL to detect DJ idle state. If the JSONL path was not communicated on startup, the daemon can't detect DJ status. Try `booth reload`

### Report not found

Reports are stored at `.booth/reports/<deck-name>.md`. If a report has a timestamp suffix:

```bash
# List all report files
ls .booth/reports/

# Find reports by deck name
booth reports           # lists all with status and age
booth reports <name>    # prints report content (finds latest match)
```

`booth reports` uses fuzzy matching — it finds the latest report file whose name starts with the deck name.

### Deck fails to start

1. **tmux not installed:** Booth requires tmux. Install with `brew install tmux` (macOS) or `apt install tmux` (Linux)
2. **Daemon not running:** `booth spin` requires a running daemon. Start with `booth` first
3. **Name conflict:** A deck with the same name already exists. Check `booth ls` and kill or rename
4. **CC launch failure:** The deck's tmux pane starts a shell, then launches CC. If CC fails:
   - Check `booth peek <name>` for error messages
   - Verify `claude` is in PATH
   - Check if `--dangerously-skip-permissions` is accepted by the installed CC version
5. **Editor proxy issue:** If `bin/editor-proxy.sh` is missing or not executable, input protection breaks. Verify with `ls -la $(npm root -g)/booth/bin/editor-proxy.sh`

### Daemon issues

- **Daemon won't start:** Check `.booth/logs/daemon-stderr.log` for errors
- **Socket stale:** If `booth` reports daemon running but commands fail, the socket file may be stale. Run `booth stop` then `booth` to reset
- **State corruption:** If `state.json` is corrupted, `booth stop` + delete `.booth/state.json` + `booth` to start fresh

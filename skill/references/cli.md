# CLI Reference

## Command Quick Reference

| Command | Description |
|---------|-------------|
| `booth` | Start booth (interactive: resume / clean start / show status) |
| `booth init` | Register booth skill and check recommended skills (re-runnable) |
| `booth spin <name>` | Create a new deck (parallel CC session) |
| `booth ls` | List DJ + all active decks with status, mode, and age |
| `booth ls -a` | List DJ + all decks including exited (historical, default limit 20) |
| `booth status <name>` | Show detailed info for a specific deck |
| `booth peek <name>` | View a deck's terminal output (capture-pane) |
| `booth send <name> --prompt "..."` | Send a prompt to a deck (idle/holding) |
| `booth kill <name>` | Kill a deck (marks exited, row preserved in DB) |
| `booth resume` | Resume all non-exited decks (auto-starts daemon if needed) |
| `booth resume <name>` | Resume a specific deck by name — unconditional, any status |
| `booth resume --list` | List all decks (any status) for resume selection |
| `booth stop` | Stop booth entirely (daemon + all decks + tmux session) |
| `booth restart` | Restart booth (stop + start + resume all non-exited decks) |
| `booth restart --clean` | Restart booth clean (stop + start, no deck recovery) |
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
| `--list` | List all decks (any status) without resuming |
| `--hold` | Resume in hold mode regardless of original mode |
| `--id <session-id>` | Resume by CC session ID |
| `--pick <n>` | When multiple archives share a name, pick the nth (default: 1) |

**Resume is unconditional.** `booth resume <name>` works for any deck regardless of status (working, idle, checking, exited). Status is not a gate — the user wants to see the conversation history. `booth resume` (no args) only auto-resumes non-exited decks (system auto-resume has its own criteria).

## ls Options

```
booth ls [-a | --all] [-n <limit> | --limit <limit>]
```

| Flag | Effect |
|------|--------|
| `-a`, `--all` | Show all sessions (DJ + decks) including exited (reads from DB, works without daemon) |
| `-n <limit>`, `--limit <limit>` | Max rows to show in `-a` mode (default: 20) |

Both `booth ls` and `booth ls -a` show the DJ session as the first row with a `[DJ]` icon. Without `-a`, shows DJ + active decks from daemon cache (requires running daemon). With `-a`, reads from DB directly and defaults to 20 rows — use `-n` to adjust (e.g., `booth ls -a -n 50`).

## peek Options

```
booth peek <name> [--lines <n>]
```

Default: 50 lines. Useful for debugging — shows the raw terminal output.

## Typical Workflow

### 1. Start booth

```bash
booth              # interactive: shows status / prompts resume or clean start
```

Bare `booth` behavior depends on state:
- **Daemon running** → shows `booth ls` then attaches tmux session
- **Daemon not running, has resumable decks** → prompts: resume previous decks or clean start?
- **Daemon not running, no resumable decks** → starts directly (daemon + DJ)

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
booth kill fix-typo      # kill a single deck (marks exited, row preserved)
booth stop               # stop everything (status preserved for resume)
booth stop --clean       # stop everything (marks all exited)
```

**Records persist forever.** `booth kill` and `booth stop --clean` mark decks as exited but never delete DB rows. Use `booth ls -a` to view the full history including exited decks.

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

## reload vs restart vs stop

| | `booth reload` | `booth restart` | `booth restart --clean` | `booth stop` | `booth stop --clean` |
|--|----------------|-----------------|------------------------|--------------|---------------------|
| **What it does** | Hot-restart daemon only | Stop + start + resume non-exited decks | Stop clean + clean start | Kill daemon + all decks, preserve status | Kill daemon + all decks, mark all exited |
| **Deck status** | Unchanged | Preserved → resumed to working | All → exited | Unchanged (working/idle in DB) | All → exited |
| **Auto-resume?** | N/A | Yes (non-exited decks) | No | On next `booth` start | No (but `booth resume <name>` works) |
| **When to use** | After updating booth code | Full reset while preserving progress | Full reset, discard old context | Shutting down, plan to resume later | Shutting down, clean slate |
| **DJ context** | Preserved (same session) | New DJ — immediate beat | New DJ — clean start | Gone | Gone |
| **Records** | Preserved | Preserved | Preserved (rows stay, status=exited) | Preserved | Preserved (rows stay, status=exited) |

**Rule of thumb:** Use `reload` when only the daemon needs a restart. Use `restart` for a clean slate with deck recovery. Use `restart --clean` when you want a clean start without old decks. Use `stop` to shut down and resume later. Use `stop --clean` for a clean shutdown. **No operation deletes DB rows** — `booth ls -a` always shows the full history.

### DJ wake-up on restart

When DJ connects to the daemon (via `update-dj-jsonl` IPC), the daemon immediately fires a beat within 500ms — no waiting for the periodic timer. This ensures a new DJ session receives `[booth-beat]` right away and can execute the recovery checklist in `beat.md`.

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

Beat requires both conditions:
1. At least one active deck exists (any status except exited)
2. Cooldown has elapsed (starts at 5 min, doubles each time, caps at 60 min)

DJ status does NOT gate beat — CC's message queue handles delivery to a working session. See `reactor-rules.md` Rule 3.

If beat isn't firing:
- **No active decks:** Beat only fires when decks are active. Check `booth ls`
- **Cooldown:** After a beat, the next one is delayed (5 → 10 → 20 → 40 → 60 min). A user interaction or deck state change resets the cooldown to 5 min
- **JSONL path issue:** The daemon must be tailing DJ's JSONL for status detection. If the JSONL path was not communicated on startup, try `booth reload`

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
- **State corruption:** If `booth.db` is corrupted, `booth stop` + delete `.booth/booth.db` + `booth` to start fresh

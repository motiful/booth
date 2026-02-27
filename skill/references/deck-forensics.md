# Deck Forensics — Where to Find Deck Traces

How to find traces of past decks: what ran, when, what it did, and what it produced.

---

## Data Sources (from freshest to deepest)

### 1. `.booth/decks.json` — Live State

**What:** Currently active decks (mutable JSON).

**Where:** `.booth/decks.json` in the project where Booth was started.

**Tells you:** Name, dir, status, created time, paneId, jsonlPath — everything about decks that are still alive or haven't been archived yet.

**Query:**
```bash
cat .booth/decks.json | jq '.decks[] | {name, status, created}'
```

**Limitation:** Only contains active/non-archived decks. Once all decks in a session complete and the last tmux session closes, `on-session-event.sh` auto-archives everything.

---

### 2. `.booth/decks-archive.jsonl` — Historical Record

**What:** Append-only log of all completed/crashed/detached decks (one JSON object per line).

**Where:** `.booth/decks-archive.jsonl` in the same `.booth/` directory.

**Tells you:** Same fields as `decks.json` plus `archived` timestamp. Each line is a self-contained JSON object — the full deck record at the moment it was archived.

**Query:**
```bash
# List all archived decks
cat .booth/decks-archive.jsonl | jq -r '[.name, .status, .created, .archived] | @tsv'

# Find a specific deck
grep '"name":"my-deck"' .booth/decks-archive.jsonl | jq .

# Count decks by status
cat .booth/decks-archive.jsonl | jq -r '.status' | sort | uniq -c

# Find decks that worked on a specific directory
cat .booth/decks-archive.jsonl | jq -r 'select(.dir | contains("myapp")) | .name'
```

**Key fields:** `name`, `dir`, `status`, `created`, `archived`, `jsonlPath`, `paneId`, `prompt`, `goal`.

**Lifecycle:** `booth-archive.sh` moves terminal-state decks (`completed`, `crashed`, `detached`) from `decks.json` → here. Triggered automatically by `on-session-event.sh` when the last deck session closes, or manually via `booth-archive.sh --name <deck>`.

---

### 3. CC Session JSONL — Full Conversation Transcript

**What:** Every CC session writes a JSONL file with all messages, tool calls, responses, and system events.

**Where:** `~/.claude/projects/<encoded-path>/<uuid>.jsonl`

Path encoding: `/Users/me/myapp` → `-Users-me-myapp`

**Tells you:** Everything the deck said, every tool it called, every file it read/wrote, errors, turn durations — the complete audit trail.

**How to find it:**
```bash
# If the deck record has jsonlPath (archive or decks.json)
grep '"name":"my-deck"' .booth/decks-archive.jsonl | jq -r '.jsonlPath'

# If you only know the project directory, list all sessions
ls -lt ~/.claude/projects/-Users-me-myapp/*.jsonl

# Search inside a session for specific content
grep '"tool_use"' /path/to/session.jsonl | head -20
```

**Tips:**
- JSONL files can be large (10MB+). Use `tail -100` or `grep` rather than reading whole files.
- `type=user` lines with `tool_result` show tool outputs (file contents, command results).
- `type=assistant` lines with `tool_use` show what the deck decided to do.
- `type=system, subtype=turn_duration` marks the end of each turn.
- Files persist across `claude --resume` — one file per session, even if resumed.

---

### 4. tmux Sessions — Running Processes

**What:** Live tmux sessions on the Booth socket.

**Where:** tmux server with socket name `booth-<basename>-<hash8>`.

**Tells you:** Which decks are currently alive (but not what they did in the past).

**Query:**
```bash
# List all sessions on the booth socket
tmux -L $BOOTH_SOCKET list-sessions

# If you don't know the socket name, find booth sockets
ls /tmp/tmux-$(id -u)/booth-*

# Capture current screen of a deck
tmux -L $BOOTH_SOCKET capture-pane -t <deck-name> -p -S -50
```

**Limitation:** Only shows running sessions. Once killed, gone. Cross-reference with `decks.json` to reconcile (in file + in tmux = alive; in file + not in tmux = crashed).

---

### 5. `.booth/reports/` — Deck Output Artifacts

**What:** Structured reports saved by DJ before killing research/chat decks.

**Where:** `.booth/reports/<deck-name>.md`

**Tells you:** The key findings, recommendations, and output of research decks. Code decks leave artifacts in git instead.

**Query:**
```bash
ls -lt .booth/reports/
cat .booth/reports/<deck-name>.md
```

**Limitation:** Only exists for research/chat decks where DJ explicitly saved output. Exec decks leave their trace in git commits instead.

---

### 6. `.booth/plans/` — Plan Artifacts

**What:** Plans produced by plan-first workflow decks.

**Where:** `.booth/plans/<deck-name>.md`

**Tells you:** The design/approach a deck researched and proposed before implementation.

---

### 7. Git History — Code Deck Output

**What:** Commits made by exec decks.

**Tells you:** What code changes a deck actually produced.

**Query:**
```bash
# Commits from a specific time range (when the deck was active)
git log --after="2026-02-27T10:30:00" --before="2026-02-27T12:00:00" --oneline

# If the deck worked on a worktree branch
git log feat/<branch-name> --oneline
```

---

## Forensics Workflow

**"What did deck X do?"**
1. Search `decks-archive.jsonl` for the deck name → get `jsonlPath`, `created`, `dir`
2. Read the JSONL file (or tail the last 200 lines) for the full conversation
3. Check `.booth/reports/<name>.md` for saved output
4. Check git log in the deck's `dir` around the `created` timestamp

**"Which deck touched file Y?"**
1. `git log --all -- path/to/file` → find the commit
2. Match commit timestamp against `decks-archive.jsonl` entries
3. Or grep JSONL files for the filename: `grep "path/to/file" ~/.claude/projects/<encoded>/*.jsonl`

**"Why did deck X crash?"**
1. Get `jsonlPath` from archive → `tail -50 <jsonlPath>` → look for `api_error` or `stop_reason`
2. Check `status` field — `crashed` means tmux session died while `decks.json` still had it as active

**"What decks have ever run in this project?"**
```bash
cat .booth/decks-archive.jsonl | jq -r '[.name, .status, .created] | @tsv' | sort -k3
```

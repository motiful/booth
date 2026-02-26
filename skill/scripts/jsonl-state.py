#!/usr/bin/env python3
"""
jsonl-state.py — Shared JSONL state detection for Booth.

Two modes:
  python3 jsonl-state.py oneshot     Read last N JSONL lines from stdin → print state
  python3 jsonl-state.py watchdog    Full watchdog: manage tail -f watchers, alert DJ

CC JSONL event types:
  user          → user text or tool_result (CC will process → working)
  assistant     → thinking / tool_use / text (CC responding → working)
  progress      → bash_progress / hook_progress (tool executing → working)
  system        → turn_duration (turn complete → idle), api_error (→ error)

State detection relies on the LAST meaningful event + file freshness.
"""

import json
import os
import sys
import time
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Shared parsing logic
# ---------------------------------------------------------------------------

def parse_event_state(line):
    """Parse a single JSONL line and return detected state or None.

    Returns: 'working' | 'idle' | 'error' | 'needs-attention' | None
    None means the event is not state-relevant (e.g., file-history-snapshot).
    """
    try:
        ev = json.loads(line)
    except (json.JSONDecodeError, TypeError):
        return None

    t = ev.get("type")

    if t == "system":
        sub = ev.get("subtype", "")
        if sub == "turn_duration":
            return "idle"
        if sub == "stop_hook_summary":
            # CC 2.1.59+: stop hooks run after turn completes. If the hook
            # didn't prevent continuation, the turn is done → idle.
            if not ev.get("preventedContinuation", False):
                return "idle"
            return None
        if sub == "api_error":
            return "error"
        return None

    if t == "assistant":
        msg = ev.get("message", {})
        content = msg.get("content", [])
        stop_reason = msg.get("stop_reason")
        # Check for [NEEDS ATTENTION] in text
        for c in content:
            if isinstance(c, dict) and c.get("type") == "text":
                if "[NEEDS ATTENTION]" in c.get("text", ""):
                    return "needs-attention"
        ctypes = {c.get("type") for c in content if isinstance(c, dict)}
        if "tool_use" in ctypes:
            return "working"
        if "thinking" in ctypes:
            return "working"
        if "text" in ctypes:
            # end_turn = model finished responding, turn is complete
            if stop_reason == "end_turn":
                return "idle"
            # Other stop reasons or streaming (None) — wait for system event
            return None
        return None

    if t == "user":
        return "working"

    if t == "progress":
        return "working"

    # file-history-snapshot, etc. — not state-relevant
    return None


def detect_state_from_lines(lines):
    """Determine current state from the last N JSONL lines.

    Used by oneshot mode and initial state detection in watchdog.
    Returns: 'working' | 'idle' | 'error' | 'needs-attention' | 'unknown'
    """
    state = "unknown"
    last_ts = None

    for line in lines:
        line = line.strip()
        if not line:
            continue
        new_state = parse_event_state(line)
        if new_state:
            state = new_state
        # Track timestamp for staleness
        try:
            ev = json.loads(line)
            ts = ev.get("timestamp")
            if ts:
                last_ts = ts
        except (json.JSONDecodeError, TypeError):
            pass

    return state


def encode_project_path(abs_path):
    """Encode absolute path to CC project directory name.

    /Users/foo/bar/.baz → -Users-foo-bar--baz
    """
    return abs_path.replace("/", "-").replace(".", "-")


def find_jsonl_for_dir(deck_dir):
    """Find the newest JSONL file for a working directory."""
    encoded = encode_project_path(deck_dir)
    project_dir = os.path.expanduser(f"~/.claude/projects/{encoded}")
    if not os.path.isdir(project_dir):
        return None
    jsonls = []
    for f in os.listdir(project_dir):
        fp = os.path.join(project_dir, f)
        if f.endswith(".jsonl") and os.path.isfile(fp):
            jsonls.append(fp)
    if not jsonls:
        return None
    jsonls.sort(key=lambda fp: os.path.getmtime(fp), reverse=True)
    return jsonls[0]


# ---------------------------------------------------------------------------
# Oneshot mode
# ---------------------------------------------------------------------------

def run_oneshot():
    """Read JSONL lines from stdin, print state, exit."""
    lines = sys.stdin.read().strip().split("\n")
    state = detect_state_from_lines(lines)
    print(state)


# ---------------------------------------------------------------------------
# Watchdog mode
# ---------------------------------------------------------------------------

def run_watchdog():
    """Full watchdog: monitor decks via JSONL tail -f, alert DJ on transitions."""
    import fcntl
    import selectors
    import signal
    import subprocess

    socket = os.environ.get("BOOTH_SOCKET", "booth")
    dj_session = os.environ.get("BOOTH_DJ", "dj")

    def log(msg):
        print(f"[watchdog {time.strftime('%H:%M:%S')}] {msg}", flush=True)

    def tmux_has_session(name):
        r = subprocess.run(
            ["tmux", "-L", socket, "has-session", "-t", name],
            capture_output=True,
        )
        return r.returncode == 0

    def write_alert(deck_name, alert_type, message):
        """Write alert to .booth/alerts.json (Layer 2)."""
        alerts_file = os.path.join(".booth", "alerts.json")
        os.makedirs(".booth", exist_ok=True)
        alert = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "deck": deck_name,
            "type": alert_type,
            "message": message,
        }
        # Read existing alerts, append, write back
        alerts = []
        try:
            with open(alerts_file) as f:
                alerts = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        alerts.append(alert)
        tmp = alerts_file + ".tmp"
        with open(tmp, "w") as f:
            json.dump(alerts, f, indent=2)
            f.write("\n")
        os.replace(tmp, alerts_file)
        log(f"Alert written: {alert_type} {deck_name}")

    def display_urgent(message):
        """tmux display-message for critical errors (Layer 4)."""
        subprocess.run(
            ["tmux", "-L", socket, "display-message", "-d", "5000", message],
            capture_output=True,
        )

    def get_active_decks():
        """Read decks.json → list of (name, dir) for active decks."""
        decks_json = ".booth/decks.json"
        if not os.path.isfile(decks_json):
            return []
        try:
            with open(decks_json) as f:
                data = json.load(f)
            return [
                (d["name"], d["dir"])
                for d in data.get("decks", [])
                if d.get("status") not in ("completed", "crashed", "detached")
            ]
        except Exception:
            return []

    # --- Watcher management ---
    sel = selectors.DefaultSelector()
    watchers = {}  # deck_name → {proc, state, last_event, jsonl, buf}

    def start_watcher(deck_name, jsonl_path):
        proc = subprocess.Popen(
            ["tail", "-f", "-n", "50", jsonl_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        # Set stdout to non-blocking for readline
        fd = proc.stdout.fileno()
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

        sel.register(proc.stdout, selectors.EVENT_READ, data=deck_name)
        watchers[deck_name] = {
            "proc": proc,
            "state": "unknown",
            "last_event": time.time(),
            "jsonl": jsonl_path,
            "buf": b"",
        }
        log(f"Watcher started: {deck_name} → {jsonl_path}")

    def stop_watcher(deck_name):
        w = watchers.pop(deck_name, None)
        if w:
            try:
                sel.unregister(w["proc"].stdout)
            except Exception:
                pass
            w["proc"].terminate()
            try:
                w["proc"].wait(timeout=5)
            except Exception:
                w["proc"].kill()
            log(f"Watcher stopped: {deck_name}")

    def process_watcher_data(deck_name):
        """Read available data from watcher, process complete lines."""
        w = watchers.get(deck_name)
        if not w:
            return
        try:
            data = w["proc"].stdout.read(65536)
            if data:
                w["buf"] += data
        except (BlockingIOError, IOError):
            pass

        # Process complete lines
        while b"\n" in w["buf"]:
            line_bytes, w["buf"] = w["buf"].split(b"\n", 1)
            line = line_bytes.decode("utf-8", errors="replace").strip()
            if not line:
                continue

            new_state = parse_event_state(line)
            if new_state and new_state != w["state"]:
                old = w["state"]
                w["state"] = new_state
                w["last_event"] = time.time()
                log(f"{deck_name}: {old} → {new_state}")
                if new_state != "working":
                    write_alert(deck_name, new_state, f"deck {deck_name} {new_state}.")
                    if new_state in ("error", "needs-attention"):
                        display_urgent(f"⚠ Booth: deck {deck_name} {new_state}")
            elif new_state:
                # Same state but fresh event — update timestamp
                w["last_event"] = time.time()

    def check_idle_timeouts():
        """Decks working with no events for 60s → idle."""
        now = time.time()
        for name, w in watchers.items():
            if w["state"] == "working" and (now - w["last_event"]) > 60:
                w["state"] = "idle"
                log(f"{name}: working → idle (60s timeout)")
                write_alert(name, "idle", f"deck {name} idle (60s timeout).")

    # --- Cleanup ---
    def cleanup(signum=None, frame=None):
        log("Shutting down...")
        for name in list(watchers):
            stop_watcher(name)
        sel.close()
        sys.exit(0)

    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

    # --- Preflight ---
    if not tmux_has_session(dj_session):
        log(f"No DJ session '{dj_session}' on socket '{socket}'. Exiting.")
        sys.exit(0)

    log(f"Started. socket={socket} dj={dj_session} cwd={os.getcwd()}")

    # --- Main loop ---
    MGMT_INTERVAL = 10  # seconds between management checks
    last_mgmt = 0

    while True:
        now = time.time()

        # Management tasks (periodically)
        if now - last_mgmt >= MGMT_INTERVAL:
            # Check DJ alive
            if not tmux_has_session(dj_session):
                log("DJ session gone. Exiting.")
                cleanup()

            # Read active decks
            active = get_active_decks()
            active_names = {name for name, _ in active}
            active_dirs = {name: d for name, d in active}

            if not active_names and not watchers:
                log("No active decks. Exiting.")
                cleanup()

            # Start watchers for new decks
            for name, d in active:
                if name not in watchers:
                    jsonl = find_jsonl_for_dir(d)
                    if jsonl:
                        start_watcher(name, jsonl)
                    else:
                        log(f"{name}: JSONL not found yet (dir={d})")

            # Stop watchers for removed decks
            for name in list(watchers):
                if name not in active_names:
                    stop_watcher(name)

            # Check idle timeouts
            check_idle_timeouts()

            last_mgmt = now

        # Wait for events from any watcher (or timeout for management)
        timeout = max(0.1, MGMT_INTERVAL - (time.time() - last_mgmt))
        try:
            events = sel.select(timeout=timeout)
        except (OSError, ValueError):
            # Selector closed or no FDs registered
            if not watchers:
                time.sleep(MGMT_INTERVAL)
                continue
            break

        for key, mask in events:
            deck_name = key.data
            process_watcher_data(deck_name)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: jsonl-state.py oneshot | watchdog", file=sys.stderr)
        sys.exit(1)

    mode = sys.argv[1]
    if mode == "oneshot":
        run_oneshot()
    elif mode == "watchdog":
        run_watchdog()
    else:
        print(f"Unknown mode: {mode}", file=sys.stderr)
        sys.exit(1)

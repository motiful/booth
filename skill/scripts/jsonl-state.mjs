#!/usr/bin/env node
/**
 * jsonl-state.mjs — Shared JSONL state detection for Booth.
 *
 * Two modes:
 *   node jsonl-state.mjs oneshot     Read last N JSONL lines from stdin → print state
 *   node jsonl-state.mjs watchdog    Full watchdog: manage tail -f watchers, write alerts
 *
 * CC JSONL event types:
 *   user          → user text or tool_result (CC will process → working)
 *   assistant     → thinking / tool_use / text (CC responding → working)
 *   progress      → bash_progress / hook_progress (tool executing → working)
 *   system        → turn_duration (turn complete → idle), api_error (→ error)
 *
 * State detection relies on the LAST meaningful event + file freshness.
 * Zero npm dependencies — uses only Node.js built-ins.
 */

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, renameSync, watch } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { sendMessage, isInputEmpty } from './input-box-check.mjs';

// ---------------------------------------------------------------------------
// Shared parsing logic
// ---------------------------------------------------------------------------

/**
 * Parse a single JSONL line and return detected state or null.
 * @returns {'working' | 'idle' | 'error' | 'needs-attention' | null}
 */
function parseEventState(line) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }

  const t = ev.type;

  if (t === 'system') {
    const sub = ev.subtype ?? '';
    if (sub === 'turn_duration') return 'idle';
    if (sub === 'stop_hook_summary') {
      // CC 2.1.59+: stop hooks run after turn completes. If the hook
      // didn't prevent continuation, the turn is done → idle.
      if (!ev.preventedContinuation) return 'idle';
      return null;
    }
    if (sub === 'api_error') return 'error';
    return null;
  }

  if (t === 'assistant') {
    const msg = ev.message ?? {};
    const content = msg.content ?? [];
    const stopReason = msg.stop_reason;

    // Check for [NEEDS ATTENTION] in text
    for (const c of content) {
      if (c && typeof c === 'object' && c.type === 'text') {
        if ((c.text ?? '').includes('[NEEDS ATTENTION]')) {
          return 'needs-attention';
        }
      }
    }

    const ctypes = new Set(
      content.filter(c => c && typeof c === 'object').map(c => c.type)
    );
    if (ctypes.has('tool_use')) return 'working';
    if (ctypes.has('thinking')) return 'working';
    if (ctypes.has('text')) {
      // end_turn = model finished responding, turn is complete
      if (stopReason === 'end_turn') return 'idle';
      // Other stop reasons or streaming (null) — wait for system event
      return null;
    }
    return null;
  }

  if (t === 'user') return 'working';
  if (t === 'progress') return 'working';

  // file-history-snapshot, etc. — not state-relevant
  return null;
}

/**
 * Determine current state from the last N JSONL lines.
 * @returns {'working' | 'idle' | 'error' | 'needs-attention' | 'unknown'}
 */
function detectStateFromLines(lines) {
  let state = 'unknown';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const newState = parseEventState(line);
    if (newState) state = newState;
  }
  return state;
}

/**
 * Encode absolute path to CC project directory name.
 * /Users/foo/bar/.baz → -Users-foo-bar--baz
 */
function encodeProjectPath(absPath) {
  return absPath.replaceAll('/', '-').replaceAll('.', '-');
}

/**
 * Find the newest JSONL file for a working directory.
 */
function findJsonlForDir(deckDir) {
  const encoded = encodeProjectPath(deckDir);
  const projectDir = join(homedir(), '.claude', 'projects', encoded);
  if (!existsSync(projectDir)) return null;

  const jsonls = [];
  for (const f of readdirSync(projectDir)) {
    if (!f.endsWith('.jsonl')) continue;
    const fp = join(projectDir, f);
    try {
      const st = statSync(fp);
      if (st.isFile()) jsonls.push({ path: fp, mtime: st.mtimeMs });
    } catch { /* skip */ }
  }
  if (jsonls.length === 0) return null;
  jsonls.sort((a, b) => b.mtime - a.mtime);
  return jsonls[0].path;
}

// ---------------------------------------------------------------------------
// Alert helpers (shared by watchdog and write-alert utility)
// ---------------------------------------------------------------------------

function writeAlert(alertsFile, deckName, alertType, message) {
  const dir = resolve(alertsFile, '..');
  mkdirSync(dir, { recursive: true });
  const alert = {
    timestamp: new Date().toISOString(),
    deck: deckName,
    type: alertType,
    message,
  };
  let alerts = [];
  try {
    alerts = JSON.parse(readFileSync(alertsFile, 'utf-8'));
  } catch { /* empty or missing */ }
  alerts.push(alert);
  const tmp = alertsFile + `.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(alerts, null, 2) + '\n');
  renameSync(tmp, alertsFile);
}

// ---------------------------------------------------------------------------
// Oneshot mode
// ---------------------------------------------------------------------------

function runOneshot() {
  let data = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', chunk => { data += chunk; });
  process.stdin.on('end', () => {
    const lines = data.trim().split('\n');
    const state = detectStateFromLines(lines);
    process.stdout.write(state + '\n');
  });
}

// ---------------------------------------------------------------------------
// Watchdog mode
// ---------------------------------------------------------------------------

function runWatchdog() {
  const socket = process.env.BOOTH_SOCKET ?? 'booth';
  const djSession = process.env.BOOTH_DJ ?? 'dj';
  const alertsFile = '.booth/alerts.json';

  function log(msg) {
    const ts = new Date().toTimeString().slice(0, 8);
    process.stdout.write(`[watchdog ${ts}] ${msg}\n`);
  }

  function tmuxHasSession(name) {
    try {
      execFileSync('tmux', ['-L', socket, 'has-session', '-t', name], {
        stdio: 'pipe', timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  function doWriteAlert(deckName, alertType, message) {
    try {
      writeAlert(alertsFile, deckName, alertType, message);
      log(`Alert written: ${alertType} ${deckName}`);
    } catch (e) {
      log(`Alert write failed: ${e.message}`);
    }
  }

  /**
   * Update a deck's status field in decks.json atomically.
   * Read → find deck → update status → write tmp → rename.
   */
  function updateDeckStatus(deckName, newStatus) {
    const decksFile = '.booth/decks.json';
    try {
      const data = JSON.parse(readFileSync(decksFile, 'utf-8'));
      const deck = (data.decks ?? []).find(d => d.name === deckName);
      if (!deck) return;
      if (deck.status === newStatus) return; // no-op
      deck.status = newStatus;
      const tmp = decksFile + `.tmp.${process.pid}`;
      writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
      renameSync(tmp, decksFile);
      log(`${deckName}: decks.json status → ${newStatus}`);
    } catch (e) {
      log(`${deckName}: decks.json update failed: ${e.message}`);
    }
  }

  function displayUrgent(message) {
    try {
      execFileSync('tmux', ['-L', socket, 'display-message', '-d', '5000', message], {
        stdio: 'pipe', timeout: 5000,
      });
    } catch { /* tmux may not be available */ }
  }

  // --- DJ pane ID (stable target for send-keys) ---
  let djPaneId = null;
  function resolveDjPaneId() {
    try {
      // list-panes returns one line per pane; take the FIRST (DJ's original pane)
      // When a deck is joined, DJ session has multiple panes — we always want DJ's own
      const output = execFileSync('tmux', [
        '-L', socket, 'list-panes', '-t', djSession, '-F', '#{pane_id}',
      ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000, encoding: 'utf-8' }).trim();
      djPaneId = output.split('\n')[0];
      log(`DJ pane ID: ${djPaneId}`);
    } catch {
      log('DJ pane ID: could not resolve, will use session name as fallback');
    }
  }
  resolveDjPaneId();

  // --- DJ state tracking via JSONL (DJ = "deck zero") ---
  let djState = 'unknown';
  let djWatcherHandle = null;  // { proc, rl }
  let djJsonlPath = null;      // current JSONL path for DJ watcher

  /**
   * Start a JSONL watcher for DJ's own CC session.
   * DJ is treated like any other deck — JSONL events drive state detection.
   * The watchdog's cwd IS DJ's working directory (set by on-session-event.sh).
   */
  function startDjWatcher() {
    if (djWatcherHandle) return;  // already running

    // Get DJ's actual CWD from tmux (not process.cwd(), which is where watchdog started)
    let djCwd;
    try {
      djCwd = execFileSync('tmux', ['-L', socket, 'display-message', '-t', djSession, '-p', '#{pane_current_path}'], {
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000, encoding: 'utf-8',
      }).trim();
    } catch {
      djCwd = process.cwd();
    }
    const jsonl = findJsonlForDir(djCwd);
    if (!jsonl) {
      log(`DJ: JSONL not found yet (cwd=${djCwd})`);
      return;
    }

    const proc = spawn('tail', ['-f', '-n', '50', jsonl], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const rl = createInterface({ input: proc.stdout });

    let catchingUp = true;
    let catchupTimer = setTimeout(() => {
      catchingUp = false;
      log(`DJ: catchup done, state=${djState}`);
    }, 500);

    rl.on('line', (line) => {
      line = line.trim();
      if (!line) return;

      if (catchingUp) {
        clearTimeout(catchupTimer);
        catchupTimer = setTimeout(() => {
          catchingUp = false;
          log(`DJ: catchup done, state=${djState}`);
        }, 500);
      }

      const newState = parseEventState(line);
      if (newState && newState !== djState) {
        const old = djState;
        djState = newState;
        log(`DJ: ${old} → ${newState}`);
      } else if (newState) {
        // Same state, refresh timestamp
        djState = newState;
      }
    });

    proc.on('exit', () => {
      log('DJ watcher process exited');
      djWatcherHandle = null;
    });

    djWatcherHandle = { proc, rl };
    djJsonlPath = jsonl;
    log(`DJ watcher started → ${jsonl}`);
  }

  function stopDjWatcher() {
    if (!djWatcherHandle) return;
    djWatcherHandle.rl.close();
    djWatcherHandle.proc.kill('SIGTERM');
    djWatcherHandle = null;
    log('DJ watcher stopped');
  }

  // --- DJ send-keys notification ---
  /** @type {Map<string, NodeJS.Timeout>} deckName → idle debounce timer */
  const idleTimers = new Map();

  // --- Wake DJ (send-keys wake signal, 30s global cooldown) ---
  let lastWakeTime = 0;
  const WAKE_COOLDOWN = 30_000;

  function wakeDj() {
    if (djState !== 'idle' && djState !== 'unknown') {
      log(`DJ busy (${djState}), skip wake — stop hook will consume`);
      return;
    }
    if (Date.now() - lastWakeTime < WAKE_COOLDOWN) {
      log('Wake cooldown active, skip');
      return;
    }
    const target = djPaneId || djSession;
    try {
      const result = sendMessage(socket, target, '[booth-wake]');
      if (result.ok) {
        lastWakeTime = Date.now();
        log(`DJ woken (${target})`);
      } else {
        log(`DJ wake skipped: ${result.skipped || result.error}`);
      }
    } catch (e) {
      log(`DJ wake failed: ${e.message}`);
    }
  }

  function getActiveDecks() {
    const decksJson = '.booth/decks.json';
    try {
      const data = JSON.parse(readFileSync(decksJson, 'utf-8'));
      return (data.decks ?? [])
        .filter(d => !['completed', 'crashed', 'detached'].includes(d.status))
        .map(d => ({ name: d.name, dir: d.dir, jsonlPath: d.jsonlPath ?? null, paneId: d.paneId ?? null }));
    } catch {
      return [];
    }
  }

  // --- Watcher management ---
  /** @type {Map<string, {proc: import('child_process').ChildProcess, rl: import('readline').Interface, state: string, lastEvent: number, jsonl: string}>} */
  const watchers = new Map();

  function startWatcher(deckName, jsonlPath) {
    const proc = spawn('tail', ['-f', '-n', '50', jsonlPath], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const rl = createInterface({ input: proc.stdout });

    // Catchup phase: tail -n 50 replays history almost instantly.
    // During catchup, update state silently (no alerts/notifications).
    // After 500ms of no new lines, mark catchup done.
    let catchingUp = true;
    let catchupTimer = setTimeout(() => {
      catchingUp = false;
      const w = watchers.get(deckName);
      if (w) log(`${deckName}: catchup done, state=${w.state}`);
    }, 500);

    rl.on('line', (line) => {
      line = line.trim();
      if (!line) return;

      const w = watchers.get(deckName);
      if (!w) return;

      // Reset catchup timer on each line (history lines arrive in rapid bursts)
      if (catchingUp) {
        clearTimeout(catchupTimer);
        catchupTimer = setTimeout(() => {
          catchingUp = false;
          log(`${deckName}: catchup done, state=${w.state}`);
        }, 500);
      }

      const newState = parseEventState(line);
      if (newState && newState !== w.state) {
        const old = w.state;
        w.state = newState;
        w.lastEvent = Date.now();
        log(`${deckName}: ${old} → ${newState}`);
        // Clear notifiedState when deck goes back to working
        if (newState === 'working') {
          w.notifiedState = null;
          updateDeckStatus(deckName, 'working');
          if (idleTimers.has(deckName)) {
            clearTimeout(idleTimers.get(deckName));
            idleTimers.delete(deckName);
          }
        }
        // Only alert after catchup, for non-working states, once per state
        if (!catchingUp && newState !== 'working' && w.notifiedState !== newState) {
          if (newState === 'idle') {
            // Debounce idle: wait 10s. CC produces idle between turns briefly.
            const timer = setTimeout(() => {
              idleTimers.delete(deckName);
              const w3 = watchers.get(deckName);
              if (w3 && w3.state === 'idle' && w3.notifiedState !== 'idle') {
                w3.notifiedState = 'idle';
                updateDeckStatus(deckName, 'idle');
                doWriteAlert(deckName, 'idle', `deck ${deckName} idle.`);
                wakeDj();
                log(`${deckName}: idle confirmed (10s debounce)`);
              }
            }, 10_000);
            idleTimers.set(deckName, timer);
          } else {
            // error / needs-attention — immediately, once
            w.notifiedState = newState;
            updateDeckStatus(deckName, newState);
            doWriteAlert(deckName, newState, `deck ${deckName} ${newState}.`);
            wakeDj();
            if (newState === 'error' || newState === 'needs-attention') {
              displayUrgent(`⚠ Booth: deck ${deckName} ${newState}`);
            }
          }
        }
      } else if (newState) {
        // Same state but fresh event — update timestamp
        const w2 = watchers.get(deckName);
        if (w2) w2.lastEvent = Date.now();
      }
    });

    proc.on('exit', () => {
      log(`Watcher process exited: ${deckName}`);
      watchers.delete(deckName);
    });

    watchers.set(deckName, {
      proc,
      rl,
      state: 'unknown',
      lastEvent: Date.now(),
      jsonl: jsonlPath,
      notifiedState: null, // last state DJ was notified about
    });
    log(`Watcher started: ${deckName} → ${jsonlPath}`);
  }

  function stopWatcher(deckName) {
    const w = watchers.get(deckName);
    if (!w) return;
    w.rl.close();
    w.proc.kill('SIGTERM');
    watchers.delete(deckName);
    log(`Watcher stopped: ${deckName}`);
  }

  function checkIdleTimeouts() {
    const now = Date.now();
    for (const [name, w] of watchers) {
      if (w.state === 'working' && (now - w.lastEvent) > 60_000) {
        w.state = 'idle';
        if (w.notifiedState !== 'idle') {
          w.notifiedState = 'idle';
          updateDeckStatus(name, 'idle');
          log(`${name}: working → idle (60s timeout)`);
          doWriteAlert(name, 'idle', `deck ${name} idle (60s timeout).`);
          wakeDj();
        }
      }
    }
  }

  // --- Cleanup ---
  function cleanup() {
    log('Shutting down...');
    if (decksWatcher) {
      decksWatcher.close();
      decksWatcher = null;
    }
    if (healthInterval) clearInterval(healthInterval);
    stopDjWatcher();
    for (const name of [...watchers.keys()]) {
      stopWatcher(name);
    }
    process.exit(0);
  }

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  // --- Preflight ---
  if (!tmuxHasSession(djSession)) {
    log(`No DJ session '${djSession}' on socket '${socket}'. Exiting.`);
    process.exit(0);
  }

  // --- Self-restart on code change ---
  const SELF_RESTART_CODE = 42;
  const scriptPath = new URL(import.meta.url).pathname;
  const processStartTime = Date.now();

  function checkCodeUpdated() {
    try {
      const st = statSync(scriptPath);
      if (st.mtimeMs > processStartTime) {
        log(`Code updated (${scriptPath}), self-restarting (exit ${SELF_RESTART_CODE})`);
        process.exit(SELF_RESTART_CODE);
      }
    } catch { /* ignore stat errors */ }
  }

  log(`Started. socket=${socket} dj=${djSession} cwd=${process.cwd()}`);

  // --- Sync watchers with decks.json ---
  function syncWatchers() {
    const active = getActiveDecks();
    const activeNames = new Set(active.map(d => d.name));

    // Start or refresh watchers for active decks
    for (const { name, dir, jsonlPath } of active) {
      // Only use the per-deck jsonlPath from decks.json (set by spawn-child.sh).
      // NEVER fall back to findJsonlForDir() — all decks share the same working
      // directory, so findJsonlForDir returns the newest JSONL (usually DJ's),
      // causing all watchers to monitor the wrong session.
      let jsonl = null;
      if (jsonlPath && existsSync(jsonlPath)) {
        jsonl = jsonlPath;
      } else if (!jsonlPath) {
        // spawn-child.sh background detector hasn't written jsonlPath yet.
        // Stop any stale watcher that was previously started on the wrong file.
        if (watchers.has(name)) {
          log(`${name}: stopping watcher (no confirmed jsonlPath)`);
          stopWatcher(name);
        }
        continue;
      } else {
        // jsonlPath was stored but file no longer exists (CC restarted?)
        log(`${name}: stored jsonlPath gone (${jsonlPath})`);
        continue;
      }
      const existing = watchers.get(name);
      if (existing && existing.jsonl === jsonl) {
        // Already watching the correct file
        continue;
      }
      if (existing) {
        // JSONL file changed (new CC session) — restart watcher
        log(`${name}: JSONL changed, restarting watcher`);
        stopWatcher(name);
      }
      startWatcher(name, jsonl);
    }

    // Stop watchers for removed/completed decks
    for (const name of [...watchers.keys()]) {
      if (!activeNames.has(name)) {
        stopWatcher(name);
      }
    }

    // Exit if nothing to watch
    if (activeNames.size === 0 && watchers.size === 0) {
      log('No active decks. Exiting.');
      cleanup();
    }
  }

  // --- Watch decks.json for changes (event-driven via tmux hooks) ---
  let decksWatcher = null;
  let syncDebounce = null;
  const DECKS_FILE = '.booth/decks.json';

  function startDecksWatch() {
    if (!existsSync(DECKS_FILE)) return;
    try {
      decksWatcher = watch(DECKS_FILE, () => {
        // Debounce: multiple rapid writes → single sync
        if (syncDebounce) clearTimeout(syncDebounce);
        syncDebounce = setTimeout(() => {
          log('decks.json changed — syncing watchers');
          syncWatchers();
        }, 500);
      });
      decksWatcher.on('error', () => {
        // File might be replaced atomically — restart watch
        log('decks.json watcher error — restarting');
        if (decksWatcher) decksWatcher.close();
        decksWatcher = null;
        setTimeout(startDecksWatch, 1000);
      });
    } catch (e) {
      log(`Failed to watch decks.json: ${e.message}`);
    }
  }

  // --- Auto-compact DJ based on real context utilization ---
  const DJ_COMPACT_CONTEXT_FILE = '.booth/dj-context.json';
  const DJ_COMPACT_THRESHOLD_PCT = 80;             // compact when context >= 80%
  const DJ_COMPACT_COOLDOWN = 10 * 60_000;         // 10 minutes
  let lastCompactTime = 0;

  function checkDjCompact() {
    if (djState !== 'idle') return;
    if (Date.now() - lastCompactTime < DJ_COMPACT_COOLDOWN) return;
    try {
      const raw = readFileSync(DJ_COMPACT_CONTEXT_FILE, 'utf-8');
      const ctx = JSON.parse(raw);
      const pct = ctx.used_percentage ?? 0;
      if (pct < DJ_COMPACT_THRESHOLD_PCT) return;
      const target = djPaneId || djSession;
      const result = sendMessage(socket, target, '/compact');
      if (result.ok) {
        lastCompactTime = Date.now();
        log(`DJ auto-compact sent (context ${pct}% >= ${DJ_COMPACT_THRESHOLD_PCT}% threshold)`);
      } else {
        log(`DJ auto-compact skipped: ${result.skipped || result.error}`);
      }
    } catch (e) {
      // dj-context.json missing = statusline not yet configured or CC hasn't responded yet
      if (e.code !== 'ENOENT') {
        log(`DJ auto-compact check failed: ${e.message}`);
      }
    }
  }

  // --- Health check (30s interval — lightweight fallback) ---
  let healthInterval = setInterval(() => {
    // Check if our code was updated — restart to pick up changes
    checkCodeUpdated();
    // Check DJ alive
    if (!tmuxHasSession(djSession)) {
      log('DJ session gone. Exiting.');
      cleanup();
    }
    // Check idle timeouts
    checkIdleTimeouts();
    // Auto-compact DJ if JSONL is large and DJ is idle
    checkDjCompact();
    // Ensure DJ watcher is alive (JSONL might not exist at startup)
    if (!djWatcherHandle) startDjWatcher();
    // Ensure decks watcher is alive
    if (!decksWatcher) startDecksWatch();
    // Fallback sync in case fs.watch missed something
    syncWatchers();
  }, 30_000);

  // Initial sync + start watching
  startDjWatcher();
  syncWatchers();
  startDecksWatch();
}

// ---------------------------------------------------------------------------
// write-alert utility mode (for shell scripts)
// ---------------------------------------------------------------------------

function runWriteAlert() {
  // Usage: node jsonl-state.mjs write-alert <alerts-file> <deck> <type> <message>
  const [alertsFile, deck, type, ...msgParts] = process.argv.slice(3);
  if (!alertsFile || !deck || !type) {
    process.stderr.write('Usage: jsonl-state.mjs write-alert <file> <deck> <type> <message>\n');
    process.exit(1);
  }
  writeAlert(alertsFile, deck, type, msgParts.join(' '));
}

// ---------------------------------------------------------------------------
// read-alerts utility mode (for stop hook)
// ---------------------------------------------------------------------------

function runReadAlerts() {
  // Usage: node jsonl-state.mjs read-alerts <alerts-file>
  // Reads alerts, outputs formatted lines, clears the file.
  const alertsFile = process.argv[3];
  if (!alertsFile) {
    process.stderr.write('Usage: jsonl-state.mjs read-alerts <file>\n');
    process.exit(1);
  }
  let alerts;
  try {
    alerts = JSON.parse(readFileSync(alertsFile, 'utf-8'));
  } catch {
    process.exit(0);
  }
  if (!alerts || alerts.length === 0) process.exit(0);

  // Clear the file atomically (use process-unique tmp to avoid race with writeAlert)
  const tmp = alertsFile + `.tmp.${process.pid}`;
  writeFileSync(tmp, '[]\n');
  renameSync(tmp, alertsFile);

  // Output alerts
  for (const a of alerts) {
    const ts = (a.timestamp ?? '?').slice(0, 19);
    const deck = a.deck ?? '?';
    const atype = a.type ?? '?';
    const msg = a.message ?? '';
    process.stdout.write(`[booth-alert] [${atype}] ${deck}: ${msg} (at ${ts})\n`);
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const mode = process.argv[2];
switch (mode) {
  case 'oneshot':
    runOneshot();
    break;
  case 'watchdog':
    runWatchdog();
    break;
  case 'write-alert':
    runWriteAlert();
    break;
  case 'read-alerts':
    runReadAlerts();
    break;
  default:
    process.stderr.write('Usage: jsonl-state.mjs oneshot | watchdog | write-alert | read-alerts\n');
    process.exit(1);
}

#!/usr/bin/env node
/**
 * input-box-check.mjs — CC input box detection, stash/restore, and unified send.
 *
 * This is the ONLY module that uses capture-pane for pane interaction.
 * Three responsibilities:
 *   1. Detect if CC's input box is empty (no user-typed text)
 *   2. Stash current input, inject a message, then restore
 *   3. Unified sendMessage() — the single path for all text injection
 *
 * Handles both readline (emacs) and vim mode keybindings.
 *
 * CLI mode:
 *   node input-box-check.mjs send --socket booth --pane %12 --message "hello"
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Capture the last N lines of a tmux pane.
 * @param {string} target - pane ID (%N) or session name
 * @returns {string[]}
 */
function capturePaneLines(socket, target, lines = 3) {
  try {
    const output = execFileSync('tmux', [
      '-L', socket, 'capture-pane', '-t', target, '-p', '-S', `-${lines}`,
    ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000, encoding: 'utf-8' });
    return output.split('\n').filter(l => l.length > 0);
  } catch {
    return [];
  }
}

/**
 * Detect vim mode from capture-pane output.
 * CC shows "-- INSERT --" or "-- NORMAL --" at the bottom when vim mode is active.
 * @returns {'insert' | 'normal' | false}
 */
function detectVimMode(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/--\s*INSERT\s*--/.test(lines[i])) return 'insert';
    if (/--\s*NORMAL\s*--/.test(lines[i])) return 'normal';
  }
  return false;
}

/**
 * Extract user-typed text after the prompt character (❯ or >).
 * Skips vim mode indicator lines.
 * @returns {string} Text after prompt, or empty string if no prompt found.
 */
function extractInputText(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Skip vim mode indicator lines
    if (/--\s*(INSERT|NORMAL)\s*--/.test(line)) continue;
    if (/^\s*[>❯]/.test(line)) {
      return line.replace(/^\s*[>❯]\s*/, '');
    }
  }
  return '';
}

/**
 * Check if a CC prompt (❯ or >) is visible in capture-pane output.
 */
function hasPrompt(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (/--\s*(INSERT|NORMAL)\s*--/.test(line)) continue;
    if (/^\s*[>❯]/.test(line)) return true;
  }
  return false;
}

/**
 * Detect if an approval/permission prompt is showing (Allow, Deny, Yes, No).
 */
function hasApprovalPrompt(lines) {
  for (const line of lines) {
    if (/\b(Allow|Deny|Yes,? allow|No,? deny)\b/i.test(line)) return true;
  }
  return false;
}

/**
 * Send tmux keys to a target.
 * @param {string} target - pane ID (%N) or session name
 * @param {boolean} literal - Use -l flag (literal mode, no key interpretation)
 */
function sendKeys(socket, target, keys, literal = false) {
  const args = ['-L', socket, 'send-keys', '-t', target];
  if (literal) args.push('-l');
  args.push(keys);
  execFileSync('tmux', args, { stdio: 'pipe', timeout: 5000 });
}

/**
 * Check if a tmux pane exists.
 */
function paneExists(socket, target) {
  try {
    execFileSync('tmux', ['-L', socket, 'list-panes', '-t', target], {
      stdio: 'pipe', timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect if the pane is in copy-mode and its scroll position.
 * @returns {{ inCopyMode: boolean, scrollPos: number }}
 */
function detectCopyMode(socket, target) {
  try {
    const inMode = execFileSync('tmux', [
      '-L', socket, 'display-message', '-t', target, '-p', '#{pane_in_mode}',
    ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000, encoding: 'utf-8' }).trim();
    const scrollPos = execFileSync('tmux', [
      '-L', socket, 'display-message', '-t', target, '-p', '#{scroll_position}',
    ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000, encoding: 'utf-8' }).trim();
    return {
      inCopyMode: inMode === '1',
      scrollPos: parseInt(scrollPos, 10) || 0,
    };
  } catch {
    return { inCopyMode: false, scrollPos: 0 };
  }
}

/**
 * Synchronous sleep using Atomics (no subprocess spawn).
 */
function sleepSync(ms) {
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

// ---------------------------------------------------------------------------
// Core: unified sendMessage
// ---------------------------------------------------------------------------

/**
 * Send a message to a CC pane with full safety checks and input stash/restore.
 *
 * This is the single path for ALL text injection into tmux panes.
 * Handles: copy-mode exit, approval prompt detection, CC prompt detection,
 * input stash/restore, and optional delivery verification.
 *
 * @param {string} socket - tmux socket name
 * @param {string} target - pane ID (%N) or session name
 * @param {string} message - message to inject
 * @param {object} [options]
 * @param {boolean} [options.verify] - capture-pane after inject to check delivery
 * @param {boolean} [options.restoreCopyMode] - re-enter copy-mode if it was active
 * @returns {{ ok: boolean, error?: string, skipped?: string }}
 */
export function sendMessage(socket, target, message, options = {}) {
  // 1. Check pane exists
  if (!paneExists(socket, target)) {
    return { ok: false, error: 'pane not found' };
  }

  // 2. Detect copy-mode
  const { inCopyMode, scrollPos } = detectCopyMode(socket, target);

  // 3. Exit copy-mode if needed
  if (inCopyMode) {
    sendKeys(socket, target, 'q');
    sleepSync(100);
  }

  // 4. Capture pane and check for blockers
  const lines = capturePaneLines(socket, target, 10);

  // 4a. Detect approval prompt — don't inject while user is being asked Allow/Deny
  if (hasApprovalPrompt(lines)) {
    // Restore copy-mode if we exited it
    if (inCopyMode && options.restoreCopyMode) {
      restoreCopyModeState(socket, target, scrollPos);
    }
    return { ok: false, skipped: 'approval-prompt' };
  }

  // 4b. Detect CC not running — no ❯ or > prompt visible
  if (!hasPrompt(lines)) {
    if (inCopyMode && options.restoreCopyMode) {
      restoreCopyModeState(socket, target, scrollPos);
    }
    return { ok: false, skipped: 'no-cc-prompt' };
  }

  // 5. Capture current input text
  const inputText = extractInputText(lines);
  const vimMode = detectVimMode(lines);

  // 6. Stash if non-empty
  if (inputText.length > 0) {
    // Use Ctrl-C to clear — more reliable for multi-line input than C-u
    sendKeys(socket, target, 'C-c');
    sleepSync(100);
    // After C-c, CC shows a fresh prompt — wait for it to settle
    sleepSync(100);
  }

  // 7. Inject message
  sendKeys(socket, target, message, true);
  sendKeys(socket, target, 'Enter');

  // 8. Verify delivery (optional)
  if (options.verify) {
    sleepSync(300);
    const afterLines = capturePaneLines(socket, target, 10);
    const found = afterLines.some(l => l.includes(message.slice(0, 40)));
    if (!found) {
      return { ok: false, error: 'verification failed — message not found in pane' };
    }
  }

  // 9. Restore stashed text
  if (inputText.length > 0) {
    // Short delay to let Enter register, then send stashed text.
    // tmux buffers keystrokes — they'll appear when CC shows the next prompt.
    sleepSync(200);
    sendKeys(socket, target, inputText, true);
  }

  // 10. Restore copy-mode if requested
  if (inCopyMode && options.restoreCopyMode) {
    sleepSync(200);
    restoreCopyModeState(socket, target, scrollPos);
  }

  return { ok: true };
}

/**
 * Re-enter copy-mode and scroll to the previous position.
 */
function restoreCopyModeState(socket, target, scrollPos) {
  try {
    execFileSync('tmux', ['-L', socket, 'copy-mode', '-t', target], {
      stdio: 'pipe', timeout: 5000,
    });
    if (scrollPos > 0) {
      // Scroll up to the previous position
      for (let i = 0; i < scrollPos; i++) {
        sendKeys(socket, target, 'C-y');
      }
    }
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Backward-compatible exports (used by watchdog / legacy callers)
// ---------------------------------------------------------------------------

/**
 * Check if CC's input box is empty (prompt visible, nothing typed after it).
 * @param {string} socket - tmux socket name
 * @param {string} target - tmux session name or pane ID
 * @returns {boolean} true if prompt found with no user text after it
 */
export function isInputEmpty(socket, target) {
  const lines = capturePaneLines(socket, target, 5);
  if (lines.length === 0) return false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Skip vim mode indicator
    if (/--\s*(INSERT|NORMAL)\s*--/.test(line)) continue;
    if (/^\s*[>❯]/.test(line)) {
      const afterPrompt = line.replace(/^\s*[>❯]\s*/, '');
      return afterPrompt.length === 0;
    }
  }
  // No prompt found — CC might be processing or not started
  return false;
}

/**
 * Stash current input, inject a message, then restore the stashed text.
 * Legacy wrapper around sendMessage() — kept for backward compatibility.
 *
 * @param {string} socket - tmux socket name
 * @param {string} target - tmux session name or pane ID
 * @param {string} message - message to inject (sent as literal text + Enter)
 */
export function stashAndInject(socket, target, message) {
  const lines = capturePaneLines(socket, target, 5);
  const inputText = extractInputText(lines);
  const vimMode = detectVimMode(lines);

  if (inputText.length === 0) {
    // Empty input — just inject directly
    sendKeys(socket, target, message, true);
    sendKeys(socket, target, 'Enter');
    return;
  }

  // --- Stash: clear current input ---
  if (vimMode) {
    // Vim mode: ensure normal mode → clear line → back to insert
    if (vimMode === 'insert') {
      sendKeys(socket, target, 'Escape');
      sleepSync(50);
    }
    // 0 = go to start of line, D = delete to end of line
    sendKeys(socket, target, '0D');
    sleepSync(50);
    // Back to insert mode
    sendKeys(socket, target, 'i');
    sleepSync(50);
  } else {
    // Readline/emacs mode: Ctrl-U kills line backward
    sendKeys(socket, target, 'C-u');
    sleepSync(50);
  }

  // --- Inject message ---
  sendKeys(socket, target, message, true);
  sendKeys(socket, target, 'Enter');

  // --- Restore stashed text ---
  // Short delay to let Enter register, then send stashed text.
  // tmux buffers keystrokes — they'll appear when CC shows the next prompt.
  sleepSync(200);
  sendKeys(socket, target, inputText, true);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function runCli() {
  const args = process.argv.slice(2);
  if (args[0] !== 'send') {
    process.stderr.write('Usage: input-box-check.mjs send --socket <name> --pane <id> --message <text>\n');
    process.exit(1);
  }

  let socket = 'booth';
  let pane = '';
  let message = '';
  let deckName = '';

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--socket': socket = args[++i]; break;
      case '--pane': pane = args[++i]; break;
      case '--message': message = args[++i]; break;
      case '--deck': deckName = args[++i]; break;
      default:
        process.stderr.write(`Unknown option: ${args[i]}\n`);
        process.exit(1);
    }
  }

  // Resolve pane from deck name via decks.json if --pane not provided
  if (!pane && deckName) {
    pane = lookupPaneId(deckName);
    if (!pane) {
      process.stderr.write(`Error: deck '${deckName}' not found or has no paneId in decks.json\n`);
      process.exit(1);
    }
  }

  if (!pane || !message) {
    process.stderr.write('Error: --pane (or --deck) and --message are required\n');
    process.exit(1);
  }

  const result = sendMessage(socket, pane, message);
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.ok ? 0 : 1);
}

/**
 * Look up a deck's pane ID from .booth/decks.json.
 * Searches cwd and parent directories for .booth/.
 */
function lookupPaneId(deckName) {
  // Try cwd first, then walk up
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const decksFile = resolve(dir, '.booth', 'decks.json');
    try {
      const data = JSON.parse(readFileSync(decksFile, 'utf-8'));
      const deck = (data.decks ?? []).find(d => d.name === deckName);
      if (deck?.paneId) return deck.paneId;
      // Found decks.json but no paneId — fall back to session name
      if (deck) return null;
    } catch { /* not here, walk up */ }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Only run CLI when executed directly (not imported as module)
// Detect: argv[1] ends with this filename AND first user arg is 'send'
const isDirectRun = process.argv[1]?.endsWith('input-box-check.mjs');
if (isDirectRun && process.argv[2] === 'send') {
  runCli();
}

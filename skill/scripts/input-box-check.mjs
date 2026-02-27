#!/usr/bin/env node
/**
 * input-box-check.mjs — CC input box detection and stash/restore.
 *
 * This is the ONLY module that uses capture-pane for DJ interaction.
 * Two responsibilities:
 *   1. Detect if CC's input box is empty (no user-typed text)
 *   2. Stash current input, inject a message, then restore
 *
 * Handles both readline (emacs) and vim mode keybindings.
 */

import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Capture the last N lines of a tmux pane.
 * @returns {string[]}
 */
function capturePaneLines(socket, session, lines = 3) {
  try {
    const output = execFileSync('tmux', [
      '-L', socket, 'capture-pane', '-t', session, '-p', '-S', `-${lines}`,
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
 * Send tmux keys to a session.
 * @param {boolean} literal - Use -l flag (literal mode, no key interpretation)
 */
function sendKeys(socket, session, keys, literal = false) {
  const args = ['-L', socket, 'send-keys', '-t', session];
  if (literal) args.push('-l');
  args.push(keys);
  execFileSync('tmux', args, { stdio: 'pipe', timeout: 5000 });
}

/**
 * Synchronous sleep using Atomics (no subprocess spawn).
 */
function sleepSync(ms) {
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Check if CC's input box is empty (prompt visible, nothing typed after it).
 * @param {string} socket - tmux socket name
 * @param {string} session - tmux session name
 * @returns {boolean} true if prompt found with no user text after it
 */
export function isInputEmpty(socket, session) {
  const lines = capturePaneLines(socket, session, 5);
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
 *
 * Flow:
 *   1. Detect mode (vim vs readline/emacs)
 *   2. Capture current input text
 *   3. Clear input (mode-appropriate)
 *   4. Inject message + Enter
 *   5. Restore captured text (buffered by terminal for next prompt)
 *
 * Edge cases:
 *   - Empty input → skip stash/restore, just inject
 *   - User submits while we're restoring → their new message takes priority
 *
 * @param {string} socket - tmux socket name
 * @param {string} session - tmux session name
 * @param {string} message - message to inject (sent as literal text + Enter)
 */
export function stashAndInject(socket, session, message) {
  const lines = capturePaneLines(socket, session, 5);
  const inputText = extractInputText(lines);
  const vimMode = detectVimMode(lines);

  if (inputText.length === 0) {
    // Empty input — just inject directly
    sendKeys(socket, session, message, true);
    sendKeys(socket, session, 'Enter');
    return;
  }

  // --- Stash: clear current input ---
  if (vimMode) {
    // Vim mode: ensure normal mode → clear line → back to insert
    if (vimMode === 'insert') {
      sendKeys(socket, session, 'Escape');
      sleepSync(50);
    }
    // 0 = go to start of line, D = delete to end of line
    sendKeys(socket, session, '0D');
    sleepSync(50);
    // Back to insert mode
    sendKeys(socket, session, 'i');
    sleepSync(50);
  } else {
    // Readline/emacs mode: Ctrl-U kills line backward
    sendKeys(socket, session, 'C-u');
    sleepSync(50);
  }

  // --- Inject message ---
  sendKeys(socket, session, message, true);
  sendKeys(socket, session, 'Enter');

  // --- Restore stashed text ---
  // Short delay to let Enter register, then send stashed text.
  // tmux buffers keystrokes — they'll appear when CC shows the next prompt.
  sleepSync(200);
  sendKeys(socket, session, inputText, true);
}

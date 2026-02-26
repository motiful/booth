# Watch, Takeover, Return & Detach

Four distinct interactions with decks. Don't confuse them.

## Watch — read-only observation

Trigger: `watch <name>` / `show me <name>` / Chinese: `看看 X`, `让我看看 X`, `监工`

User wants to observe a deck in real-time without interrupting it. Deck keeps working.

**Booth opens the view automatically** — no need for the user to run anything.

### Primary: Floating popup (display-popup)

1. Booth opens a centered floating popup showing the deck's output:
   ```bash
   # Centered popup — 85% width, 75% height
   tmux -L $BOOTH_SOCKET display-popup -E -xC -yC -w 85% -h 75% \
     -T " deck: <name> " -b rounded \
     "bash ~/.claude/skills/booth-skill/scripts/booth-peek.sh <name>"
   ```
   The popup auto-refreshes every 2 seconds via `capture-pane`.

2. Tell user:
   ```
   浮窗已打开。q 关闭，k 杀掉，Esc 退出。
   ```

3. Booth **continues polling** this deck as normal — nothing changes on Booth's side

4. Controls inside the popup:
   - `q` / `Esc` — close the popup
   - `k` — kill the deck (with confirmation)
   - `t` — shows takeover instructions

### Smaller popup variant

For a compact corner view:
```bash
tmux -L $BOOTH_SOCKET display-popup -E -w 50% -h 40% \
  -T " deck: <name> " -b rounded \
  "bash ~/.claude/skills/booth-skill/scripts/booth-peek.sh <name>"
```

### Fallback: split-window

If `display-popup` is unavailable (tmux < 3.3) or user prefers split panes:
```bash
tmux -L $BOOTH_SOCKET split-window -h -t dj "tmux -L $BOOTH_SOCKET attach -t <name> -r"
```
User closes with `Ctrl-B x` (kill pane).

**Fallback** — If Booth is NOT running inside tmux (e.g., user started CC directly), fall back to giving the attach command:
   ```
   tmux -L $BOOTH_SOCKET attach -t <name> -r
   ```

## Takeover — user takes direct control

Trigger: `takeover <name>` / `let me talk to <name>` / Chinese: `接管 X`, `我上`

User wants to stop Booth's management and directly interact with the deck as a normal CC session.

1. Check deck's current state via `poll-child.sh`
2. If deck is actively working:
   - Send: "Please finish your current step and pause — the user wants to talk to you directly"
   - Wait for deck to reach a stopping point (poll until idle)
3. If deck is idle or waiting:
   - Send: "The user wants to talk to you directly"
4. Open the deck in a split-pane (interactive, not read-only):
   ```bash
   tmux -L $BOOTH_SOCKET split-window -h -t dj "tmux -L $BOOTH_SOCKET attach -t <name>"
   ```
5. Tell user:
   ```
   Opened <name> in the right pane. You have direct control.
   When done, Ctrl-B D to detach, then tell me "return" or "I'm back".
   ```
6. **Stop polling** deck X — it's now under user's direct control
7. **Update `.booth/decks.json`**: set status to `takeover`

**Fallback** — If not in tmux, give the attach command: `tmux -L $BOOTH_SOCKET attach -t <name>`

## Return — user hands control back to Booth

Trigger: `return` / `I'm back` / Chinese: `我回来了`, `交还 X`

1. Resume polling the takeover'd deck(s)
2. Check current state
3. Report what happened while user was in control
4. Resume normal monitoring
5. **Update `.booth/decks.json`**: restore status from state detection

## Detach — unbind from Booth without killing

Trigger: `detach <name>` / Chinese: `解绑 X`, `放手 X`

User wants to stop Booth's monitoring of a deck, but NOT kill the session. The deck becomes a standalone CC session the user can interact with directly via `tmux -L $BOOTH_SOCKET attach -t <name>` at any time, outside of Booth's oversight.

1. **Stop polling** deck X
2. **Remove from `.booth/decks.json`** (or mark as `detached`)
3. Tell user:
   ```
   Deck `X` has been detached. It's still running:
   tmux -L $BOOTH_SOCKET attach -t X
   Booth is no longer monitoring it. If you want Booth to take it back later, just let me know.
   ```

**Detach ≠ Takeover**: Takeover is temporary (you expect a `return`). Detach is permanent unbinding (Booth forgets about it). The tmux session lives on independently.

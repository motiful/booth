# 看、瞄、Detach

Three interactions with decks. Takeover/return are implicit, not commands.

## 看 (Look) — full-screen switch

Trigger: `看看 X` / `watch X` / `show me X`

User wants to see a deck's full output. Booth switches the tmux client to that deck's session.

**Booth keeps monitoring.** This is NOT takeover — Booth continues monitoring as normal.

1. Booth runs:
   ```bash
   tmux -L $BOOTH_SOCKET switch-client -t <name>
   ```
   Or uses the deck menu (if multiple decks):
   ```bash
   bash ~/.claude/skills/booth-skill/scripts/booth-deck-menu.sh look
   ```

2. Tell user:
   ```
   已切到 <name>。prefix+d 回来。
   ```

3. User reads, scrolls, does whatever they want. When they press `prefix+d`, they're back at DJ.

4. **Implicit return**: When user comes back to DJ, Booth auto-resumes normal operation. No "return" command needed.

**tmux keybinding**: `prefix+w` → deck menu → select by number → full screen switch.

## 瞄 (Glance) — split-pane, DJ stays visible

Trigger: `瞄一眼 X` / `glance X` / `让我瞄一下`

User wants to see a deck while keeping DJ visible. Like a mixer — deck output on the right, DJ on the left.

1. Booth opens a split-pane (read-only):
   ```bash
   tmux -L $BOOTH_SOCKET split-window -h -t $DJ_SESSION -l 50% \
     "tmux -L $BOOTH_SOCKET attach -t <name> -r"
   ```

2. Tell user:
   ```
   右边是 <name>（只读）。prefix+x 关掉右半。
   ```

3. Booth **continues working normally** on the left. The right pane is just a passive view.

4. User closes the right pane with `prefix+x` (kill pane) or tells Booth "关掉".

**tmux keybinding**: `prefix+e` → deck menu → select by number → split-pane opens.

## Implicit Takeover & Return

There are NO explicit takeover/return commands. The logic is:

- **User switches to a deck** (via 看 or prefix+w) → that's "takeover". Booth keeps monitoring.
- **User comes back to DJ** (via prefix+d) → that's "return". Nothing special happens.
- **Deck completes while user is away** → Booth auto-kills it and reports results when user returns.

The old explicit `takeover` / `return` commands are removed. Booth is always monitoring, always managing. The user just looks at things when they want to.

## Detach — unbind from Booth without killing

Trigger: `detach <name>` / `解绑 X`

User wants Booth to stop monitoring a deck, but NOT kill it. The deck becomes standalone.

1. **Stop polling** deck X
2. **Update `.booth/decks.json`**: mark as `detached`
3. Tell user:
   ```
   Deck X 已解绑。它还在跑：
   tmux -L $BOOTH_SOCKET attach -t X
   Booth 不再监控它。
   ```

## Keybinding Summary

| Key | Action |
|-----|--------|
| `prefix+w` | 看 — deck menu → full screen switch |
| `prefix+e` | 瞄 — deck menu → split-pane (DJ stays) |
| `prefix+d` | 回 DJ |
| `prefix+n/p` | 上/下一个 session |
| `prefix+S` | session 树 |

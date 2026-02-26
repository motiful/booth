# tmux Advanced UI Research for Booth DJ

> Research conducted 2026-02-27 | tmux 3.5a on macOS Darwin 24.4.0

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [What's Possible with tmux 3.5](#whats-possible-with-tmux-35)
3. [Click-First Interaction Techniques](#click-first-interaction-techniques)
4. [Comparison of UI Approaches](#comparison-of-ui-approaches)
5. [Plugin Ecosystem Highlights](#plugin-ecosystem-highlights)
6. [Creative Interaction Patterns](#creative-interaction-patterns)
7. [Specific Code Examples for Booth](#specific-code-examples-for-booth)
8. [Recommendations for Booth v2 UI](#recommendations-for-booth-v2-ui)
9. [Sources](#sources)

---

## Executive Summary

tmux 3.5 is a surprisingly capable UI platform. Our current Booth implementation (range tags + right-click menus) already uses the most important primitives, but we're barely scratching the surface. The biggest opportunities are:

1. **Event-driven architecture via hooks** — replace polling with `set-hook` on `session-created`, `session-closed`, `alert-silence`, etc.
2. **display-popup overlays** — fzf-powered deck selectors, popup editors for multi-line prompts, toast notifications
3. **Animated status indicators** — braille spinners / equalizer bars per deck (DJ-themed VU meters)
4. **Custom key tables** — a "DJ Mode" that transforms the keyboard into a deck controller
5. **Control Mode subscriptions** — `refresh-client -B` for zero-polling state monitoring (future)

---

## What's Possible with tmux 3.5

### Feature Availability Matrix

| Feature | Min Version | Our 3.5a | Notes |
|---------|-------------|----------|-------|
| `display-popup` | 3.2 | **Yes** | Floating overlay windows |
| `display-menu` | 3.0 | **Yes** | Native popup menus |
| `display-menu -M` | 3.5 | **Yes** | Force mouse on keyboard-triggered menus |
| Custom key tables | 2.0 | **Yes** | Modal keybinding systems |
| `choose-tree` customization | 1.7 | **Yes** | Filterable, sortable session trees |
| `range=user\|X` tags | 3.4 | **Yes** | Clickable status bar regions |
| `mouse_status_range` | 3.4 | **Yes** | Identify clicked range |
| Format conditionals `#{?}` | 1.8 | **Yes** | Ternary logic in status bar |
| Format math `#{e\|+:}` | 3.2 | **Yes** | Arithmetic in format strings |
| Format loops `#{S:}` `#{W:}` `#{P:}` | 2.6 | **Yes** | Iterate sessions/windows/panes |
| Pattern match `#{m:}` | 3.1 | **Yes** | Glob/regex in formats |
| Pane content search `#{C:}` | 3.1 | **Yes** | Search pane buffer in formats |
| `popup-border-lines` rounded | 3.3 | **Yes** | Styled popup borders |
| `set-hook` arrays | 3.0 | **Yes** | Multiple handlers per event |
| `pipe-pane -I -O` | 2.1 | **Yes** | Bidirectional pane I/O |
| `wait-for` channels | 1.8 | **Yes** | Script synchronization |
| `command-error` hook | 3.5 | **Yes** | React to command failures |
| Multi-line status `status 2-5` | 2.9 | **Yes** | Up to 5 status lines |
| `refresh-client -S` | 2.4 | **Yes** | Force instant status refresh |
| Pane scrollbars | 3.6 | No | Upgrade needed |
| Loop sorting `#{W:}` | 3.6 | No | Upgrade needed |
| Non-blocking popups `-D` | N/A | No | PR #4379 open |

### Key tmux 3.5-Specific Features

**`display-menu -M`** — Forces mouse event handling on menus opened from keyboard shortcuts. Previously, keyboard-triggered menus didn't respond to mouse clicks properly.

```tmux
# Keyboard-triggered menu that ALSO responds to mouse
bind-key m display-menu -M -T "Quick Menu" -x C -y C \
  "New Deck"  n "command-prompt -p 'Name:' '...'" \
  "Kill Deck" x "command-prompt -p 'Kill:' '...'"
```

**`command-error` hook** — Fires when any tmux command fails.

```bash
set-hook -g command-error 'display-message "Command failed!"'
```

**`search_count` / `copy_cursor_hyperlink`** — New format variables for copy mode.

---

## Click-First Interaction Techniques

### Current Booth Implementation

We already use the most powerful click primitive: **user range tags** with the three-layer rendering pattern:

```
Script (#()) → set @variable → #{E:@variable} renders with range tags
User clicks → MouseDown1Status → #{mouse_status_range} → dispatch
```

### Technique 1: Multi-Button Dispatch on Same Element

Different mouse buttons on the same deck name do different things:

```tmux
# Left click: switch to deck
bind -T root MouseDown1Status run-shell '
  R="#{mouse_status_range}"
  case "$R" in ""|left|right|status|window) ;; *)
    tmux -S "#{socket_path}" switch-client -t "$R" 2>/dev/null
  ;; esac'

# Middle click: quick-kill deck (with confirm)
bind -T root MouseDown2Status run-shell '
  R="#{mouse_status_range}"
  case "$R" in ""|left|right|status|window) ;; *)
    tmux -S "#{socket_path}" confirm-before -p "Kill $R? (y/n)" \
      "kill-session -t $R"
  ;; esac'

# Right click: context menu (already implemented)
bind -T root MouseDown3Status run-shell '...'
```

### Technique 2: Double-Click for Glance

```tmux
bind -T root DoubleClick1Status run-shell '
  R="#{mouse_status_range}"
  case "$R" in ""|left|right|status|window) ;; *)
    TMUX="" tmux -S "#{socket_path}" display-popup \
      -w 80% -h 75% -E \
      "tmux -S \"#{socket_path}\" attach -t \"$R\" -r"
  ;; esac'
```

### Technique 3: Click StatusLeft for DJ Button (Popup Menu)

```tmux
# Left-click on BOOTH badge → show Booth management menu
bind -T root MouseDown1StatusLeft display-menu -M -O \
  -T "#[align=centre,bold] BOOTH " -x M -y S \
  "New Deck"        n "command-prompt -p 'Deck name:' '...'" \
  "Status"          s "run-shell '...'" \
  ""                  "" "" \
  "Choose Tree"     t "choose-tree -Zs" \
  ""                  "" "" \
  "Compact All"     c "run-shell '...'" \
  "#[fg=red]Shutdown" Q "confirm-before 'kill-server'"
```

### Technique 4: Multi-Line Status Bar

tmux supports up to 5 status lines. A second line could show deck details:

```tmux
set -g status 2

# Line 0: current layout (BOOTH badge + DJ + deck list)
# Line 1: deck detail bar (clickable action buttons)
set -g status-format[1] \
  '#[range=user|btn-new]#[bg=colour238,fg=colour255]  + New  #[norange] '\
  '#[range=user|btn-status]#[bg=colour238,fg=colour255]  Status  #[norange] '\
  '#[range=user|btn-tree]#[bg=colour238,fg=colour255]  Tree  #[norange]'
```

**Downside:** Takes up vertical space. Best reserved for power-user mode.

### Technique 5: Dynamic display-menu from Script

Build menus dynamically from live session list:

```bash
# booth-deck-menu.sh — generates a display-menu with all decks
SOCK="$1"
T="tmux -S $SOCK"

ITEMS=""
IDX=1
while IFS= read -r name; do
  DJ=$($T show -gvq @booth-dj 2>/dev/null || echo "dj")
  [[ "$name" == "$DJ" ]] && continue
  ITEMS+="\"$name\" $IDX \"switch-client -t '$name'\" "
  IDX=$((IDX + 1))
done < <($T list-sessions -F '#{session_name}')

eval "$T display-menu -T 'Switch Deck' -x C -y C $ITEMS"
```

---

## Comparison of UI Approaches

### Status Bar Buttons vs Popups vs Menus vs Floating Panes

| Approach | Pros | Cons | Best For |
|----------|------|------|----------|
| **Status bar range tags** (current) | Always visible, zero-click awareness, responsive | Limited space (~150 chars), 15-byte range limit, no scrolling | Primary deck switching, state indicators |
| **display-menu** (right-click) | Native look, keyboard navigation, dynamic content | Blocks input, no scroll for large lists, disappears on resize | Context actions (3-8 items), confirmations |
| **display-popup** (overlay) | Full shell capabilities, fzf/editor integration, large area | Blocks panes underneath (in 3.5), visually jarring if overused | Complex workflows (editor, fzf picker, logs) |
| **display-popup + fzf** | Fuzzy search, instant filtering, preview | Requires fzf installed, popup is modal/blocking | Deck selection when >5 decks |
| **choose-tree** (built-in) | Native, keyboard-driven, preview pane, filterable | Not mouse-friendly, generic appearance | Power users, bulk operations |
| **Multi-line status** (`status 2`) | More space for buttons/info, always visible | Eats vertical terminal space, complex to maintain | Toolbar-like secondary controls |
| **Custom key tables** (DJ Mode) | Zero mouse needed, fast, visual mode indicator | Learning curve, invisible to new users | Keyboard power users |
| **Floating panes** (tmux-floax) | Persistent, moveable, like a real window | Plugin dependency, tmux 3.3+ only, fragile | Monitoring dashboards |

### Recommendation: Layered Approach

```
Layer 1: Status bar (always visible) → deck list + state indicators + DJ button
Layer 2: Right-click menus (on demand) → context actions per deck
Layer 3: Popup overlays (complex tasks) → fzf deck picker, log viewer, editor
Layer 4: Key tables (power users) → DJ Mode for keyboard-only operation
```

---

## Plugin Ecosystem Highlights

### Most Relevant Plugins for Booth

#### 1. tmux-agent-indicator
**GitHub:** [accessd/tmux-agent-indicator](https://github.com/accessd/tmux-agent-indicator)

Purpose-built for AI agent state tracking. Provides:
- Pane border color per agent state (running/needs-input/done)
- Status bar icon per agent: `#{agent_indicator}`
- **Knight Rider animation** during "running" state
- Custom icons per agent type

```bash
set -g @agent-indicator-animation-enabled 'on'
set -g @agent-indicator-animation-speed '300'
set -g status-right '#{agent_indicator} | %H:%M'
```

**Relevance:** This is essentially Booth's deck state system. Could adopt its visual patterns (animation, border colors) or use it directly.

#### 2. tmux-which-key
**GitHub:** [alexwforsythe/tmux-which-key](https://github.com/alexwforsythe/tmux-which-key)

Spacemacs-style popup with hierarchical key bindings defined in YAML:

```yaml
items:
  - name: +Decks
    key: d
    menu:
      - name: New Deck
        key: n
        command: command-prompt -p 'Name:' '...'
      - name: Kill Deck
        key: k
        command: command-prompt -p 'Kill:' '...'
      - name: Resize
        key: r
        transient: true  # stays open for repeated presses
        command: resize-pane -R 5
```

**Relevance:** Booth could adopt this pattern for a "DJ which-key" popup — press `prefix+Space` to see all available Booth commands.

#### 3. tmux-thumbs / tmux-fingers
**GitHub:** [fcsonline/tmux-thumbs](https://github.com/fcsonline/tmux-thumbs) / [Morantron/tmux-fingers](https://github.com/Morantron/tmux-fingers)

Vimium-style hint labels for quick text selection. Not directly relevant to Booth's UI, but the **overlay technique** (capturing pane content, rendering with annotations) is interesting for future "deck inspector" features.

#### 4. tmux-sessionx
**GitHub:** [omerxx/tmux-sessionx](https://github.com/omerxx/tmux-sessionx)

fzf-powered session manager with preview. Multiple view modes:
- Session list (default)
- Window mode (Ctrl-W)
- Tree mode (Ctrl-T)

```bash
set -g @sessionx-bind 'o'
set -g @sessionx-window-height '85%'
set -g @sessionx-window-width '75%'
set -g @sessionx-preview-location 'right'
```

**Relevance:** Booth could build a similar fzf-powered deck picker that shows deck state, recent output preview, and allows bulk operations.

#### 5. tmux-floax
**GitHub:** [omerxx/tmux-floax](https://github.com/omerxx/tmux-floax)

Persistent floating pane (popup wrapping a session). Toggle with one key, path-tracking, configurable size.

```bash
set -g @floax-bind '-n M-p'
set -g @floax-width '80%'
set -g @floax-height '80%'
set -g @floax-change-path 'true'
```

**Relevance:** Could be used for a "floating deck monitor" — a persistent popup showing all deck outputs in a split view.

#### 6. tmux-tpad
**GitHub:** [Subbeh/tmux-tpad](https://github.com/Subbeh/tmux-tpad)

Multiple named floating windows, each independently configured:

```bash
set -g @tpad-scratchpad-bind "C-p"
set -g @tpad-git-bind "C-g"
set -g @tpad-git-cmd "lazygit"
set -g @tpad-notes-bind "C-n"
set -g @tpad-notes-cmd "nvim ~/notes.md"
```

**Relevance:** The "multiple named floating windows" concept maps directly to Booth's multi-deck model.

#### 7. Catppuccin/tmux Module System
**GitHub:** [catppuccin/tmux](https://github.com/catppuccin/tmux)

Not just a theme — it's a **module framework** for status bar segments:

```bash
# Custom module creation pattern
%hidden MODULE_NAME="my_module"
set -ogq "@catppuccin_${MODULE_NAME}_icon" ""
set -ogqF "@catppuccin_${MODULE_NAME}_color" "#{E:@thm_pink}"
set -ogq "@catppuccin_${MODULE_NAME}_text" "hello"
source "~/.config/tmux/plugins/tmux/utils/status_module.conf"

# Reference in status bar
set -g status-right "#{E:@catppuccin_status_my_module}"
```

**Relevance:** Booth could adopt this module pattern for extensible status bar segments (deck count, active deck, alert count).

---

## Creative Interaction Patterns

### 1. Animated Status Indicators (VU Meters)

The DJ theme calls for audio-visual metaphors. tmux can animate via `#(script)` + `status-interval`:

```bash
#!/bin/bash
# vu-meter.sh — equalizer-style animation for a working deck
FRAMES=("▂" "▃" "▄" "▅" "▆" "▇" "█" "▇" "▆" "▅" "▄" "▃")
IDX=$(( $(date +%s) % ${#FRAMES[@]} ))
echo "${FRAMES[$IDX]}"
```

```bash
#!/bin/bash
# braille-spinner.sh — spinning indicator for active deck
FRAMES="⣾⣽⣻⢿⡿⣟⣯⣷"
IDX=$(( $(date +%s) % ${#FRAMES} ))
echo "${FRAMES:$IDX:1}"
```

In `booth-status.sh`, per deck:
```bash
case "$state" in
  working)          ind="#[fg=colour39]$(bash spinner.sh)" ;;  # animated
  idle)             ind="#[fg=colour34]✓" ;;                   # static
  needs-attention)  ind="#[fg=colour196]⚠" ;;                  # static blink
  waiting-approval) ind="#[fg=colour214]◌" ;;                  # static
esac
```

**Requirement:** `status-interval 1` for smooth animation (tradeoff: more CPU).

### 2. Event-Driven Architecture via Hooks

**This is the single biggest improvement Booth can make.** Replace watchdog polling with tmux hooks:

```bash
# Auto-register new decks
set-hook -g session-created 'run-shell "bash ~/.booth/scripts/on-deck-created.sh"'

# Auto-deregister dead decks
set-hook -g session-closed 'run-shell "bash ~/.booth/scripts/on-deck-closed.sh"'

# Instant status refresh when switching sessions
set-hook -g client-session-changed 'refresh-client -S'

# Detect idle decks via silence monitoring
set-hook -g alert-silence 'run-shell "bash ~/.booth/scripts/on-deck-idle.sh"'

# Detect active decks via activity monitoring
set-hook -g alert-activity 'run-shell "bash ~/.booth/scripts/on-deck-active.sh"'
```

Combined with `monitor-silence` and `monitor-activity` per deck window:
```bash
# In spawn-child.sh, when creating a deck:
tmux setw -t "$name" monitor-silence 60   # idle after 60s silence
tmux setw -t "$name" monitor-activity on  # detect new output
```

**Available hooks relevant to Booth:**

| Hook | Use Case |
|------|----------|
| `session-created` | Auto-register new deck |
| `session-closed` | Auto-deregister dead deck |
| `session-renamed` | Update deck registry |
| `client-session-changed` | Detect DJ switching to/from deck |
| `client-attached` | DJ connects |
| `client-detached` | DJ disconnects |
| `alert-silence` | Deck went idle |
| `alert-activity` | Deck producing output |
| `alert-bell` | Deck explicitly signals (via `\a`) |
| `pane-focus-in` | Deck pane gains focus |
| `command-error` | tmux command failed |
| `client-resized` | Terminal resized (adjust layout) |

### 3. DJ Mode (Custom Key Table)

A dedicated key table where every key is a Booth command:

```tmux
# Enter DJ Mode: prefix + j
bind-key j switch-client -T dj-mode \; \
  display-message "#[fg=yellow,bold] DJ MODE — n:new k:kill g:glance s:status q:quit"

# DJ Mode bindings
bind-key -T dj-mode n command-prompt -p "New deck:" \
  "run-shell 'booth spawn %%'; switch-client -T dj-mode"
bind-key -T dj-mode k command-prompt -p "Kill deck:" \
  "confirm-before -p 'Kill %%?' 'kill-session -t %%'; switch-client -T dj-mode"
bind-key -T dj-mode g command-prompt -p "Glance at:" \
  "display-popup -w 80% -h 75% -E 'tmux attach -t %%'"
bind-key -T dj-mode s run-shell 'booth ps'
bind-key -T dj-mode 1 switch-client -t deck-1
bind-key -T dj-mode 2 switch-client -t deck-2
bind-key -T dj-mode 3 switch-client -t deck-3
bind-key -T dj-mode d switch-client -t dj   # back to DJ
bind-key -T dj-mode q switch-client -T root  # exit DJ mode

# Visual indicator: status bar changes color in DJ mode
# Use in status-left:
#   #{?#{==:#{client_key_table},dj-mode},#[bg=yellow,fg=black],#[bg=colour22,fg=colour255]}
```

### 4. Popup Editor for Multi-Line Prompts

Send complex prompts to decks using a real editor instead of single-line `send-keys`:

```bash
#!/bin/bash
# booth-popup-editor.sh — open editor in popup, send content to deck
SOCK="$1"
DECK="$2"
TMPFILE=$(mktemp /tmp/booth-prompt-XXXXXX.md)

# Open editor in popup
$EDITOR "$TMPFILE"

# If content was written, send to deck
if [[ -s "$TMPFILE" ]]; then
  CONTENT=$(cat "$TMPFILE")
  tmux -S "$SOCK" send-keys -t "$DECK" "$CONTENT" Enter
fi

rm -f "$TMPFILE"
```

```tmux
# Bind to prefix + m (message)
bind-key m command-prompt -p "Send to deck:" \
  "display-popup -w 90% -h 40% -E \
    'bash ~/.booth/scripts/booth-popup-editor.sh #{socket_path} %%'"
```

### 5. fzf-Powered Deck Picker

```bash
#!/bin/bash
# booth-fzf-picker.sh — fuzzy deck selector with preview
SOCK="$1"
T="tmux -S $SOCK"
DJ=$($T show -gvq @booth-dj 2>/dev/null || echo "dj")

DECK=$($T list-sessions -F '#{session_name}' | \
  grep -v "^${DJ}$" | \
  fzf --preview "tmux -S $SOCK capture-pane -t {} -p -S -20" \
      --preview-window=right:60% \
      --header="Select deck (Enter=switch, Ctrl-K=kill)")

[[ -n "$DECK" ]] && $T switch-client -t "$DECK"
```

```tmux
# Bind to prefix + f
bind-key f display-popup -w 80% -h 75% -E \
  "bash ~/.booth/scripts/booth-fzf-picker.sh #{socket_path}"
```

### 6. Toast Notifications via display-message

```bash
# In watchdog or hook scripts, when deck state changes:
tmux -S "$SOCK" display-message -d 3000 \
  "#[fg=colour214]⚠ Deck ${DECK} needs attention"
```

For non-blocking overlays (future, requires non-blocking popup support):
```bash
# PR #4379 pattern (bleeding edge)
tmux display-popup -D -w 40 -h 3 -x R -y S -E \
  "echo '✓ Deck api-refactor: IDLE'; sleep 3"
```

### 7. pipe-pane for Reactive Automation

Bidirectional I/O between Booth and deck panes:

```bash
# In spawn-child.sh: set up output monitoring
tmux -S "$SOCK" pipe-pane -t "$DECK" -O \
  "grep --line-buffered 'NEEDS ATTENTION\|Error\|\\[y/n\\]' >> .booth/alerts/${DECK}.log"
```

### 8. wait-for for Deck Orchestration

```bash
# Sequential deck dispatch
tmux -S "$SOCK" send-keys -t deck-api \
  "npm test && tmux -S '$SOCK' wait-for -S deck-api-done" Enter

tmux -S "$SOCK" wait-for deck-api-done
echo "API tests passed, starting integration tests..."

tmux -S "$SOCK" send-keys -t deck-integration \
  "npm run test:integration" Enter
```

### 9. Control Mode Subscriptions (Advanced)

For future zero-polling monitoring:

```bash
# Start a control mode client that subscribes to deck states
tmux -S "$SOCK" -C attach << 'EOF'
refresh-client -B "deck-api:$1:#{pane_current_command}"
refresh-client -B "deck-front:$2:#{pane_current_command}"
EOF

# Receives notifications when pane commands change:
# %subscription-changed deck-api $1 "claude"
# %subscription-changed deck-api $1 "bash"  ← claude exited
```

---

## Specific Code Examples for Booth

### Example 1: Enhanced booth-status.sh with Animation

```bash
#!/bin/bash
# Animated state indicators for working decks
SPINNER="⣾⣽⣻⢿⡿⣟⣯⣷"
EQUALIZER=("▂" "▃" "▄" "▅" "▆" "▇" "█" "▇" "▆" "▅" "▄" "▃")
SEC=$(date +%s)

get_indicator() {
  local state="$1"
  case "$state" in
    working)
      local idx=$(( SEC % ${#SPINNER} ))
      echo "#[fg=colour39]${SPINNER:$idx:1}"
      ;;
    idle)             echo "#[fg=colour34]✓" ;;
    needs-attention)  echo "#[fg=colour196]⚠" ;;
    waiting-approval) echo "#[fg=colour214]◌" ;;
    *)                echo "#[fg=colour245]…" ;;
  esac
}
```

### Example 2: Enhanced Context Menu

```bash
#!/bin/bash
# booth-context-menu.sh v2 — richer context menu
DECK="$1"
SOCK="$2"
T="tmux -S $SOCK"

# Detect deck state for conditional menu items
STATE=$(bash detect-state.sh < <($T capture-pane -t "$DECK" -p -S -10))

$T display-menu -O -T " ${DECK} " -x M -y S \
  "看 Switch"       s "switch-client -t '${DECK}'" \
  "瞄 Glance"       g "display-popup -w 80% -h 75% -E 'tmux -S \"${SOCK}\" attach -t \"${DECK}\" -r'" \
  ""                  "" "" \
  "Send message"    m "command-prompt -p 'Send to ${DECK}:' \"run-shell 'bash send-to-child.sh \\\"${SOCK}\\\" \\\"${DECK}\\\" \\\"%%\\\"'\"" \
  "Edit & Send"     e "display-popup -w 90% -h 40% -E 'bash popup-editor.sh \"${SOCK}\" \"${DECK}\"'" \
  ""                  "" "" \
  "Capture log"     l "pipe-pane -t '${DECK}' -o 'cat >> ~/booth-logs/${DECK}.log'" \
  ""                  "" "" \
  "#[fg=colour196]Kill" k "confirm-before -p 'Kill deck ${DECK}? (y/n)' 'kill-session -t ${DECK}'"
```

### Example 3: Hooks in booth-start.sh

```bash
# Set up event-driven hooks for the Booth server
$T set-hook -g session-created "run-shell 'bash $SCRIPTS/on-session-event.sh created #{hook_session_name} $SOCK'"
$T set-hook -g session-closed  "run-shell 'bash $SCRIPTS/on-session-event.sh closed #{hook_session_name} $SOCK'"
$T set-hook -g client-session-changed "refresh-client -S"
```

### Example 4: DJ Mode Key Table

```tmux
# In booth.tmux.conf
bind-key j switch-client -T booth-dj

bind-key -T booth-dj n command-prompt -p "New deck:" \
  "run-shell 'booth spawn %%'"
bind-key -T booth-dj k command-prompt -p "Kill:" \
  "confirm-before -p 'Kill %%?' 'kill-session -t %%'"
bind-key -T booth-dj f display-popup -w 80% -h 75% -E \
  "bash booth-fzf-picker.sh #{socket_path}"
bind-key -T booth-dj d switch-client -t "$(tmux show -gvq @booth-dj)"
bind-key -T booth-dj Escape switch-client -T root
bind-key -T booth-dj q switch-client -T root
```

---

## Recommendations for Booth v2 UI

### Priority 1: Event-Driven Status (High Impact, Medium Effort)

**Replace polling with hooks for deck lifecycle events.**

- Add `session-created` / `session-closed` hooks in `booth-start.sh`
- Use `monitor-silence 60` + `alert-silence` hook for idle detection
- Call `refresh-client -S` from hooks for instant status updates
- Keep `#()` status script for state rendering, but reduce `status-interval` to 3-5s since hooks handle the critical events

**Impact:** Faster state detection, lower CPU, more reliable than capture-pane parsing.

### Priority 2: Animated Indicators (High Impact, Low Effort)

**Add braille/equalizer animation for working decks.**

- Use `$(date +%s)` modulo frame count for animation frame selection
- Set `status-interval 1` only when decks are working (use hooks to toggle)
- Equalizer wave `▂▃▄▅▆▇█` fits the DJ theme perfectly

**Impact:** The status bar comes alive. Working decks visually pulse, idle decks are static. At-a-glance dashboard.

### Priority 3: Enhanced Popup Menus (Medium Impact, Low Effort)

**Improve the right-click context menu and add new popup interactions.**

- Add "Edit & Send" option (popup editor for multi-line prompts)
- Add "Capture log" option (pipe-pane to file)
- Add click on BOOTH badge → management menu
- Use `-O` flag on display-menu (click to select, not hold-and-release)

**Impact:** More discoverable features, better UX for complex operations.

### Priority 4: fzf Deck Picker (Medium Impact, Medium Effort)

**Build a fzf-powered deck selector with preview.**

- `prefix + f` opens popup with fzf listing all decks
- Preview shows last 20 lines of deck output
- Ctrl-K to kill, Enter to switch
- Especially valuable when >5 decks

**Impact:** Scales beyond the status bar's 5-deck limit. Fuzzy search is fast.

### Priority 5: DJ Mode Key Table (Medium Impact, Low Effort)

**Create a dedicated "DJ Mode" for keyboard power users.**

- `prefix + j` enters DJ mode
- Status bar changes color (yellow background)
- Single-key deck operations: n/k/g/s/1-9/d/q
- Sticky mode (each key re-enters DJ mode after execution)

**Impact:** Keyboard users get lightning-fast deck management without mouse.

### Priority 6: Popup Editor (Low Impact, Low Effort)

**Open $EDITOR in a popup for composing multi-line prompts.**

- `prefix + m` → prompt for deck name → popup editor
- On save, content sent to deck via send-keys
- Much better than single-line command-prompt

**Impact:** Quality-of-life for sending complex instructions to decks.

### Future: Control Mode Monitoring

When Booth's monitoring needs grow beyond hooks + capture-pane:
- A Node.js/Python process running in control mode (`tmux -C`)
- Subscribes to format changes per deck via `refresh-client -B`
- Receives instant `%subscription-changed` events
- Builds a real-time model of all deck activity

This replaces the watchdog entirely but requires significant architectural work.

### Future: Non-Blocking Popups (tmux Upstream)

PR #4379 adds `-D` flag for non-blocking popups. When merged:
- Toast notifications that don't steal focus
- Persistent floating deck monitors
- Picture-in-picture deck view

Watch [tmux/tmux#4379](https://github.com/tmux/tmux/pull/4379) for progress.

---

## Sources

### Official tmux Documentation
- [tmux man page](https://man7.org/linux/man-pages/man1/tmux.1.html)
- [tmux Wiki: Formats](https://github.com/tmux/tmux/wiki/Formats)
- [tmux Wiki: Advanced Use](https://github.com/tmux/tmux/wiki/Advanced-Use)
- [tmux Wiki: Control Mode](https://github.com/tmux/tmux/wiki/Control-Mode)
- [tmux CHANGES (3.5a)](https://raw.githubusercontent.com/tmux/tmux/3.5a/CHANGES)
- [tmux CHANGES (master)](https://raw.githubusercontent.com/tmux/tmux/master/CHANGES)

### tmux Issues & PRs
- [#3652: Add a clickable button to status bar](https://github.com/tmux/tmux/issues/3652)
- [#4011: Different mouse actions on status lines](https://github.com/tmux/tmux/issues/4011)
- [#1649: Mouse on status center area](https://github.com/tmux/tmux/issues/1649)
- [#4379: Non-blocking popup PR](https://github.com/tmux/tmux/pull/4379)
- [#4032: Popups as toast notifications](https://github.com/tmux/tmux/issues/4032)
- [#1083: Complete list of hooks](https://github.com/tmux/tmux/issues/1083)

### Plugins
- [tmux-agent-indicator](https://github.com/accessd/tmux-agent-indicator) — AI agent state tracking
- [tmux-which-key](https://github.com/alexwforsythe/tmux-which-key) — Spacemacs-style popup menu
- [tmux-menus](https://github.com/jaclu/tmux-menus) — Comprehensive popup menu system
- [tmux-sessionx](https://github.com/omerxx/tmux-sessionx) — fzf session manager
- [tmux-floax](https://github.com/omerxx/tmux-floax) — Floating pane plugin
- [tmux-tpad](https://github.com/Subbeh/tmux-tpad) — Multiple floating windows
- [tmux-thumbs](https://github.com/fcsonline/tmux-thumbs) — Hint-based text selection
- [tmux-fingers](https://github.com/Morantron/tmux-fingers) — Vimium-style hint copy
- [catppuccin/tmux](https://github.com/catppuccin/tmux) — Theme + module framework
- [tmux-powerline](https://github.com/erikw/tmux-powerline) — Segment-based status bar
- [tmux-fzf](https://github.com/sainnhe/tmux-fzf) — fzf integration
- [tmux-nerd-font-window-name](https://github.com/joshmedeski/tmux-nerd-font-window-name) — Nerd Font icons
- [extrakto](https://github.com/laktak/extrakto) — Fuzzy text selection from buffer

### Guides & Articles
- [Binding Keys in tmux (seanh.cc)](https://www.seanh.cc/2020/12/28/binding-keys-in-tmux/)
- [Session switching with tmux menu (qmacro.org)](https://qmacro.org/blog/posts/2021/08/12/session-switching-with-the-tmux-menu/)
- [Floating popups in tmux (DEV)](https://dev.to/waylonwalker/floating-popups-in-tmux-67)
- [Dismissable Popup Shell (willhbr.net)](https://willhbr.net/2023/02/07/dismissable-popup-shell-in-tmux/)
- [tmux popup cheat sheet (justyn.io)](https://justyn.io/til/til-tmux-popup-cheatsheet/)
- [The Power of tmux Hooks (devel.tech)](https://devel.tech/tips/n/tMuXz2lj/the-power-of-tmux-hooks/)
- [Make tmux modal (alexherbo2)](https://alexherbo2.github.io/config/tmux/make-tmux-modal/)
- [Custom key tables (tmuxai.dev)](https://tmuxai.dev/tmux-key-tables/)
- [tmux popup for Claude Code (devas.life)](https://www.devas.life/how-to-run-claude-code-in-a-tmux-popup-window-with-persistent-sessions/)
- [tmux popup editor for Cursor Agent (foo.zone)](https://foo.zone/gemfeed/2026-02-02-tmux-popup-editor-for-cursor-agent-prompts.html)
- [Notification System for tmux + Claude Code (quemy.info)](https://quemy.info/2025-08-04-notification-system-tmux-claude.html)
- [Braille Spinner Animation (GitHub Gist)](https://gist.github.com/Arteiii/10257788269619c4c7ab64f9665bdf13)
- [tmux right-click menu customization (GitHub Gist)](https://gist.github.com/m4ttm/4e13917af6dde9f6fbff59e61125c18e)
- [tmux-echelon reactive automation](https://github.com/jnurmine/tmux-echelon)
- [Optimizing tmux Status Bar (2025)](https://blogdeveloperspot.blogspot.com/2025/06/crafting-your-perfect-tmux-status-bar.html)
- [awesome-tmux](https://github.com/rothgar/awesome-tmux)

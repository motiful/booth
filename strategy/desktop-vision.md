# Booth Desktop Vision

## 核心思路

DJ session = 桌面。不只是一个 CC 对话窗口，而是一个多 pane 的工作台。

## 布局

```
┌─────────────────────────────────────────────────┐
│  🕐 12:34  │  BOOTH v0.1  │  decks: 3 active    │  ← 顶部 info pane（永久）
├────────────────────┬────────────────────────────┤
│                    │                            │
│   DJ (Claude Code) │   deck-1 (joined pane)    │  ← join-pane 借来的
│                    │                            │
│                    ├────────────────────────────┤
│                    │                            │
│                    │   deck-2 (joined pane)     │  ← 可以开多个
│                    │                            │
├────────────────────┴────────────────────────────┤
│ [ BOOTH ] [ DJ ]              ⣾deck-1 ✓deck-2  │  ← 状态栏
└─────────────────────────────────────────────────┘
```

## 交互

### 开 split
- Shift+click deck 名 → `join-pane` 把 deck pane 借到 DJ window
- deck session 保留一个 placeholder window 防止死掉
- 可以同时 join 多个 deck

### 关 split
- 方案 A: 状态栏左下角根据 focused pane 动态显示 [ESC] [Kill] 按钮
  - 点 [ESC] → `break-pane` 还回去（deck 继续运行）
  - 点 [Kill] → kill deck session
  - DJ pane focused 时不显示这些按钮
- 方案 B: Shift+click 同一个 deck 名 → toggle（再点一次还回去）
- 方案 C: 都要（按钮 + toggle）

### 状态栏上下文感知
- 左下角 BOOTH badge 旁边显示当前 focused pane 的控制按钮
- DJ pane: 只显示 [ BOOTH ] [ DJ ]
- Deck pane: 显示 [ BOOTH ] [ ← ESC ] [ ✕ Kill ] [ deck-name ]
- 利用 tmux 的 `pane-focus-in` hook 更新 `@booth-status-left-extra`

### 顶部 info pane
- 可选的永久 pane，显示时钟、logo、deck 概览
- BOOTH badge 点击菜单里有 toggle 显示/隐藏
- 用简单脚本：`while true; do clear; date; echo "BOOTH"; sleep 60; done`

## 技术要点

### join-pane 机制
```bash
# 借 pane
tmux new-window -t "$DECK" -n _booth_hold -d  # placeholder 防 session 死
tmux join-pane -s "$DECK:1.0" -h -l 50%       # 搬到 DJ window

# 还 pane
tmux break-pane -d -s "$PANE_ID" -t "$DECK:"  # 搬回 deck session
tmux kill-window -t "$DECK:_booth_hold"        # 清理 placeholder
```

### 状态追踪
- `@booth-joined-decks`: 当前 join 了哪些 deck（逗号分隔）
- `@booth-pane-map`: pane_id → deck_name 映射
- pane-focus-in hook 更新 `@booth-status-left-extra`

### 边界情况
- deck CC 退出 → joined pane 变成 zsh shell → 检测到后自动 break-pane 还回去
- deck session 被 kill → joined pane 自动消失 → 清理状态
- 多个 deck 同时 join → 需要管理多个 placeholder + pane 映射
```

## 实现优先级

1. 先做单个 join-pane toggle（Shift+click）
2. 再做状态栏上下文感知按钮（[ESC] [Kill]）
3. 最后做顶部 info pane（nice to have）

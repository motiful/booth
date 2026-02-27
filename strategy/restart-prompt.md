# Booth 重启 Prompt

下次启动 Booth DJ 后，粘贴以下内容：

---

```
你好，我刚重启了 Booth。上次 session 我们做了大量改动但没来得及统一测试。请帮我按顺序检测以下内容：

## 环境检查
1. tmux 版本：确认 server 跑的是 3.6a（上次装了但 server 还是 3.5a，需要重启才能生效）
2. skill symlink：确认 ~/.claude/skills/booth-skill → ~/motifpool/booth/skill/（不是 cp）
3. booth.tmux.conf 已加载（source-file）

## 功能测试（按优先级）

### P0: 基础功能
1. **状态栏 click-to-switch**：开一个 test deck，单击状态栏 deck 名能切过去
2. **BOOTH 菜单**：左键点 BOOTH badge，弹出 Session Tree + Shutdown
3. **动画 spinner**：deck 工作中时，状态栏显示 braille spinner（⣾⣽⣻⢿⡿⣟⣯⣷）

### P1: Watchdog + Hooks
4. **tmux hooks**：开 deck 时 on-session-event.sh 自动触发，decks.json 自动注册
5. **Watchdog 启动**：spawn-child.sh 是否启动了 background watchdog（检查 PID 文件）
6. **deck-status.sh**：一次性查询 deck 状态，JSONL primary + capture-pane fallback
7. **Alert 管道**：deck idle 后，alerts.json 写入 → stop hook 读取 → DJ 收到通知

### P2: 新 UI（待实现）
8. **join-pane split**：Shift+click deck 名 → join-pane 把 deck pane 借到 DJ window → 再 Shift+click 还回去
   - 这个还没实现，只有旧的 capture-pane glance。需要重写为 join-pane toggle
9. **桌面模式 vision**：DJ session 作为桌面，顶部可以有永久性 info pane（时钟/logo），底部 join 多个 deck pane，左下角状态栏根据 focused pane 变化（deck pane 显示 ESC/Kill 按钮）

## 已知问题
- Shift+click 目前是 capture-pane glance，不是 join-pane（P2 待改）
- 右键菜单已禁用（VS Code 冲突）
- booth-context-menu.sh 存在但没有 binding 触发它

## 改动历史（10 commits, a3bf610 → 5658834）
- click-to-switch + range tag 修复
- Python→Node.js 引擎迁移 (jsonl-state.mjs)
- 4-layer alert system (alerts.json + stop hook)
- tmux hooks 自动注册 (on-session-event.sh)
- watchdog 从 tmux window → background process (nohup + PID)
- animated spinners + BOOTH menu
- shift+click glance + disable conflicting bindings
- child-protocol 用户友好语言规则

请从环境检查开始，逐项测试并报告结果。
```

---

## 备注

- 这个 prompt 是给 DJ (Booth) 用的，不是给 deck 用的
- 粘贴后 DJ 会自主执行检测流程
- join-pane 桌面模式是新 vision，需要在 P1 测试通过后再实现

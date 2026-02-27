# tmux 状态栏点击交互：设计模式与踩坑记录

## 架构概览

Booth 用 tmux 状态栏实现 click-to-switch：点击 deck 名字切换到对应 session。

```
status-left:  [ BOOTH ] [ DJ ]          ← DJ button (user range)
status-right: ●wd-rewrite ✓research     ← deck list (user ranges)
```

## 核心机制：#() + @variable + #{E:}

tmux 状态栏的三层渲染：

1. **`#(script.sh)`** — 执行脚本，输出替换到状态栏。**但输出不解析格式标签**（`#[fg=...]`、`#[range=...]` 全部原样显示）。
2. **`@user-variable`** — 脚本通过 `tmux set -gq @var "..."` 写入变量。变量值可以包含格式标签。
3. **`#{E:@var}`** — 渲染时展开变量并**解析其中的格式标签**。这是唯一让 range tags 生效的方式。

### 正确模式

```bash
# booth-status.sh（被 #() 触发执行）
OUT="#[range=user|deck1]#[fg=colour39]● deck1#[norange]"
tmux set -gq @booth-deck-status "$OUT"
```

```tmux
# booth.tmux.conf
# #() 触发脚本（返回值被丢弃），#{E:@var} 渲染内容
set -g status-right "#(bash status.sh #{socket_path})#{E:@booth-deck-status}"
```

### 错误模式

```bash
# ✗ 直接 echo — 格式标签不会被解析
echo "#[range=user|deck1]● deck1#[norange]"

# ✗ 直接 set status-right — 会覆盖整个格式，丢失 #() 触发器
tmux set -g status-right "$OUT"
```

## 关键发现：User Range 的鼠标事件

**这是最大的坑：**

| 区域 | 无 range tag 时 | 有 `#[range=user|X]` 时 |
|------|----------------|------------------------|
| status-left | `MouseDown1StatusLeft` | **`MouseDown1Status`** |
| center (window list) | `MouseDown1Status` | `MouseDown1Status` |
| status-right | `MouseDown1StatusRight` | **`MouseDown1Status`** |

**User range tags 永远触发 `MouseDown1Status`，无论它出现在状态栏的哪个区域。**

这意味着：
- `MouseDown1StatusLeft` 和 `MouseDown1StatusRight` 对 user ranges 无效
- 所有 range 点击处理必须写在 `MouseDown1Status` 绑定里

### 正确绑定

```tmux
# MouseDown1Status 是唯一能收到 user range 点击的绑定
bind -T root MouseDown1Status run-shell '\
  RANGE="#{mouse_status_range}"; \
  case "$RANGE" in \
    ""|left|right|status|window) ;; \
    *) tmux -S "#{socket_path}" switch-client -t "$RANGE" 2>/dev/null;; \
  esac'

# StatusLeft/StatusRight 对 user ranges 不生效，置空
bind -T root MouseDown1StatusLeft  run-shell ''
bind -T root MouseDown1StatusRight run-shell ''
```

### `#{mouse_status_range}` 的值

| 点击位置 | 值 |
|---------|---|
| user range `#[range=user|foo]` | `foo`（range 参数值）|
| status-left 非 range 区域 | `left` |
| status-right 非 range 区域 | `right` |
| center 非 range 区域 | `status` |
| window 名字 | `window`（仅当 window-status 有内容时）|

必须过滤 `""`、`left`、`right`、`status`、`window`，否则 `switch-client` 会报错。

## Range 参数长度限制

tmux 的 range argument 最大 15 bytes。超长的 session 名字（如 `watchdog-rewrite` = 17 chars）可能被截断。

**应对策略：**
- 控制 deck 名字长度（推荐 ≤12 chars）
- 或在 range tag 中使用短别名，显示文本保持全名

## 隐藏默认 Window List

Booth 用自定义 status-left/right 取代了 tmux 原生的 window list。必须隐藏原生列表，否则会显示 `1:zsh` 等噪声：

```tmux
set -g window-status-format ""
set -g window-status-current-format ""
set -g window-status-separator ""
```

## 右键菜单

右键也用相同的 range 分发逻辑：

```tmux
bind -T root MouseDown3Status run-shell '\
  RANGE="#{mouse_status_range}"; \
  case "$RANGE" in \
    ""|left|right|status) ;; \
    *) bash context-menu.sh "$RANGE" "#{socket_path}";; \
  esac'
```

## 调试技巧

```bash
# 检查 user variable 内容
tmux show -gvq @booth-deck-status

# 检查鼠标事件是否触发
bind -T root MouseDown1Status run-shell 'echo "range=#{mouse_status_range}" >> /tmp/tmux-click.log'

# 检查 #{socket_path} 展开
tmux display-message -p "#{socket_path}"
```

## 完整调用链

```
tmux 每 5 秒:
  status-right 里的 #() → 执行 booth-status.sh
    → 读 session 列表
    → 检测每个 deck 状态
    → 构建带 range tags 的字符串
    → tmux set -gq @booth-deck-status "$OUT"
  #{E:@booth-deck-status} → 展开变量 → 解析格式/range 标签 → 渲染到状态栏

用户点击 deck 名字:
  → 触发 MouseDown1Status（不是 StatusRight！）
  → run-shell 读取 #{mouse_status_range}
  → 值是 session name → switch-client
```

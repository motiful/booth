# Booth v2 — Progress

> Current execution state. Read this first when starting a session.

## Current Phase: Phase A — 生存质量

> Compaction 防护 → Worktree isolation → Guardian 调研。详见下方路线图。

---

## Archived Phases

### Phase 1 to 2.8 — 已归档

**归档文件**: `.claude/archive/progress-phase1-to-2.8-2026-03-11.md`
**摘要**: Foundation → Core loop → Init hardening → Deck modes → Pre-Phase 3 补充 → Input protection + Signal simplification → Skill overhaul → 30+ incremental fixes (idle detection, JSONL IPC, session ID pre-gen, archive unification, startup UX, DJ persistence)
**关键决策**: 单通道 notifyDj（alert 双通道移除）、protectedSendToCC 统一（Ctrl+G editor proxy）、Daemon 禁止同步阻塞、.booth/ 刚性入口

### Wave C to E — 已归档

**归档文件**: `.claude/archive/progress-wave-c-to-e-2026-03-11.md`
**摘要**: State 层 JSON → SQLite 迁移 → Sessions/Archives 合并为单表 → Wave E lifecycle simplification（DeckStatus 6→4 值、退出信号统一、unconditional resume、records persist forever）→ ls DJ 显示 + limit flag。Stop→Resume 全链路 E2E 验证通过。
**关键决策**: better-sqlite3 同步 API、DeckStatus 仅 4 值（working/idle/checking/exited）、所有退出操作为 UPDATE 不 DELETE、stop 默认保留状态 + --clean 设 exited

---

## Architecture

```
CLI Layer:
  booth          → daemon + tmux + DJ (--dangerously-skip-permissions --append-system-prompt)
  booth spin     → tmux new-window + register deck + CC (--dangerously-skip-permissions)
  booth ls       → IPC query
  booth kill     → IPC kill-deck (tmux kill-window + unwatch + remove + archive)
  booth stop     → IPC shutdown (archive all decks + kill windows + session + daemon exit)
  booth resume   → restore archived deck (--resume CC session)
  booth config   → read/write .booth/config.json (set/get/list)

Daemon Layer:
  Signal    → JSONL tail per deck + DJ JSONL tracking
  State     → SQLite (better-sqlite3) + in-memory cache
  Reactor   → idle → check flow + beat timer + notifyDj + plan-mode auto-approve
  IPC       → ping, ls, status, register/remove/kill-deck, send-message, shutdown, deck-exited, resume-deck
  Health    → 30s pane liveness check

Signal Flow:
  Deck completes → JSONL turn_duration → idle
  → Reactor.onDeckIdle() → 500ms delay → runCheck()
  → No .booth/reports/<deck>.md? → sendMessage [booth-check] → deck reads .booth/check.md
  → Deck sub-agent review → writes report → idle
  → Report exists + terminal status? → notifyDj() → protectedSendToCC (Ctrl+G safe)
  → DJ receives [booth-alert] → reads report → handles per mix.md → booth kill <deck>

Signal Delivery (single channel):
  notifyDj(message) → sendMessage() → protectedSendToCC()
  - Ctrl+G editor proxy: PID file detection, wait for user close
  - Per-pane state isolation: ~/.booth/editor-state/pane-XX/
  - All CC sessions (DJ + deck) use same protectedSendToCC
  - Beat as periodic fallback (adaptive cooldown 5→10→20→…→60min)

.booth/ Directory (gitignored):
  booth.db                             — runtime state (SQLite: sessions, DJ, deck status — migrated from state.json)
  daemon.sock                          — daemon IPC
  logs/daemon-YYYY-MM-DD.log           — Winston daily rotate (7d retention)
  logs/daemon-stderr.log               — uncaught errors fallback
  reports/                             — transient report files (ingested to SQLite then deleted)
  config.json                         — user config (editor, etc.)
  check.md, mix.md, beat.md           — rigid entry points (copied from templates, user-customizable, future: skill routers)
```

## Key Design Decisions

| 决策 | 内容 |
|------|------|
| 单通道 notifyDj | protectedSendToCC 直接注入，beat 周期性兜底。alert 双通道已移除 |
| protectedSendToCC 统一 | DJ 和 deck 全部走 Ctrl+G editor proxy，统一保护逻辑 |
| .booth/ 行为文档 | check/mix/beat.md 拷贝到 .booth/，用户可改，绝对不用 global install 路径 |
| @booth-root | tmux 全局变量锚定 projectRoot，防 CWD 漂移 |
| Beat 降级 | 核心闭环不依赖 beat，但 beat 是 notifyDj 的周期性兜底 |
| 全 skip-permissions | DJ + 所有 deck 默认 --dangerously-skip-permissions |
| .booth/ 刚性入口 | check/mix/beat.md 是代码保证执行的刚性入口，同时是用户可定制的路由器，未来可指向 skills |

---

## Pending Items — Phase A–F 路线图

### Phase A: 生存质量 — DJ 不失忆、deck 不打架

> 目标：booth 在长时间运行中保持可靠。

**A1. Compaction 防护**（重中之重）

> 调研文档：`../booth-backstage/research/cc-compaction-2026.md`（25+ 来源引用）

**问题/痛点**：DJ 是长期运行的 CC session，上下文窗口必然会被 compaction（自动或手动 `/compact`）。Compaction 后 DJ 丢失的不是"记忆"而是**工作能力**：

- **Deck 追踪上下文**：哪些 deck 在做什么、进度到哪了、之前给了什么 prompt——全部 summarize 为模糊描述
- **未处理 alert**：compact 前收到的 `[booth-alert]` 消息被压缩成"收到一个 deck 通知"，丧失可操作性
- **Plan 进度**：step-by-step 计划被压缩为模糊描述，compact 后 DJ 可能重新做已完成的步骤或推翻之前的决策（社区确认的 "plan drift" 问题）
- **当前决策上下文**：正在评估的 report、正在做的 trade-off 分析、用户最近的指令——全部被 summarize

**已知信息**（来自调研文档）：

- CC compaction 有两种：auto-compaction（上下文 75-95% 时自动触发）和手动 `/compact`
- **CLAUDE.md 在 compact 后从磁盘重新加载**，不参与 summarization——这是最可靠的持久化锚点
- CC 提供 `PreCompact` hook（在 summarization 之前触发），但**没有 PostCompact hook**（GitHub #14258 有 feature request）
- 环境变量 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (1-100) 可配置触发阈值
- CC 无法自检上下文使用率（GitHub #23457 有 feature request），DJ 无法主动知道自己距 compact 多远
- compact 期间 CC 是 working 状态，不接受交互输入，Ctrl+G editor proxy 可能 hang
- beat 是天然安全的兜底——compact 期间丢失的 notifyDj 信号会在下一个 beat 周期被发现

**未知/困惑**：

- Ctrl+G 在 compact 期间的**确切行为**未经验证——调研文档中的分析基于机制推断，需要实际测试
- PreCompact hook 的执行时序——是在 summarization API 调用之前还是之后？命名暗示是"之前"，但需验证
- Compact Instructions 在 CLAUDE.md 中的遵循程度——社区评价参差不齐
- `pause_after_compaction`（API 层参数）何时在 CC CLI 中暴露——暂不可用

**成功标准**：DJ 被 compact 后能在 30 秒内恢复工作状态——知道当前有哪些 deck、各自状态、当前 plan 进度、未处理的 alert。

- [ ] **PreCompact hook 防护**
  - 配置 `PreCompact` hook 调用 `booth compact-prepare` CLI 命令
  - `compact-prepare` 通过 IPC 获取 daemon 权威状态快照（deck 列表/状态、beat 位置、pending alerts）
  - 快照写入 `.booth/compact-state.json`，hook 返回 exit 0 不阻塞 compact
  - CC 支持：**已确认可用**（`settings.json` 的 `hooks.PreCompact`）
  - 需实现：`src/cli/commands/compact-prepare.ts` + IPC handler `compact-prepare`
- [ ] **CLAUDE.md Compact Instructions**（零代码）
  - 在项目 CLAUDE.md 中添加 `# Compact Instructions` section
  - 指导 compact summary 保留：当前 deck 状态和 assignments、最近 beat 结果、未处理通知、当前 phase
  - 指导 compact 后立即：读 `.booth/compact-state.json` 恢复状态 → `booth ls` 验证 → 恢复 beat 周期
  - **必须写在 CLAUDE.md 而非 `.booth/mix.md`**——mix.md 作为对话上下文的一部分会被 summarize 掉
  - CC 支持：**已确认可用**（官方推荐方式）
- [ ] **信号安全策略**
  - **SQLite 已持久化的状态**（compact 安全）：deck 列表、deck 状态（working/idle/checking/exited）、DJ 状态、pane ID、session ID、JSONL 路径、report 内容及审阅状态、所有历史记录
  - **仍在 CC 内存中的状态**（compact 会丢）：DJ 当前正在处理的 alert 文本、DJ 对 report 的评审进展、用户最近的指令和 DJ 的决策上下文、plan.md 的最新修改（如果还没写到磁盘）
  - **结论**：daemon 侧几乎所有状态已被 SQLite 持久化。风险集中在 DJ CC 对话上下文中的"软状态"——这些通过 CLAUDE.md Compact Instructions + compact-state.json 恢复。**不需要第三条信号路径**——beat 作为周期性兜底已足够，compact 典型持续时间（秒到分钟级）远小于 beat cooldown（5 分钟起）
  - 需调研：compact hang 住的极端情况（GitHub #19567）——归入 Guardian 范畴
- [ ] **StatusLine hook 调研**
  - CC StatusLine hook 可能允许在 TUI 底部显示 booth 状态（deck 数量、当前 phase 等）
  - 需调研：CC 是否已支持 StatusLine hook？格式是什么？能否在 compact 期间/之后自动刷新？
  - 优先级低——即使不做，compact-state.json + CLAUDE.md Instructions 已覆盖核心需求
- [ ] **DJ Context 审计**
  - 列出 DJ 正常运作依赖的所有上下文信息
  - 逐一确认每项信息在 compact 后的恢复路径（SQLite / compact-state.json / CLAUDE.md / plan.md）
  - 确认没有遗漏的"隐性依赖"——例如 DJ 是否隐式依赖对话历史中某些工具调用的结果
  - 最终产出：一张"compact 覆盖度"表格，标注每项信息的恢复来源和恢复置信度

**A2. Worktree Isolation**（必做）

**问题/痛点**：当前所有 deck 共享同一个 git 工作目录。这导致：

- **文件冲突**：两个 deck 同时修改同一个文件（例如都需要改 `src/daemon/index.ts`），后提交的覆盖先提交的
- **git status 污染**：一个 deck 的 uncommitted changes 出现在所有 deck 的 `git status` 中，干扰判断
- **编译破坏**：一个 deck 的半完成修改可能导致另一个 deck 运行 `npx tsc` 时失败
- **DJ 当前通过 "Safe concurrency"（不同 deck 改不同文件）来规避**，但这是脆弱的约定而非机制保障

**已知信息**：

- Git worktree 是 git 原生功能：`git worktree add <path> -b <branch>` 创建独立工作目录，共享 `.git` 对象
- CC 本身已有 worktree 支持（`isolation: "worktree"` 参数给 subagent）
- Worktree 完成后需要 rebase 到 main 才能合并

**已知挑战/未知**：

- **CLAUDE.md 发现**：CC 通过向上遍历目录找 `.git` 或 `CLAUDE.md`。Worktree 的 `.git` 是一个 file（指向主仓库），不是目录。**需验证 CC 能否在 worktree 中正确找到项目 CLAUDE.md**
- **`.booth/` 路径解析**：`findProjectRoot()` (`src/constants.ts:15-28`) 先找 `.booth/` 目录，找不到再找 `.git` / `package.json`。Worktree 中没有 `.booth/`——**deck 需要通过什么方式访问 `.booth/reports/`？** 选项：(a) 符号链接 `.booth/` 到主仓库 (b) 环境变量传递 projectRoot (c) 修改 `findProjectRoot` 逻辑
- **Rebase 冲突**：如果两个 deck 都改了同一个文件（不同行），rebase 可能自动合并；如果改了同一行，需要冲突处理。当前无自动化——deck 需要报告冲突让 DJ 决策
- **tmux socket 和 pane ID**：`deriveSocket()` 基于 `projectRoot` 路径的 SHA256 hash。如果 worktree 路径不同于主仓库路径，socket 会不同——**daemon 需要使用统一的主仓库路径**
- **Worktree 清理**：`git worktree remove` 需要工作目录干净。如果 deck 崩溃留下脏 worktree 怎么办？

**成功标准**：两个 deck 可以同时修改同一个文件（不同区域），各自编译通过，最终自动合并到 main 无冲突。

- [ ] 每个 deck 工作在独立 git worktree 中
- [ ] 确认 CC 在 worktree 中正常工作（CLAUDE.md、`.booth/` report 路径等）
- [ ] deck 完成后 rebase + fast-forward merge 到 main
- [ ] deck kill 时自动清理 worktree
- [ ] 冲突处理机制（deck 尝试 rebase → 冲突时报告 DJ → DJ 决策：手动解决/放弃/重新 spin）

**A3. Guardian 进程自愈**（需调研后再决定是否实现）

**问题/痛点**：CC session 可能崩溃（OOM、网络断开、CC bug、API 故障），pane 死了但 daemon 不知道。当前流程是：health check 30s 检测 → 发现 pane gone → 日志记录 → 等待 DJ 手动处理。没有自动恢复机制。

**已知信息——现有 health check 做了什么** (`src/daemon/index.ts:520-553`)：

- 每 30 秒运行一次（`setInterval(30_000)`）
- 遍历所有 deck，用 `tmux display-message -t <paneId> -p '#{pane_pid}'` 检测 pane 存活
- pane 丢失时：`logger.warn()` 记录日志 + `signal.unwatch()` 停止 JSONL 监控 + 加入 `paneLost` Set
- pane 恢复时（resume 后）：从 `paneLost` Set 移除
- 也检查 DJ pane，但仅日志记录
- **不修改 deck 状态，不发送 alert，不触发自动恢复**

**pane ID 准确性**（`src/daemon/state.ts`）：

- pane ID 在 deck 注册时存入 SQLite（`registerDeck()`），resume 时更新（`resumeDeck()`）
- pane ID 格式为 tmux `%N`（如 `%26`），由 tmux 分配
- `clearPaneId()` 在 `pruneStaleDecks()` 中调用——daemon 重启时清除已失效的 pane ID
- **pane ID 不会自然漂移**——它在 pane 的生命周期内是稳定的。但 pane 被 kill 后 ID 被 tmux 回收，可能分配给新 pane
- 当前无 "pane ID → process" 的二次验证。如果 ID 被回收分配给非 booth 的 pane，health check 会误判为存活

**Guardian 在 health check 基础上增加什么**：

- 自动 resume：检测到 pane 死亡 → 调用 `booth resume <name>` → 验证恢复成功
- 重试限制：同一 deck 连续失败 3 次 → 放弃恢复 → 通知 DJ
- 可能需要区分"可恢复崩溃"（OOM/网络）和"不可恢复错误"（代码 bug 导致无限崩溃）

**未知/困惑**：

- 自动 resume 的成本：每次 resume 启动一个新的 CC session，消耗 token（至少读 CLAUDE.md + 恢复上下文）
- CC `--resume` 对崩溃 session 的行为：如果 session 是非正常退出，`--resume` 能正确恢复吗？
- 是否需要 Guardian？如果 DJ 在 5 分钟内（下一个 beat）能收到 deck-exited 信号并手动处理，自动化的收益是否值得额外复杂度？

**成功标准**：deck CC 崩溃后 60 秒内自动恢复工作，无需 DJ 干预。连续崩溃 3 次自动停止并通知 DJ。

- [ ] Guardian 调研报告（轻量性、检测方式、与现有 health check 的关系、成本收益分析）
- [ ] Guardian 实现（如调研结论为值得）：检测崩溃 → 自动 resume → 3 次失败后放弃通知 DJ

---

### Phase B: Skills 整改 — 加载策略健康化

> 目标：Mix 和所有 skill 的加载/管理策略理顺。优先级最高（Phase A 之后）。

**B1. Mix 策略化**

**问题/痛点**：当前 skill/mix 的加载和管理链路有几个潜在问题，但**需要先调研确认哪些是真实问题、哪些是猜测**。

**当前加载链路**（已确认）：

1. `skill/SKILL.md` — CC skill system 加载入口，在 CC 启动时注入 system prompt。定义 booth 的概况、信号含义、deck 模式、关键路径、参考文件列表（约 70 行）
2. `skill/templates/mix.md` — DJ 管理手册（Source of Truth），约 480 行。在 `booth init` 或首次 `initBoothDir()` 时被 **copy** 到 `.booth/mix.md`
3. `.booth/mix.md` — 运行时 DJ 实际读取的文件。用户可自定义。DJ 通过 `--append-system-prompt` 加载此文件
4. `skill/references/*.md` — signals.md、cli.md、child-protocol.md、beat.md 等参考文档，CC 按需读取

**已确认的问题**：

- **Copy 不是 version-tracked**：`.booth/mix.md` 是 `skill/templates/mix.md` 的一次性 copy（`initBoothDir()` 只在文件不存在时拷贝，`src/constants.ts:89`）。代码更新 `skill/templates/mix.md` 后，已有项目的 `.booth/mix.md` 不会自动更新。用户必须手动删除 `.booth/mix.md` 再 `booth init` 才能获得新版本
- **SKILL.md 和 mix.md 的职责边界模糊**：SKILL.md 定义了概况信息，mix.md 定义了详细操作指南。但两者都在 DJ system prompt 中——SKILL.md 通过 CC skill system 注入，mix.md 通过 `--append-system-prompt` 注入。**是否存在重复加载和 context 浪费？**

**需要调研确认的问题**：

- **Mix 的 context 成本**：mix.md 约 480 行作为 system prompt 注入，实际占用多少 token？是否构成 DJ context 的显著比例？如果 DJ 200K context 中 mix.md 只占 2-3K token，优化的收益很小
- **Skill 动态加载**：references/ 下的文件是 CC 按需读取的（DJ 执行 Read 工具时读），不是预加载的。这已经是"动态加载"了——**是否还需要进一步优化？**
- **用户自定义需求**：`.booth/mix.md` 的"用户可自定义"设计是否有实际用户？如果没有，copy 机制可以简化为直接读 template

**未知/困惑**：

- 如果 mix.md 改为"路由器"模式（.booth/mix.md 只包含指向 skill 的 reference link），DJ 的 system prompt 变小了，但需要多一次 Read 才能获取完整指南——这是否反而增加延迟和 token 消耗？
- domain-specific skills（例如不同项目有不同的 check 标准）的需求是否真实存在？

**成功标准**：mix/skill 的加载策略有明确文档；消除 copy 不同步问题；context 成本可量化。

- [ ] 调研当前 Mix 加载策略的 context 成本（量化 token 占比）
- [ ] 解决 copy 不同步问题（版本检查？hash 对比？每次启动自动更新？）
- [ ] .booth/ 文件作为刚性入口 + 路由器，可指向 domain-specific skills
- [ ] skill 依赖链理顺（SKILL.md vs mix.md 职责边界明确化）

---

### Phase C: 产品打磨 — 用户体验可交付

> 目标：UIUX 达到可交付标准。

**C1. UIUX 打磨**

**已知 UX 痛点**：

- **CLI 交互模式单一**：当前 17 个命令（`src/cli/commands/`）全部是"执行一次退出"模式。没有 interactive/dashboard 模式——用户必须反复输入 `booth ls` 来查看状态
- **错误信息不友好**：CLI 错误只输出 `Usage: booth <cmd> <name>` + `process.exit(1)`，没有上下文提示（例如"你是不是想说 booth kill auth-fix？deck 'auth-fx' 不存在"）
- **`booth ls` 信息密度低**：只显示 mode/status/时间。缺少：当前 prompt 摘要、check 进度、report 状态
- **Report 展示**：`booth reports` 列表缺少摘要预览；`booth reports <name>` 输出纯 markdown 到 stdout，没有语法高亮或分页
- **`booth peek` 信息有限**：只看最后 N 行 tmux 输出，无法区分 CC 输出 vs 用户输入 vs 工具调用
- **缺少 `booth dashboard`**：一个持续刷新的 TUI，实时展示所有 deck 状态、DJ 状态、最近 alert——对于管理多个 deck 的场景非常有价值

**成功标准**：新用户 5 分钟内能理解 booth 工作流；日常操作不需要反复输入查询命令。

- [ ] booth 指令交互打磨（参考老 booth 取精华去糟粕，推陈出新）
- [ ] Report 系统展示优化（摘要预览、语法高亮、分页）
- [ ] 整体用户流程优化（错误提示、fuzzy match deck 名、命令补全）

**C2. Token 统计**（精简版 Attention Management）

**已知信息**：

- CC JSONL 输出中**已包含 token 用量数据**。每条 `type: "assistant"` 的消息包含 `message.usage` 字段：
  - `input_tokens`：输入 token 数
  - `output_tokens`：输出 token 数
  - `cache_creation_input_tokens`：缓存创建 token 数
  - `cache_read_input_tokens`：缓存读取 token 数
  - `service_tier`：服务层级
- Booth 的 `SignalCollector`（`src/daemon/signal.ts`）已经在 tail JSONL——**可以在现有 watcher 中同时提取 token 数据，零额外 I/O**
- 数据存储可复用 SQLite（在 sessions 表加 `total_input_tokens` / `total_output_tokens` 列，或新建 `token_usage` 表按 turn 记录）

**未知/困惑**：

- CC session resume 后 token 计数是否重置？（JSONL 是追加的，但 usage 字段是每 turn 独立的，需要累加）
- `cache_read_input_tokens` 是否应计入总量？（它代表实际消耗的 API quota 但不是"新 context"）
- Codex 的 token 统计 UI/UX 是什么样的？值得参考

**成功标准**：用户运行 `booth ls` 能看到每个 deck 的累计 token 消耗；`booth kill` 时显示总消耗。

- [ ] 在 `SignalCollector` 或 reactor 中累加 token 用量（从 JSONL `message.usage` 字段提取）
- [ ] 存入 SQLite（sessions 表扩展或独立 token_usage 表）
- [ ] `booth ls` 和 `booth kill` 显示 token 统计
- [ ] 不用于自动 kill 决策，用于分析和可视化

**C3. 产品命名重新评估**

**问题**：Booth 作为产品名在语音输入（Siri、语音转文字）中容易被识别为 "Boost"。这影响语音驱动的使用场景，但不阻塞当前技术开发。需要在 Phase D 市场定位时一并评估。

- [ ] Booth 语音输入易误识别为 Boost，评估替代名称
- [ ] 重要但不阻塞技术开发

---

### Phase D: 市场定位 — 知道自己是谁

> 目标：明确 booth 在市场中的位置。

**D1. 竞品分析**（Phase A 完成后最高优先级）

- [ ] 2026 新竞品调研（最近冒出的竞品）
- [ ] 与老 booth signal 思想对比，声明 novelty

**D2. README / 定位**

- [ ] 仓库 README 决定市场认知
- [ ] 必须在竞品分析后确定定位

---

### Phase E: 发布 — npm + 宣发

> 目标：正式上线。可在 Phase B 完成后先发一版（不宣传）。

**E1. npm publish**

hook 点已就位：`src/cli/index.ts` 的 `case undefined:` 分支

- [ ] npm publish 准备（package.json 审查、README、LICENSE、prepublishOnly script）
- [ ] `src/version.ts` — getCurrentVersion() + checkForUpdates()
- [ ] bare `booth` 版本检查（npm registry fetch，5s timeout，失败静默跳过）
- [ ] 提示格式：`[booth] New version available: 0.2.0 → npm update -g @motiful/booth`

**E2. 博客 / 宣发**

- [ ] 发博客造势
- [ ] signal 思想等沉淀内容与竞品 PK
- [ ] 在 Phase D 定位确认后执行

---

### Phase F: 平台化 — 给 agent 用

> 目标：booth 不只是给人用，主要是给 agent 用。人也可以用，但不是主要服务对象。

- [ ] Agent-as-consumer API — 其他 agent 如何调用 booth
- [ ] Codex 支持 — 探索 Codex 集成（竞品调研后）
- [ ] 跨工具集成 — 其他 CC/OpenClaw 直接调用 booth
- [ ] 移动端探索 — 手机端调用（远期）

---

### 已关闭项

| 项目 | 理由 |
|------|------|
| Archive system | SQLite 迁移后 session records persist forever，booth kill 只设 exited 不删记录 |
| User takeover/handback | live mode + booth auto/hold/live 切换已完全实现 |
| Reports follow-up auto routing | DJ 手动读 report 做决策运转良好，自动化收益不大 |
| DJ Context Management（单独项） | 被 Phase A Compaction 防护完全吸收 |
| Check timeout protection | 5 rounds 硬上限已足够，用户确认 |

---

## Phase Status

| Phase | Status | Description |
|-------|--------|-------------|
| 1–2.8 | Done | Foundation → Core loop → Init → Modes → Input protection → Signal simplification |
| Wave C–E | Done | SQLite migration → Lifecycle simplification → Stop→Resume E2E |
| Wave F | Done | Backlog 清零 + socket fix + deck perm isolation |
| Phase A | **Next** | 生存质量 — Compaction 防护、Worktree isolation、Guardian 调研 |
| Phase B | Queued | Skills 整改 — Mix 策略化、skill 依赖链 |
| Phase C | Queued | 产品打磨 — UIUX、Token 统计、产品命名 |
| Phase D | Queued | 市场定位 — 竞品分析、README/定位 |
| Phase E | Queued | 发布 — npm publish + 博客宣发 |
| Phase F | Outlined | 平台化 — Agent API、Codex、跨工具集成 |

## File Map

### Core Files
| File | Purpose |
|------|---------|
| `src/daemon/index.ts` | Daemon main — IPC, health check, JSONL watcher |
| `src/daemon/state.ts` | SQLite state layer (better-sqlite3) + in-memory cache |
| `src/daemon/reactor.ts` | Check flow + beat + notifyDj + plan-mode auto-approve |
| `src/daemon/send-message.ts` | protectedSendToCC message injection |
| `src/daemon/report.ts` | YAML frontmatter parser for check reports |
| `src/tmux.ts` | tmux operations + protectedSendToCC + editor proxy |
| `src/types.ts` | DeckStatus, DeckMode, DeckInfo, SessionRow |
| `src/constants.ts` | Paths, directories, template locations |
| `src/config.ts` | .booth/config.json read/write |
| `src/hooks.ts` | SessionEnd/SessionStart hook management |
| `src/ipc.ts` | IPC client (5s timeout) |

### CLI Commands
| File | Purpose |
|------|---------|
| `src/cli/index.ts` | Command router |
| `src/cli/commands/start.ts` | `booth` / `booth start` — daemon + DJ + attach |
| `src/cli/commands/spin.ts` | `booth spin` — create deck |
| `src/cli/commands/kill.ts` | `booth kill` — terminate deck |
| `src/cli/commands/stop.ts` | `booth stop` — shutdown everything |
| `src/cli/commands/resume.ts` | `booth resume` — restore decks + DJ |
| `src/cli/commands/restart.ts` | `booth restart` — stop + start + resume |
| `src/cli/commands/ls.ts` | `booth ls` — list decks + DJ |
| `src/cli/commands/send.ts` | `booth send` — inject prompt to deck |
| `src/cli/commands/reload.ts` | `booth reload` — graceful daemon restart |
| `src/cli/commands/reports.ts` | `booth reports` — list/view/open reports |
| `src/cli/commands/config.ts` | `booth config` — set/get/list |
| `src/cli/commands/init.ts` | `booth init` — register skill + setup |

### Skill Files
| File | Purpose |
|------|---------|
| `skill/SKILL.md` | General entrypoint (loaded by CC skill system) |
| `skill/templates/mix.md` | DJ management handbook (source of truth) |
| `skill/templates/check.md` | Deck self-review template |
| `skill/references/signals.md` | Signal types + lifecycle docs |
| `skill/references/cli.md` | CLI command reference |
| `skill/references/child-protocol.md` | Deck behavior protocol |

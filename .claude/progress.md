# Booth v2 — Progress

> Current execution state. Read this first when starting a session.

## Current Phase: Phase B — Skill 架构改造（已完成）

**设计权威**：`../booth-backstage/design/phase-b-renovation-v2.md`
**执行计划**：`../booth-backstage/plan/phase-b-execution-v2.md`

### Phase B 完成记录 (2026-04-07)

**Step 0-7 全部完成** (36d822b, dabe228, 62f2a5b):
- 散装 skill 清理 + MIT LICENSE
- references 合并（reactor-rules → signals.md）+ YAML frontmatter
- booth-dj SKILL.md (177 行) + booth-deck SKILL.md (215 行)
- System prompt 压缩 488→41 行 (boot.md)
- spin.ts deck 身份注入
- Reactor 信号措辞更新（check → skill, beat → CLI）
- BEHAVIOR_TEMPLATES 移除 + 死 import 清理
- Published skill 精简 (SKILL.md 61 行)

**目录重组** (7cd4a91):
- `skill/` 拆分为 `skill/`（CC Skill）+ `runtime/`（代码 runtime）
- `skill/templates/` 删除（死代码）
- booth-dj / booth-deck 提取为独立 git 仓库（booth-project/ 顶层）
- 外层目录 `booth/` → `booth-project/`（repo-scaffold 对齐）
- `.claude/skills/maintenance-rules/` 创建（从 CLAUDE.local.md 提取约束）
- CLAUDE.md / CLAUDE.local.md 更新
- 设计文档 §6.3-6.4 同步更新

**Completed**: Step 8 — `/slash` 信号格式验证通过 (2026-04-10)
**Completed**: E2E 运行时验证 — 全信号链路打通 (2026-04-10)

**Decisions finalized**:
- 信号格式确定为 `/slash`（/booth-check, /booth-alert, /booth-beat, /booth-compact-recovery）
- 4 个 signal skills 注册到 booth-skills Collection，与 booth/booth-dj/booth-deck 同级
- booth-dj / booth-deck 尚未 `npx skills add` 发布到 GitHub

### Hardening (2026-04-10)

E2E checklist 准备阶段发现的安全 + 启动问题，三处修复：

- **DJ 自杀防护**：`stop.ts` / `restart.ts` 增加 `BOOTH_ROLE === 'dj'` 拦截。这两个命令会 kill SESSION="dj" 整个 tmux session — 从 DJ 自身 pane 调用等于自杀（CC 进程消失，看似"突然退出"）。原 deck 拦截已存在，DJ 拦截缺失。
- **Deck CC 嵌套启动解封**：4 处 `editorSetup`（spin / resume / start / daemon guardian）前缀加 `unset CLAUDECODE`。CC 检测到 `CLAUDECODE=1` 拒绝启动嵌套 session — DJ pane 内 spin 出来的 deck pane 继承了该变量，导致 deck CC 直接报错退出。
- **保留**：`booth reload` 当时复现失败已无法重现（连续 4 次成功）。`gracefulReload` 缺第二行 log 是 winston 异步 buffer 在 `process.exit(0)` 前未 flush 所致，纯 cosmetic。

清理：旧路径 `~/motifpool/booth/booth/` 的僵尸 daemon (PID 81994, 自 3/26 运行) 终结；本项目残留的 stale tmux socket（`booth`、`booth-booth-54283ae9`、`booth-booth-d06d5266` + 一批 test/e2e socket）清除。

### E2E Clean Pass (2026-04-12)

5 个修复合并到 main 后重跑完整 E2E checklist，**结构性 + 功能性全 PASS**：

- **Bug 1 (dot encoding)** — `ccProjectsDir()` 编码 `.` 字符，daemon 正确找到 JSONL，idle 检测生效（commit 3a4590f）
- **Bug 2 (signal skills)** — 4 个 signal skills 注册为 CC skill，`/booth-check/beat/alert/compact-recovery` 不再报 "Unknown skill"（commit 0861135）
- **Bug 3 (init false-positive)** — `isInitialized()` 检查 global + project-local 双目录（commit 13093fb）
- **Bug 4 (--task alias)** — `booth spin --task` 作为 `--prompt` 别名（commit 840030f）
- **Bug 5 (init dual-directory)** — `registerBoothSkills()` 双目录注册（commit 13093fb）

完整链路验证：`booth spin → deck idle → daemon /booth-check → deck self-verify → booth report → daemon /booth-alert → DJ`，每一步都有 daemon log 证据。

`.booth/` 清理 7 个 Phase A/B 遗留文件（mix.md, beat.md, finalize-plan.md, state.json.migrated, test-guide-resume.md, deck-archive.json, alerts.json）。

**BUG-002 (booth kill 不清 tmux window) 无法复现** — 当前代码 `kill-pane` 对 single-pane window 正确连带清理 window。Idle deck + checking deck 都测过。可能是上次 session 的 stale daemon 导致。

---

## Archived Phases

### Phase A + B — 已归档

**归档文件**: `.claude/archive/progress-phaseA-B-2026-04-07.md`
**摘要**: Phase A（Compaction 防护 + Worktree + Guardian + Merge Lifecycle + Report DB + Identity Refactor + Quality Hardening）全部完成。Phase B 设计决策 13 条 + 控制论深度讨论 4 条。Architecture PRE-PHASE-B 快照。Key Design Decisions 7 条。BUG-001 部分解决。
**关键决策**: 三条哲学（机制>提示、一信号一权威、CC能做的给CC）、三层架构（DJ/Deck/Subagent）、统一信号管道（protectedSendToCC）

### Phase 1 to 2.8 — 已归档

**归档文件**: `.claude/archive/progress-phase1-to-2.8-2026-03-11.md`
**摘要**: Foundation → Core loop → Init hardening → Deck modes → Input protection + Signal simplification → Skill overhaul → 30+ incremental fixes

### Wave C to E — 已归档

**归档文件**: `.claude/archive/progress-wave-c-to-e-2026-03-11.md`
**摘要**: SQLite migration → Sessions/Archives 合并 → Lifecycle simplification（DeckStatus 6→4 值）→ Stop→Resume E2E

---

## Architecture (POST-PHASE-B)

```
Project Layout:
  booth-project/                     (文件系统命名空间，非 git)
  ├── booth/                         (代码仓库，npm package)
  │   ├── skill/                     CC Skill (SKILL.md + references/)
  │   ├── runtime/                   代码 runtime (boot.md + scripts/)
  │   ├── src/ → dist/               TypeScript → compiled
  │   └── bin/                       CLI entry + editor proxy
  ├── booth-backstage/               (私有文档仓库)
  ├── booth-dj/                      (DJ skill 独立仓库)
  └── booth-deck/                    (Deck skill 独立仓库)

Signal Flow:
  Deck completes → JSONL turn_duration → idle
  → Reactor.onDeckIdle() → runCheck()
  → No report? → [booth-check] "Follow the booth-deck self-verification protocol"
  → Deck review loop → `booth report` CLI → IPC → SQLite
  → notifyDj() → [booth-alert] via protectedSendToCC (Ctrl+G)

Three Skills:
  booth       (~61 行)  共享词汇：信号表、模式表、CLI 速查
  booth-dj    (~177 行) DJ 管理手册：alert/beat 响应、deck 管理、report 审核
  booth-deck  (~215 行) Deck 执行协议：check EP、review loop、report 格式
```

---

## Phase Status

| Phase | Status | Description |
|-------|--------|-------------|
| 1–2.8 | Done | Foundation → Core loop → Modes → Signal simplification |
| Wave C–E | Done | SQLite → Lifecycle simplification → Stop→Resume E2E |
| Identity + Quality | Done | 双重寻址 + 10 bug fixes |
| Phase A | **Done** | Compaction + Worktree + Guardian + Merge + Report DB |
| Phase B | **Done** | Skill 架构改造 + 目录重组（Step 8 pending） |
| Phase C | Queued | 产品打磨 — UIUX、Token 统计、产品命名 |
| Phase D | Queued | 市场定位 — 竞品分析、README/定位 |
| Phase E | Queued | 发布 — npm publish + 博客宣发 |
| Phase F | Outlined | 平台化 — Agent API、Codex、跨工具集成 |
| Phase G | Idea | booth-api — REST API 封装 |

---

## Pending Items — Phase C–G 路线图

详细调研内容保留原文，供未来 session 继续探索。

### Phase C: 产品打磨 — 用户体验可交付

> 目标：UIUX 达到可交付标准。

**C1. UIUX 打磨**

**已知 UX 痛点**：

- **CLI 交互模式单一**：当前 17 个命令全部是"执行一次退出"模式。没有 interactive/dashboard 模式
- **错误信息不友好**：CLI 错误只输出 Usage + exit(1)，没有上下文提示
- **`booth ls` 信息密度低**：只显示 mode/status/时间。缺少：当前 prompt 摘要、check 进度、report 状态
- **Report 展示**：`booth reports` 列表缺少摘要预览；`booth reports <name>` 输出纯 markdown 到 stdout，没有语法高亮或分页
- **`booth peek` 信息有限**：只看最后 N 行 tmux 输出，无法区分 CC 输出 vs 用户输入 vs 工具调用
- **缺少 `booth dashboard`**：一个持续刷新的 TUI，实时展示所有 deck 状态、DJ 状态、最近 alert

**成功标准**：新用户 5 分钟内能理解 booth 工作流；日常操作不需要反复输入查询命令。

- [ ] booth 指令交互打磨（参考老 booth 取精华去糟粕，推陈出新）
- [ ] Report 系统展示优化（摘要预览、语法高亮、分页）
- [ ] 整体用户流程优化（错误提示、fuzzy match deck 名、命令补全）

**C2. Token 统计**（精简版 Attention Management）

**已知信息**：

- CC JSONL 中 `type: "assistant"` 消息包含 `message.usage` 字段（input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, service_tier）
- `SignalCollector`（`src/daemon/signal.ts`）已在 tail JSONL——可同时提取 token 数据，零额外 I/O
- 数据存储可复用 SQLite（sessions 表加列或新建 token_usage 表）

**未知/困惑**：

- CC session resume 后 token 计数是否重置？（JSONL 追加，usage 每 turn 独立，需要累加）
- `cache_read_input_tokens` 是否应计入总量？
- Codex 的 token 统计 UI/UX 值得参考

**成功标准**：`booth ls` 显示每个 deck 的累计 token 消耗；`booth kill` 时显示总消耗。

- [ ] 在 SignalCollector 或 reactor 中累加 token 用量
- [ ] 存入 SQLite
- [ ] `booth ls` 和 `booth kill` 显示 token 统计

**C3. 产品命名重新评估**

- [ ] Booth 语音输入易误识别为 Boost，评估替代名称（不阻塞技术开发）

---

### Phase D: 市场定位 — 知道自己是谁

- [ ] D1: 2026 新竞品调研 + 与老 booth signal 思想对比
- [ ] D2: README + 定位（必须在竞品分析后确定）

---

### Phase E: 发布 — npm + 宣发

**E1. npm publish**

hook 点已就位：`src/cli/index.ts` 的 `case undefined:` 分支

- [ ] npm publish 准备（package.json 审查、README、LICENSE、prepublishOnly script）
- [ ] `src/version.ts` — getCurrentVersion() + checkForUpdates()
- [ ] bare `booth` 版本检查（npm registry fetch，5s timeout，失败静默跳过）

**E2. 博客 / 宣发**

- [ ] 发博客造势 + signal 思想沉淀
- [ ] 在 Phase D 定位确认后执行

---

### Phase F: 平台化 — 给 agent 用

> booth 主要是给 agent 用，人也可以用但不是主要服务对象。

- [ ] Agent-as-consumer API — 其他 agent 如何调用 booth
- [ ] Codex 支持探索
- [ ] 跨工具集成（CC/OpenClaw 直接调用）

---

### Phase G: booth-api — 把交互式 CC session 变成 REST API

> 利用 booth 的 tmux + editor proxy 架构，对外暴露 OpenAI-compatible HTTP API。每个请求分配交互式 CC deck，天然 `entrypoint=cli` + `isInteractive=true`。

**背景（2026-04-05）**：Anthropic 4月4日起 `claude -p` 走 Extra Usage 而非订阅额度。booth 的交互式 deck 天然不受此限制。booth-api 核心价值：把"交互式特权"封装成标准 API。

**架构**：
```
POST /v1/chat/completions
  → Auth → 路由到 deck pool
  → 找空闲 deck / spin 新 deck
  → editor proxy 注入用户消息
  → 监听 JSONL 输出 → Stream SSE 响应
  → deck 回到空闲池
```

**与 cc-gateway 的关系**：booth-api 解决应用层（session 编排），cc-gateway 解决网络层（指纹归一化）。

**核心待办**：
- [ ] HTTP API 层（Express/Hono，OpenAI-compatible 格式）
- [ ] Deck pool 管理（空闲检测、自动扩缩、健康检查、最大并发数）
- [ ] JSONL → 结构化 API response parser
- [ ] SSE streaming（匹配 OpenAI stream format）
- [ ] Session 复用策略（context 累积 vs 隔离）
- [ ] API 认证 + rate limiting
- [ ] 与 cc-gateway 集成

**已有基础设施可复用**：deck spin/kill/send、editor proxy、JSONL watcher、Guardian、SQLite

---

## Known Bugs

### BUG-002: booth kill 不清理 tmux window — 无法复现 (2026-04-12)

E2E 重测时无法复现。当前代码 `kill-pane` 对 single-pane window 正确连带清理 window。Idle deck + checking deck 都测过。怀疑上次 session 的 stale daemon / 旧编译代码导致。如果再次出现，需要捕获具体复现条件。

### BUG-001: Compaction 打断 alert 链路 — 部分解决

已有防护：PreCompact hook + CLAUDE.md Compact Instructions + Beat 兜底。
待实现：PostCompact hook（等 CC 上游 #14258）。
详见归档：`.claude/archive/progress-phaseA-B-2026-04-07.md`

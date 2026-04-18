# Booth v2 — Progress

> Current execution state. Read this first when starting a session.

## 当前位置：Hardening 尾声 — 核心通了，文档和校验规则还有洞

### booth 是什么（一句话）

一个 CLI 工具，让 Claude Code 同时跑多个并行任务（"deck"），由 AI 项目经理（"DJ"）统一调度、自动质检、汇报结果。用户只管提需求，booth 管执行。

### 核心机制健康状态

| 机制 | 状态 | 说明 |
|------|------|------|
| **CLI 命令集** (23 个) | ✅ 健全 | spin/kill/resume/ls/peek/send/reports 全部可用 |
| **Daemon + IPC** (25 个命令) | ✅ 健全 | 进程间通信稳定，Unix socket |
| **信号检测（JSONL tail -f）** | ✅ 健全 | deck idle/working 状态检测，非 polling 而是事件驱动 |
| **信号检测（Stop hook）** | ✅ 新增可用 | CC turn 结束时触发，比 JSONL 更快更准确 |
| **自动 check 流程** | ⚠️ 流程通但文档有误 | daemon 发 `/booth-check` → deck 自验 → 提交 report → 通知 DJ 全链路通。但 check.md 仍用 `[bracket]` 格式（实际是 `/slash`）、要求 deck 写 progress.md（会卡权限）、status 值不做校验 |
| **Skill 注册** (7 个) | ✅ 健全 | booth/booth-dj/booth-deck + 4 signal skills，symlink 全正确 |
| **Worktree 隔离** | ✅ 健全 | spin pre-create worktree + settings.json symlink |
| **Hook 体系** (4 个) | ⚠️ 部分可用 | Stop hook ✅ 在 worktree 里触发。SessionStart hook ❓ worktree 里未观察到触发（不阻塞主流程，daemon 有 JSONL fallback）。SessionEnd/PreCompact 未单独验证 |
| **Report 存储（SQLite）** | ✅ 健全 | booth.db 存 sessions + reports |
| **编译** | ✅ | `npx tsc` 0 error, dist/ 与 src/ 同步 |

### 上一轮做了什么 (2026-04-10 ~ 2026-04-18)

**已合并到 main 的代码修复**：

| 修复 | commit | 验证 |
|------|--------|------|
| ccProjectsDir() 编码 `.` 字符 | 3a4590f | E2E: daemon 正确找到 JSONL |
| 4 个 signal skills 注册为 CC skill | 0861135 | E2E: /booth-check 不再报 "Unknown skill" |
| isInitialized() 检查双目录 | 13093fb | E2E: booth init 不再假报 "already registered" |
| `--task` 作为 `--prompt` 别名 | 840030f | E2E: spin --task 正确送入 prompt |
| registerBoothSkills() 双目录注册 | 13093fb | 同上 |
| CC Stop hook 替代 JSONL idle 检测 | 98d595c | E2E: daemon log `deck idle (stop hook)` |
| Worktree settings.json symlink | 6344056 | E2E: JSONL `stop_hook_summary.hookCount: 2` |

**E2E 验证的真实状态**：
- **10 项结构 checklist**：全部 PASS（skill 注册、signal 格式、boot.md、init 输出等）
- **核心 happy path**：spin → idle → /booth-check → self-verify → report → /booth-alert → DJ 通知，**一条线跑通**
- **完整 10 项 checklist 重跑**：❌ 未做。只验证了关键路径，没有系统性 rerun
- **SessionStart hook in worktree**：❓ 未解释为什么不触发，session-changed IPC = 0

**详细归档**：`.claude/archive/progress-phaseB-hardening-2026-04-18.md`

### 还没修的已知问题（进入 Phase C 之前必须完成）

1. **check.md 文档错误 + 流程问题**
   - 信号格式写的 `[booth-check]`，实际 daemon 发的是 `/booth-check`（全文 7 处）
   - `Progress: Required` 完成维度要求 deck 写 progress.md，但 CC 对 `.claude/` 有硬权限规则会卡住
   - 设计决策已定：progress.md 只 DJ 写，deck 不碰

2. **`booth report` 不校验 status 值**（BUG-003）
   - CLI 接受任意字符串，daemon 只认 SUCCESS/FAIL/FAILED/ERROR/EXIT
   - Deck 用了 DONE → daemon 永远认为 check 没完成，死循环 polling

3. **SessionStart hook 不触发**（worktree 里 session-changed IPC = 0）
   - 不阻塞主流程（daemon 靠 JSONL polling 补偿），但说明 hook 体系仍不完整

### 设计决策（本轮确定，待实施）

**D1. Progress.md 所有权**
- progress.md 是 project-level rollup，**只有 DJ 写**
- Deck 可以读（了解自己在大盘里的位置），但不写
- Deck 的 "progress" 就是它的 report + commit；DJ 读 report 后翻译成 progress.md 条目
- **类比**：员工交周报 = report，HR 更新组织路线图 = progress.md

**D2. Worktree 策略**
- 有 `.git` → **始终开 worktree**（避免 option 1 "补建 worktree" 的不可能——跑着的 CC session 无法搬家）
- 没 `.git` → 不开 worktree，直接 cd
- Worktree 位置：开在**目标 git repo** 的 `.claude/worktrees/` 下（不是 workspace 根）
- 中期目标：加 `booth spin --cwd X` 模式，让 deck 指定目标目录（支持 multi-project workspace）

**D3. Signal Flow 双轨制确立**
- **主信号**：Stop hook（CC turn 结束时触发，语义精确，零延迟）
- **Fallback**：JSONL tail -f（daemon 持续读 JSONL 事件流，补偿 hook 未触发场景）
- 两者通过 `updateDeckStatus()` 内建去重，先到先赢
- **研究报告**：`/Users/yuhaolu/motifpool/booth-project/booth-backstage/research/jsonl-vs-hooks.md`

### 设计决策（本轮确定，待实施）

**D1. Progress.md 所有权**
- progress.md 是 project-level rollup，**只有 DJ 写**
- Deck 可以读（了解自己在大盘里的位置），但不写
- Deck 的 "progress" 就是它的 report + commit；DJ 读 report 后翻译成 progress.md 条目
- **类比**：员工交周报 = report，HR 更新组织路线图 = progress.md

**D2. Worktree 策略**
- 有 `.git` → **始终开 worktree**（避免 option 1 "补建 worktree" 的不可能——跑着的 CC session 无法搬家）
- 没 `.git` → 不开 worktree，直接 cd
- Worktree 位置：开在**目标 git repo** 的 `.claude/worktrees/` 下（不是 workspace 根）
- 中期目标：加 `booth spin --cwd X` 模式，让 deck 指定目标目录（支持 multi-project workspace）

**D3. Signal Flow 双轨制确立**
- **主信号**：Stop hook（CC turn 结束时触发，语义精确，零延迟）
- **Fallback**：JSONL polling（daemon 自己 tail JSONL，补偿 hook 未触发场景）
- 两者通过 `updateDeckStatus()` 内建去重，先到先赢
- **研究报告**：`/Users/yuhaolu/motifpool/booth-project/booth-backstage/research/jsonl-vs-hooks.md`

---

## Architecture (POST-HARDENING)

```
Project Layout:
  booth-project/                     (文件系统命名空间，非 git)
  ├── booth/                         (代码仓库，npm package)
  │   ├── skill/                     CC Skill (SKILL.md + references/)
  │   ├── runtime/                   代码 runtime (boot.md + scripts/)
  │   │   └── scripts/               hook scripts (session-start/end, pre-compact, stop)
  │   ├── src/ → dist/               TypeScript → compiled
  │   └── bin/                       CLI entry + editor proxy
  ├── booth-backstage/               (私有文档仓库)
  ├── booth-dj/                      (DJ skill 独立仓库)
  └── booth-deck/                    (Deck skill 独立仓库)

Signal Flow (dual-track):
  Primary:  Deck turn ends → CC Stop hook → stop-hook.sh → IPC deck-idle → Reactor
  Fallback: Deck JSONL → SignalCollector → parseEventState() → idle → Reactor
  Both →    updateDeckStatus(idle) [dedup] → onDeckIdle() → runCheck()
  →         /booth-check skill activation → Deck self-verify → booth report → SQLite
  →         notifyDj() → /booth-alert via protectedSendToCC (Ctrl+G)

Seven Skills (4 signal + 3 role):
  booth                (~61 行)  共享词汇：信号表、模式表、CLI 速查
  booth-dj             (~177 行) DJ 管理手册：alert/beat 响应、deck 管理、report 审核
  booth-deck           (~215 行) Deck 执行协议：check、review loop、report 格式
  booth-check          (signal)  Deck self-verification trigger
  booth-beat           (signal)  DJ periodic patrol
  booth-alert          (signal)  DJ notification (check complete / deck exited)
  booth-compact-recovery (signal) Context recovery after compaction

Worktree Symlinks (spin + resume):
  .booth/                  → main .booth/          (daemon, DB, logs)
  node_modules/            → main node_modules/    (build tools)
  .claude/settings.json    → main settings.json    (hooks config) [NEW]
```

---

## Phase Status

| Phase | Status | Description |
|-------|--------|-------------|
| 1–2.8 | Done | Foundation → Core loop → Modes → Signal simplification |
| Wave C–E | Done | SQLite → Lifecycle simplification → Stop→Resume E2E |
| Identity + Quality | Done | 双重寻址 + 10 bug fixes |
| Phase A | Done | Compaction + Worktree + Guardian + Merge + Report DB |
| Phase B | **Done** | Skill 架构改造 + 目录重组 + E2E 验证 + Stop hook 迁移 |
| **Hardening** | **Done** | 5 bug fixes + worktree hook fix + check.md/report 修订（待做） |
| Phase C | **Next** | 产品打磨 — UIUX、Token 统计、产品命名 |
| Phase D | Queued | 市场定位 — 竞品分析、README/定位 |
| Phase E | Queued | 发布 — npm publish + 博客宣发 |
| Phase F | Outlined | 平台化 — Agent API、Codex、跨工具集成 |
| Phase G | Idea | booth-api — REST API 封装 |

---

## Known Bugs

### BUG-003: `booth report` 不校验 status 值 — 待修

`booth report --status <X>` 接受任意字符串。Daemon 的 `TERMINAL_STATUSES` 只认 `{SUCCESS, FAIL, FAILED, ERROR, EXIT}`。Deck 用了 `DONE` → daemon 认为 check 永未完成 → 持续 polling。需要 CLI 端加 whitelist validation。

### BUG-002: booth kill 不清理 tmux window — 无法复现 (2026-04-12)

E2E 重测时无法复现。如再现，需要捕获具体复现条件。

### BUG-001: Compaction 打断 alert 链路 — 部分解决

已有防护：PreCompact hook + CLAUDE.md Compact Instructions + Beat 兜底。
待实现：PostCompact hook（等 CC 上游 #14258）。
详见归档：`.claude/archive/progress-phaseA-B-2026-04-07.md`

---

## Archived Phases

| 归档文件 | 内容 |
|---------|------|
| `.claude/archive/progress-phase1-to-2.8-2026-03-11.md` | Foundation → Core loop → Modes → Signal simplification |
| `.claude/archive/progress-wave-c-to-e-2026-03-11.md` | SQLite → Lifecycle simplification → Stop→Resume E2E |
| `.claude/archive/progress-phaseA-B-2026-04-07.md` | Compaction + Worktree + Guardian + Phase B 设计决策 |
| `.claude/archive/progress-phaseB-hardening-2026-04-18.md` | Phase B E2E 验证 + 5 bug fixes + Stop hook + Worktree hook fix |

---

## Pending Items — Phase C–G 路线图

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

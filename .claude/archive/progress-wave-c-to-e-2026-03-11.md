# Booth v2 — Archived Progress: Wave C to E

> Archived on 2026-03-11. Original content from `.claude/progress.md`.

### State Layer Audit Findings (2026-03-06)

> 完整报告：`.booth/reports/state-audit-2026-03-05-1622.md`、`.booth/reports/dj-lifecycle-2026-03-05-1622.md`

**关键发现**：deck status 实际上已持久化（DeckInfo 整体序列化）。问题不是"状态不持久化"，而是：

1. **djStatus 不触发 markDirty** — 30s 内 daemon crash 会丢失 DJ 状态（state.ts:113-117）
2. **restore 后 status 可能过时** — deck 显示 working 但实际 idle，dedup 阻止 watcher 纠正（state.ts:77）
3. **archives 不区分 killed/stopped** — resume 盲目恢复所有 archive，导致僵尸窗口堆积
4. **DJ 退出无人知晓** — session-end-hook 显式跳过 DJ（session-end-hook.ts:109-110），daemon 不知道 DJ 死了
5. **DJ 无 health check** — startHealthCheck() 只遍历 decks，不检查 DJ pane
6. **djStatus 只有 idle/working** — 无法表达 stopped/exited/error
7. **session-changed 不更新 djSessionId** — context 满后新 session ID 未存，resume 用旧 ID
8. **shutdown 不重置 djStatus** — restore 时读到旧 working 状态
9. **reactor 内存状态不恢复** — error recovery timer、plan mode approve 重启后丢失

**SQLite 迁移评估**（`.booth/reports/sqlite-assess-2026-03-05-1624.md`）：
- better-sqlite3 推荐：同步 API、ACID、crash-safe、有 prebuild
- 核心只改 1 个文件（state.ts），公共 API 不变
- 附带消除 archive sharding + debounce + safeWrite

**已完成 TODO**：
- [x] State → SQLite 迁移（state.ts 内部实现替换，公共 API 不变）— c239ae0
- [x] archives 加 exit_reason 字段 + resume.ts 读 SQLite（9010c57）
- [x] DJ 一等公民化：sessions 表 role='dj' + registerDj/getDj/updateDj/removeDj + 完整状态集
- [x] DJ 退出检测：session-end-hook 覆盖 DJ（dj-exited IPC）+ health check 覆盖 DJ pane
- [x] 战时模式（.booth/warroom 文件存在时追加到 DJ system prompt）— 89f1151
- [x] spin 同名 deck 拒绝：spin.ts 查询 status IPC 检查同名活跃 deck — e621251

### Restart Double LaunchDJ Fix (COMPLETE — 2026-03-08)

- [x] 提取 `resumeAllDecks()` 从 `resumeCommand` — 只恢复 deck，不启动 DJ/attach
- [x] `restart.ts` Phase 3 改用 `resumeAllDecks` 替代 `resumeCommand([])`，消除第二次 `launchDJ` 调用

### D-merge: Sessions/Archives Single Table (COMPLETE — 2026-03-08)

- [x] 合并 sessions + archives 为单表，lifecycle 列区分 active/archived
- [x] autoincrement rowid 替代 text id 作 PK
- [x] archiveDeck/archiveDj 原子 UPDATE（替代 INSERT archives + DELETE sessions）
- [x] DJ shutdown archive 保留 sessionId（不再 removeDj 丢数据）
- [x] partial unique index（同名 deck 仅一个 active，archived 不限）
- [x] 旧 schema 自动迁移（检测 id TEXT PK → 迁移 → DROP archives）
- [x] resume.ts/session-end-hook.ts 适配新 schema
- [x] sub-agent review: 修复 archive 查询缺 `role='deck'` 过滤（DJ 行混入 resume 列表）

### Wave E — Signal-Reactive Lifecycle Simplification (COMPLETE — 2026-03-11)

> **价值**：简化状态机、统一退出逻辑、修复 resume 核心缺陷。做完后 booth 的生命周期管理从"能用但脆弱"变成"简洁且健壮"。stop→resume 全链路可靠，DJ 作为系统内核自动恢复。

#### E1. 状态模型简化 (代码完成，编译通过，部分 E2E)

**改动**：11 文件，净减 159 行
- DeckStatus: 6 值 → 4 值（`working | idle | checking | exited`）
- 删除：`ExitReason`、`ArchivedDeck`、`Lifecycle` 类型
- 删除：error/needs-attention 信号处理
- shutdown 不改 deck status（保持 working/idle 供 resume）
- resume 从 INSERT 改为 UPDATE（不累积 DB 行）
- `archiveDeck` → `exitDeck`，`archiveDj` → `exitDj`
- 文档：signals.md/mix.md/SKILL.md/README.md 更新

**退出信号 6 场景分析（已验证设计健壮性）**：

| 场景 | SessionEnd hook | DJ 通知 | Status 变化 |
|------|----------------|---------|-------------|
| A. `booth kill` | 触发但 exitDeck 已先执行 → 静默 | 无 | → exited |
| B. CC 自行退出 | 触发 → deck-exited IPC | 有 | → exited |
| C. `tmux kill-pane` | 触发 → deck-exited IPC | 有 | → exited |
| D. `booth stop` | 触发但 daemon 已死 → 静默 | 无 | 不变 |
| E. `kill -9 <CC>` | 不触发（SIGKILL） | 无 | pruneStaleDecks 兜底 |
| F. `kill -9 <daemon>` | N/A | N/A | deck 继续，新 daemon 接管 |

#### E2. 文档沉淀 — 退出信号 + Stop 原则 (dd77073)

- 退出信号 A-F 完整路径 → `skill/references/signals.md`
- Stop 限制原则 → `skill/templates/mix.md` + `skill/references/child-protocol.md`
- Stop/reload/restart/kill 决策树 → mix.md
- `.booth/mix.md` 同步（决策树 + stop 原则段落）

#### E3. Resume 恢复 DJ (63de30f)

- `resumeAllDecks` 新增 DJ resume：读 `sessions WHERE role='dj' AND status != 'exited'`，传 sessionId 给 `launchDJ`
- 返回 `{ djResumed: boolean }`，callers 据此决定是否 fallback 到新 DJ
- `bareBoothCommand`、`restartCommand`、`resumeCommand` 三个入口全部适配
- `readDjSessionIdFromState` 增加 `status != 'exited'` 过滤（killed DJ 不恢复）
- 包含 D-merge resume 清理（archive → status-based）

#### E4.5. pruneStaleDecks 修复 (02d2233)

- pruneStaleDecks 不再调 exitDeck，改为 clearPaneId（deck 保持 working/idle 供 resume）
- healthCheck 增加 `!deck.paneId` guard，避免 pane 清空后每 30s 产生无意义告警
- 核心修复由 cb61b9c（lifecycle simplification deck）完成，本 deck 补充 healthCheck guard

#### E4. Stop --clean 对齐 (dc1fdcf, 94d0be7)

- stop 和 restart 的 --clean 参数对齐
- stop 默认保留状态，`--clean` 设所有 deck 为 exited
- shutdownClean() 先 exitAllDecks() + exitDj() 再 shutdown()

#### E5.1. Unconditional Resume + ls -a + Dead Code Removal (8675d12, 38bf765)

- `booth resume <name>` 无条件恢复 — 不再过滤 exited 状态
- `readDeckForResume()` 查询无 status 过滤，取 `ORDER BY updated_at DESC LIMIT 1`
- `resumeAllDecks()` 保持不变（仅 non-exited，系统自动恢复）
- 两条 resume 路径共享 `resumeOne()`，但选择标准独立
- `state.resumeDeck()` 改用 rowid 子查询匹配（不再排除 exited）
- `booth ls -a` / `--all` — 直接读 DB（无需 daemon），显示全部 deck 含 exited
- `booth resume --list` 显示全部 deck（含 [exited] 标记）
- 删除 dead DELETE 代码：`state.removeDeck()`、`state.clearAllDecks()`、`state.removeDj()`
- Records persist forever — 所有退出操作均为 UPDATE status='exited'，无 DELETE
- 设计文档：`.booth/reports/lifecycle-design-detail.md`（event-state matrix）
- Skill docs 更新：signals.md（record persistence）、cli.md（ls -a, unconditional resume, stop --clean）
- 碰文件：state.ts, resume.ts, ls.ts, cli/index.ts, signals.md, cli.md

#### E5.2. session_id 持久化修复 (7b2adb1)

- 三个 bug 导致 deck session_id 永远为 NULL：
  1. spin.ts 漏掉 sessionId 字段 → registerDeck 存 NULL
  2. session-start-hook 检查 state.json（已迁移）→ hook 静默退出
  3. session-changed handler 忽略 msg.sessionId → 从不更新 DB
- 修复：spin 时写入 + hook 检查 booth.db + handler 提取并存储 sessionId
- 碰文件：spin.ts, daemon/index.ts, session-start-hook.ts

#### E5. Stop→Resume E2E 验证 (2026-03-11, 用户手动)

- booth stop → DB status 保持 idle（不变） → booth resume → DJ + deck 全部恢复
- 修复 ghost deck bug（7eb7092）：resumeOne 跳过无 pane 的缓存幽灵
- 验证项：deck 存活、canary 文件保留、DB 行数不增长（UPDATE 不 INSERT）、ls -a -n limit

### ls-improve: booth ls shows DJ + limit flag (COMPLETE — 2026-03-10)

- [x] `booth ls` 显示 DJ 作为第一行（`[DJ]` icon），IPC `ls` 返回 dj 字段
- [x] `booth ls -a` 包含 DJ 行（`role='dj'`），SQL 按 DJ-first 排序
- [x] `-n <limit>` / `--limit` flag，默认 20 条，超出显示 footer 提示
- [x] cli.md 文档更新
- [x] 碰文件：ls.ts, daemon/index.ts, skill/references/cli.md

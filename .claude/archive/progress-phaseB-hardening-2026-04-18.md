# Phase B Hardening — Archived Progress (2026-04-10 ~ 2026-04-18)

> Archived from `.claude/progress.md`. Original text preserved verbatim.

## Phase B 完成记录 (2026-04-07)

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

## Stop Hook — Primary Idle Signal (2026-04-12)

- [stop-hook-v1] CC Stop hook 替代 JSONL 作为主 idle 信号源
  - `runtime/scripts/stop-hook.sh` + `src/stop-hook.ts` — hook 脚本 + handler
  - `src/daemon/index.ts` — `deck-idle` IPC handler（DJ/deck 分支）
  - `src/hooks.ts` — `ensureStopHook()` / `removeStopHook()`
  - CLI start/stop/restart 注册/注销
  - JSONL SignalCollector 保留为 fallback（`updateDeckStatus` 内建去重）

**E2E 验证暴露更底层问题** (2026-04-13)：spin 新 deck 后 daemon log 未见 `deck-idle` 事件，只有老的 JSONL polling 路径。排查发现 CC 在 worktree 里根本不读 main project 的 `.claude/settings.json` — git worktree 是独立 git root，CC settings 发现止步于此。

**含义**：booth 所有项目级 hook（SessionStart / SessionEnd / PreCompact / Stop）从未在 deck worktree 里触发过。`grep session-changed .booth/logs/daemon-*.log` 零命中。之前所有 E2E "hook 正常"都是误报——整个 deck 侧信号链路靠 daemon 自己 polling JSONL 支撑，hook 对 deck 是完全死的。只有 DJ（在 main project root 运行）的 hook 是活的。

**修复**：在 worktree 里 symlink `.claude/settings.json` → main project 的同名文件。

- [worktree-settings-symlink] 已完成 (commit 6344056)
  - `src/worktree.ts` — `ensureSymlinks()` 增加 `.claude/settings.json` symlink；`ensureSymlink()` 升级为校验 target 并替换过期 symlink；`removeWorktree()` 同步 unlink
  - `src/cli/commands/spin.ts` — 改为 booth 自己 `createWorktree()` pre-create worktree，tmux 直接以 worktree 为 cwd，丢掉 `--worktree` flag
  - Resume 路径自动覆盖（`ensureWorktree → ensureSymlinks`）

**E2E 验证通过** (2026-04-13)：spin test-hooks deck → daemon log 出现 `deck "test-hooks" idle (stop hook)` → JSONL `stop_hook_summary.hookCount: 2`（user-level + booth）。Booth 历史上第一次 project-level hook 在 deck worktree 里成功触发。

## Hardening (2026-04-10)

E2E checklist 准备阶段发现的安全 + 启动问题，三处修复：

- **DJ 自杀防护**：`stop.ts` / `restart.ts` 增加 `BOOTH_ROLE === 'dj'` 拦截。这两个命令会 kill SESSION="dj" 整个 tmux session — 从 DJ 自身 pane 调用等于自杀（CC 进程消失，看似"突然退出"）。原 deck 拦截已存在，DJ 拦截缺失。
- **Deck CC 嵌套启动解封**：4 处 `editorSetup`（spin / resume / start / daemon guardian）前缀加 `unset CLAUDECODE`。CC 检测到 `CLAUDECODE=1` 拒绝启动嵌套 session — DJ pane 内 spin 出来的 deck pane 继承了该变量，导致 deck CC 直接报错退出。
- **保留**：`booth reload` 当时复现失败已无法重现（连续 4 次成功）。`gracefulReload` 缺第二行 log 是 winston 异步 buffer 在 `process.exit(0)` 前未 flush 所致，纯 cosmetic。

清理：旧路径 `~/motifpool/booth/booth/` 的僵尸 daemon (PID 81994, 自 3/26 运行) 终结；本项目残留的 stale tmux socket 清除。

## E2E Clean Pass (2026-04-12)

5 个修复合并到 main 后重跑完整 E2E checklist，**结构性 + 功能性全 PASS**：

- **Bug 1 (dot encoding)** — `ccProjectsDir()` 编码 `.` 字符，daemon 正确找到 JSONL，idle 检测生效（commit 3a4590f）
- **Bug 2 (signal skills)** — 4 个 signal skills 注册为 CC skill，`/booth-check/beat/alert/compact-recovery` 不再报 "Unknown skill"（commit 0861135）
- **Bug 3 (init false-positive)** — `isInitialized()` 检查 global + project-local 双目录（commit 13093fb）
- **Bug 4 (--task alias)** — `booth spin --task` 作为 `--prompt` 别名（commit 840030f）
- **Bug 5 (init dual-directory)** — `registerBoothSkills()` 双目录注册（commit 13093fb）

完整链路验证：`booth spin → deck idle → daemon /booth-check → deck self-verify → booth report → daemon /booth-alert → DJ`，每一步都有 daemon log 证据。

`.booth/` 清理 7 个 Phase A/B 遗留文件（mix.md, beat.md, finalize-plan.md, state.json.migrated, test-guide-resume.md, deck-archive.json, alerts.json）。

**BUG-002 (booth kill 不清 tmux window) 无法复现** — 当前代码 `kill-pane` 对 single-pane window 正确连带清理 window。Idle deck + checking deck 都测过。可能是上次 session 的 stale daemon 导致。

## Bug 暴露：`booth report --status` 不校验

Deck 用 `--status DONE` 提交 report，daemon 的 `TERMINAL_STATUSES` 只认 SUCCESS/FAIL/FAILED/ERROR/EXIT，导致 daemon 永远不认为 check 完成、持续 polling。临时解法：手动 `UPDATE reports SET status='SUCCESS'`。

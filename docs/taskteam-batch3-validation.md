# 任务小组 阶段二 · 批3 运行时 + 驱动层 — 验证记录

目标：按 v3.1 §3.1 / §4 落地运行时 + 驱动层——建群 / kickoff / observer-tick / dispatcher-tick（复制 subtask 范式）+ daemon 三注册块（IPC 事件入口 + observer cron + dispatcher cron），对 subtask 调度零侵入。

## 交付物

**新增文件（taskteam-*，复制范式，不 import subtask-store）**
- `src/services/taskteam-runtime.ts` — 驱动核心 `applyTeamEvent`（事件→引擎→原子落状态增量→enqueue 投递命令）+ `createTaskTeam`（建群→落实例→驱动 team-started）。依赖注入，纯逻辑可单测。
- `src/services/taskteam-dispatcher.ts` — `runTaskTeamDispatcherTick`：从 outbox claim(lease)→注入 send→ sent(message_id)→指数退避重试→达 maxRetry 落 failed；CAS attemptId 防迟到覆盖。
- `src/services/taskteam-observer.ts` — `runTaskTeamObserverTick`：复制 observer 范式，无 LLM 廉价 gate（peek 比 cursor，无新动静零模型调用）→ 有动静才注入 detect → applyTeamEvent → 推进 cursor。
- `src/services/taskteam-deps.ts` — DI 默认 wiring（接批1 store + 批2 引擎 + group-creator）。
- `src/services/taskteam-dispatch-executors.ts` / `taskteam-observe-executors.ts` — IO 边界（飞书发送 / 消息 peek）。

**批1 store 追加（纯新增函数，不改既有行为）**
- `taskteam-store.ts`：`applyTeamDecisionState`（落引擎 status/reviewState/cursor 增量）+ `listActiveTaskTeams`（observer 扫描活跃实例）。

**daemon.ts 三注册块（§3.1，纯 additive：85 insertions / 0 deletions）**
- IPC 事件入口：`POST /api/taskteam-event`（角色行为/生命周期事件 → applyTeamEvent）、`POST /api/taskteam-create`（建小组）。
- taskteam observer cron（独立 TASKTEAM_OBSERVE_TICK_MS + inFlight guard + runTaskTeamObserverTick）。
- taskteam dispatcher cron（独立 TASKTEAM_DISPATCH_TICK_MS + inFlight guard + runTaskTeamDispatcherTick）。

**单测**
- `test/taskteam-runtime.test.ts`（6）：applyTeamEvent 驱动+落状态+入 outbox / 重放幂等 / 缺实例报错 / createTaskTeam 建群+kickoff+running / observer 廉价 gate 零 detect / observer 有动静 detect+cursor 推进。
- `test/taskteam-dispatcher.test.ts`（5）：claim→send ok→sent(message_id) / 可重试失败→退避重投 retryCount+1 / 不可重试→failed / 重试预算耗尽→failed / 空 outbox no-op。

## 复用边界与红线#1（已逐项核实）

- **直接调** `createGroupWithBots`（通用导出、grep 确认不 import subtask-store、不写 subtasks.json）。
- **复制范式**写 `taskteams.json` / `taskteam-outbox.json`（批1 store），全程不 import / 不改 `subtask-store` / 任何 `subtask-*`。
- **daemon.ts 仅新增**：2 个独立 cron（与 subtask observer/dispatcher cron 平行）+ 1 组 IPC 路由（与 subtask IPC 分支独立）。`git diff src/daemon.ts` = **85 insertions / 0 deletions**，subtask 逻辑/分支一行未改。
- 未触碰 worker / 共享 worker 协议（per-role 模型透传是批4）。

## §3.1 三入口落地

1. **事件入口（命令触发）**：IPC `/api/taskteam-event` → applyTeamEvent → 决策只写 outbox（异步投递）。CLI 命令族本身属批5。
2. **observer cron**：daemon 新增独立 cron，廉价 gate 等价"事件触发休眠/零成本"。
3. **dispatcher cron**：daemon 新增独立 cron，claim/lease/退避/CAS，与 subtask outbox-dispatcher 完全隔离（独立 store/lease/cron/重试预算）。

> ack 语义（P2-1）：投递 ack = 飞书发送成功（message_id），即 sent 终态；角色"回复"经 observer/事件入口变成新 TeamEvent 回引擎，与投递层解耦。

## 主动标注的边界（供架构师 / 审查员判断）

1. **observer `detect` 判读层占位返回 `[]`**：把子群消息判读成角色行为 TeamEvent（§7 可能费模型）属后续细化；**批3 不伪造 LLM 判读**，只提供 observer 范式骨架（cron + 廉价 gate + cursor + applyTeamEvent 接线）。批3 主事件路径 = 显式 IPC 事件入口（角色行为经 CLI/IPC 上报，批5 接 CLI 薄壳）。
2. **投递 sender = coco/tilly bot**（cron 跑在 coco daemon，与 subtask 投递同址）；消息 @ 目标席位 bot 的 openId 触发其 session。
3. **驱动返回 TeamDecision 由 applyState 落库**：沿用批2 架构裁决（状态增量属纯核心、由薄驱动 apply）。
4. **taskteam-store 追加 2 函数**：批1 已关，仅追加 `applyTeamDecisionState`/`listActiveTaskTeams`，不改既有函数签名/行为。

## 验证命令

- `pnpm vitest run test/taskteam-stores.test.ts test/taskteam-engine.test.ts test/taskteam-runtime.test.ts test/taskteam-dispatcher.test.ts` → 26/26（批1 5 + 批2 10 + 批3 11）。
- `pnpm tsc --noEmit` → exit 0（含 daemon.ts 三注册块编译）。
- `git diff --check` → 通过。
- 红线#1：未改 `subtask-store.ts` / 任何 `subtask-*` / `subtasks.json`；daemon.ts 85+/0-。

## 两层 review 裁决与整改

**架构 review（架构师席，`TASK-TEAM-arch-review-batch3-r1.md`）：通过 ✓ 无 P1**——亲核 daemon.ts numstat 纯 additive、零改 subtask 分支、新文件不 import subtask-store、两 cron 单 daemon 拥有；§3.1 三入口 + §4 隔离 + observer detect 占位诚实性均认可。2 条非阻断 minor 见下。

**细节 review（审查员席，docx `IqE3d8JNao1QmoxzmVXc7g6Ln2e`）：P1+P2，已整改**

| 项 | 内容 | 处理 |
|-|-|-|
| **P1** | `applyTeamEvent` 非原子/串行化 apply 单元：状态先落库、outbox 后 enqueue。① 崩溃重放：状态已推进则同事件重放不再命中原规则 → 丢 request-review/report；② 并发审票：两 reviewer 同时 review-pass blind-replace → last-writer-wins 丢票、quorum 永不达成 | **重构 applyTeamEvent**：整个 read→decide→enqueue→advance 收敛进注入的 **per-team 锁**（默认跨进程文件锁 `taskteam-lock-<teamId>`，独立于 store 文件防重入死锁），且 **enqueue 先于状态提交**。并发事件串行化 → 不丢票；崩溃重放从"未推进状态"重算同决策 → 幂等 enqueue 去重 → 再提交 → 不丢命令、无孤儿（锁内无并发改态、决策不漂移）。observer advanceCursor 也走同锁。新增 2 单测：并发 review-pass 不丢票（quorum 达成 report）、enqueue 后崩溃重放无重复/无丢失。 |
| **P2** | dispatcher 忽略 `complete`/`release` 的 CAS 返回值，lease 竞争时把回写失败误统计为 sent/retried/failed | complete/release 检查返回值：CAS 被拒（返回 null / 未真正释放）记入新增 `leaseLost` 统计，不误报 sent/retried/failed；daemon 日志带 leaseLost。新增单测：lease 被偷 → leaseLost、不误写 sent。 |

**架构非阻断 minor**

| 项 | 内容 | 处理 |
|-|-|-|
| M1 | createTaskTeam 建群先于落库，落库失败有孤儿群风险 | 记录在案：当前接受（建群成功率高、孤儿群可人工/后续回收清理）；彻底事务化建群↔落库属后续，不阻断本批。 |
| M2 | observer detect 占位需在验证记录显式列为 §7 延后 scope | 已在本文「主动标注的边界 1」显式声明，确认。 |

整改后复验：`vitest` 29/29（批1 5 + 批2 10 + 批3 14）；`tsc --noEmit` exit 0；`git diff --check` 通过；红线#1 未破。

## 下一步

待审查员复审 P1/P2 + CEO 关后，批4：per-role 模型透传（独立 commit + 回归断言）。

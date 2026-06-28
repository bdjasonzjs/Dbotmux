# taskteam 控制流引擎化 · 阶段二「判读/动作去耦 + 计时触发器」

Goal: 在阶段一四内核（event registry / 配置 validator / 幂等键策略 / 显式 transition）之上，把**判读语义**和**动作集**从「只懂开发协作」去耦成可配置，并补上**计时/停滞触发器**，使「非开发型任务小组（如 MoA 定时监控）」能纯配置搭出。本阶段仍**不改变现有开发协作团队的对外行为**（拿 golden test 钉死）。

需求/设计：docx H6fBd8ZaOo6X3XxKWMXcPeANnte ＝ `~/work/Dbotmux-task-notes/taskteam-engine-design.md`（§5 阶段2 + §8 实现验收约束）。
前置：阶段一已完成并在 base 分支（四内核 commit 3f38766e）。

## Scope

- Base branch: `feat/taskteam-controlflow-engine`（阶段一，含四内核；**不是 master**——阶段一还没并主干）
- Feature branch: `feat/taskteam-controlflow-engine-phase2`
- Worktree: `/home/zoujinsong.jason/work/Dbotmux_wt/taskteam-controlflow-engine-phase2`（本群所有 bot 共用这一个）
- 边界：**无授权不 push、不 merge、不 daemon 重启、不部署**；停在 working tree / 本地 commit。
- **合并时机（松松指令 2026-06-28）**：全部阶段开发完 + 测试都过，才一起合回 master。阶段二也不单独合主干。

## Plan（阶段二四块）

1. **judge 受限数据槽配置化**：把判读 prompt 的「可判读事件集 + 描述 + 决策提示」下沉为 per-type **受限数据槽**（`eventDescriptions / decisionHints / outputEventRegistry`），由阶段一的事件 registry 驱动。**不开放完整 prompt**——system scaffold + `UNTRUSTED_DATA` 包裹 + 工具禁用 + JSON schema 校验**不可配置**（防注入面，§8 约束3/约束1 已要求 judge 输出带受限 `source`）。复用阶段一已扩展的 `TaskTeamJudgeFn` / `ctx.detectable`。
   - **事件级 attribution policy（reviewer 三轮 High · 做实项）**：每个事件类型带 `attribution: 'role' | 'external' | 'none'`（`TaskTeamEventDecl.attribution` + 内置默认表）。开发协作事件默认 `role`（归因不到 role instance 即丢，行为不变）；MoA 等自定义事件可声明 `external`/`none`，让**外部群普通人/非绑定 sender** 的消息也能产出业务事件（source-only：`source` 仍强制、`by` 可缺，不因缺 role 丢）。`mapBehaviorToEvent()` 按 policy 分流，并在产出的 `TeamEvent` 上**显式带 `attribution` 标记**——下游 engine/dispatcher 一眼识别有无 role actor，不靠 `fromRoleInstanceId` undefined 猜。validator 禁止 `external`/`none` 事件被依赖 `when.fromSlotId` 的 rule 引用（无可靠 fromSlot → error）。**这是「让 MoA 外部群消息能产出业务事件」的做实项**（根治「判读忽略外部参与者」）。
2. **新增领域无关动作**：`wake-role`（唤醒某角色席位）/ `notify`（通知某人/某群）/ `route-to-owner`（转交 owner）。
   schema 上补齐字段：目标类型、ack、可见性、root 唤醒、升级策略；**本阶段才扩 dispatcher**（阶段一刻意没扩）。
   **落地口径（reviewer High 修订）**：本阶段**做实** `targetType(slot/user/chat)` + `targetChatId` + `targetOpenId` + `ack`
   （notify 投到指定群/@人、route-to-owner @ owner open_id、ack 渲染「请回执」，可靠投递由 outbox 兜底）；
   `visibility / wakeRoot / escalation` + `targetType='owner'` 的 **root 唤醒/升级语义本阶段只占字段、不实现行为**（待阶段3/4 审批/值班状态原语）。
   **防注入**：`__delivery` 只允许由 `rule.action`（配置侧）写入，引擎 emit 时从 `event.payload` **剥除** `__delivery`，外部消息伪造的投递路由不生效。动作与状态跃迁仍走显式 transition、不隐式。
3. **计时/停滞触发器**：把 observer tick 的 stall gate 接到 `type.policy`，**复活 `escalateAfterStallMs`**（定义在 config-store/schema 但阶段一前是死配置）。
   stall 事件**只由 clock 产**（`maybeStallEvent`），**judge 不可产**（`stall` 已从 judge detectable 集移出，detect 显式丢弃 judge 输出的 stall）。
   停滞窗口锚用专门字段 `lastObservedActivityAt`（只在 cursor 推进=真实新活动时重置，**不被普通状态写入刷新**），故 stall rule 自带 transition 刷新 updatedAt 也不破坏「同窗只升级一次」。事件来源用 window/episode id（不退回 round）。归 **trigger 配置**。
4. **现有开发团队 seed 抽成具名 type**：把 `defaultTaskTeamSeed()` 的两层 review 形态抽成一份具名 type 配置，现有实例指向它。canonical `typeId(tt_type_two_layer_review)`/`roleId`/`slotId`/`ruleId`/`roleSlots` 顺序/policy **一律不动**；要新名字只加 display、否则补 migration/alias。

## Acceptance（硬门）

- **开发团队能力逐字不丢**：`deepEqual(defaultTaskTeamSeed())` 快照 + `planOnboarding()` 空 config 仍选 `tt_type_two_layer_review` 且 seats 顺序不变。引擎 4 个 special case 仍原样保留（阶段4 才声明化）。
- **judge 配置化不破防注入**：外部消息仍走 UNTRUSTED scaffold + 工具禁用 + 输出白名单 + `source` 只取系统别名；模板作者只能填受限数据槽、动不了安全骨架。`outputEventRegistry` **fail-closed**——只能收窄、交集空也不回退全集。
- **计时触发器真生效**：配了 `escalateAfterStallMs` 的 type，stall **只由 clock 真产出**（judge 不可伪造 stall）；用 `lastObservedActivityAt` 锚停滞窗、不撞幂等 key。
- **新动作可投递（口径收窄）**：`notify` / `route-to-owner`(@owner open_id) / `targetType=chat`(投外部群) / `ack` 经 dispatcher 真实投递、outbox 兜底可靠；动作不隐式触发状态跃迁。`visibility/wakeRoot/escalation` 字段预留、**本阶段不宣称具备 root 唤醒/升级语义**。
- **MoA 监控雏形可纯配置表达**（验证向，可放阶段三细化）：一份不声明 review 规则的 type，触发(定时/新消息)→判读(new-bug 受限槽)→notify 分析成员，连发多告警不丢事件。
- **外部群消息能产出业务事件（reviewer 三轮 High · 做实）**：`new-bug` 声明 `attribution='external'` 后，外部群非绑定 sender 的消息经 judge 判出 → detect 真产出 `TeamEvent`（带 `sourceEventId`、`attribution='external'`、无 `fromRoleInstanceId`）→ engine 命中 `when:{event:'new-bug'}` 的 notify 规则投递 analyst；不再 `detected=1 events=0`。安全不放松：external 事件 `source` 仍强制。

## Test Coverage（已落实 · 含 reviewer 二轮 5 项 + 三轮 attribution High 修复）

test/taskteam-controlflow-phase2.test.ts（29 例）：
- 块1 judge 配置化（4 例）：受限槽渲染进 ctx；**fail-closed**（registry 交集空→空允许集，不回退全集，submit 也被丢）；收窄后白名单外输出丢弃；无槽回退内置。
- **块1b attribution policy（4 例 · reviewer 三轮 High）**：external 事件 unknown sender 无 by → detect 真产出（带 sourceEventId/attribution=external、无 role）；下游 engine 命中 notify 规则投递 analyst + dispatch 不 NPE；external 缺 source 仍丢（防注入）；external 事件配 when.fromSlotId 的 rule → validator error。
- 块2 新动作（8 例）：notify 不隐式跃迁；连发多 new-bug 幂等 key 各异；rule.action 进 __delivery（含预留字段透传）；
  **防注入 High**：event.payload 自带 __delivery 无 rule.action→引擎剥除、路由不被篡改；rule.action 优先覆盖伪造值；dispatch @open_id+ack、targetType=chat 路由；validator 接受 3 命令。
- 块3 停滞触发器（6 例）：到点产 stall（window id=`stall:teamId:停滞锚 ts`）；未配/未到点不产；同窗稳定→幂等去重；
  **reviewer Medium**：锚用 lastObservedActivityAt，updatedAt 被刷新也不移动窗；observer tick gatedOut+到点→clock 产 stall→escalate 入队、stats.stalls=1。
- validator 阶段2 新增（3 例）：outputEventRegistry 全 typo→warning(empty+unknown) 非 error；timer 事件 transition 回可命中状态→error，指向终态 blocked→无 error。
- 块4 具名 type（4 例）：canonical id 不变；deepEqual seed.teamTypes[0]；深拷贝独立；roleSlots/ruleId/policy 逐字不动、不引入 events/judge。

test/taskteam-observe-detect.test.ts：Blocker 回归（judge 伪造 stall→零事件；mapBehaviorToEvent(stall)→null）；attribution 单元（external source-only 产事件且无 role / external+by 命中仍带 role / role 缺 role 仍丢）；role 事件断言统一加 `attribution:'role'` 标记。

## Validation（已执行 · reviewer 三轮 attribution 修复后）

- `node_modules/.bin/tsc --build`: PASS（EXIT=0，全仓类型通过）。
- `npx vitest run test/taskteam-*.test.ts --exclude '**/*.e2e.ts'`: **16 文件 / 185 测试全绿**。
- golden test 守住：`defaultTaskTeamSeed()` deepEqual + `planOnboarding()` 空 config 选 tt_type_two_layer_review、seats 顺序不变，均 PASS。
- 红线核对：引擎 4 special case 未改；新 schema 字段（judge / action / TaskTeamActionSpec / lastObservedActivityAt / TaskTeamEventDecl.attribution / TeamEvent.attribution / 3 新命令）全可选、向后兼容；reviewer 二轮确认通过项（stall 离 judge / __delivery strip / lastObservedActivityAt 锚 / outputEventRegistry fail-closed / 字段预留口径）未动。

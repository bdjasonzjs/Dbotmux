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
2. **新增领域无关动作**：`wake-role`（唤醒某角色席位）/ `notify`（通知某人/某群）/ `route-to-owner`（转交 owner）。补齐字段：目标类型、ack、可见性、root 唤醒、升级策略。**本阶段才扩 dispatcher**（阶段一刻意没扩）。动作与状态跃迁仍走阶段一的显式 transition，不隐式。
3. **计时/停滞触发器**：把 observer tick 的 stall gate 接到 `type.policy`，**复活 `escalateAfterStallMs`**（定义在 config-store/schema 但阶段一前是死配置）。stall/timer 事件由 **cheap gate / clock 产生（非 LLM 判「长时间」）**，事件来源用阶段一的 window/episode id（不退回 round）。归 **trigger 配置**，不是 judge 配置。
4. **现有开发团队 seed 抽成具名 type**：把 `defaultTaskTeamSeed()` 的两层 review 形态抽成一份具名 type 配置，现有实例指向它。canonical `typeId(tt_type_two_layer_review)`/`roleId`/`slotId`/`ruleId`/`roleSlots` 顺序/policy **一律不动**；要新名字只加 display、否则补 migration/alias。

## Acceptance（硬门）

- **开发团队能力逐字不丢**：`deepEqual(defaultTaskTeamSeed())` 快照 + `planOnboarding()` 空 config 仍选 `tt_type_two_layer_review` 且 seats 顺序不变。引擎 4 个 special case 仍原样保留（阶段4 才声明化）。
- **judge 配置化不破防注入**：外部消息仍走 UNTRUSTED scaffold + 工具禁用 + 输出白名单 + `source` 只取系统别名；模板作者只能填受限数据槽、动不了安全骨架。
- **计时触发器真生效**：配了 `escalateAfterStallMs` 的 type，stall gate 到点由 clock 真产出 stall/timer 事件（不是 LLM 判、不撞幂等 key）。
- **新动作可投递**：wake/notify/route 经 dispatcher 真实投递（含 ack/可见性/目标类型）；动作不隐式触发状态跃迁。
- **MoA 监控雏形可纯配置表达**（验证向，可放阶段三细化）：一份不声明 review 规则的 type，触发(定时/新消息)→判读(new-bug 受限槽)→notify 分析成员，连发多告警不丢事件。

## Test Coverage（已落实 · test/taskteam-controlflow-phase2.test.ts，19 例）

- 块1 judge 配置化（4 例）：per-type 受限槽（eventDescriptions/decisionHints/outputEventRegistry）渲染进 judge ctx；
  outputEventRegistry 只能收窄不能扩展（越权事件不出现、无交集回退完整集）；收窄后白名单外输出被丢弃；无槽回退内置描述。
- 块2 新动作（6 例）：notify 自定义事件产命令但不隐式跃迁（nextStatus/reviewState 均 undefined）；连发多 new-bug 幂等 key 各异；
  rule.action 进 payload.__delivery；dispatch 渲染 @指定 open_id + ack 提示；targetType=chat 路由到 targetChatId；validator 接受 3 新命令。
- 块3 停滞触发器（5 例）：maybeStallEvent 到点产 stall（window id=`stall:teamId:updatedAt ts`，不退回 round）；未配/未到点不产；
  同窗 sourceEventId 稳定→幂等去重（停滞窗内只升级一次）；observer tick gatedOut + 到点→clock 产 stall→escalate 入队、stats.stalls=1。
- 块4 具名 type（4 例）：canonical id 不变；deepEqual seed.teamTypes[0]；深拷贝独立（改一份不污染常量）；roleSlots 顺序/ruleId/policy 逐字不动、不引入 events/judge。
- 兼容回归：阶段一 phase1-compat 的 deepEqual seed + planOnboarding 持续钉死，未改动、仍绿。

## Validation（已执行）

- `node_modules/.bin/tsc --build`: PASS（EXIT=0，全仓类型通过）。
- `npx vitest run test/taskteam-*.test.ts --exclude '**/*.e2e.ts'`: **16 文件 / 172 测试全绿**（阶段一 153 + 阶段二新增 19）。
- golden test 守住：`defaultTaskTeamSeed()` deepEqual 快照 + `planOnboarding()` 空 config 选 tt_type_two_layer_review 且 seats 顺序不变，均 PASS。
- 红线核对：引擎 4 special case（team-started/review-pass/review-reject/accept）未改；新 schema 字段（judge / action / TaskTeamActionSpec / 3 新命令）全可选、向后兼容。

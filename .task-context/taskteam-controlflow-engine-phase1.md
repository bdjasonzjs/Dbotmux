# taskteam 控制流引擎化 · 阶段一「四内核」

Goal: 把 taskteam 引擎从「只为开发协作硬编码」演进成可配置控制流引擎的**前置内核**——补四个领域无关的小内核（配置 validator / 事件 registry / 幂等键策略 / 显式 transition），让后续「非开发型任务小组（监控/巡检/审批/值班）」能纯配置搭建且**不丢事件、不与开发团队状态语义打架**。本阶段**不引入任何新业务形态、不改变现有开发协作团队的对外行为**，纯打地基。

需求来源：稳定性组《任务小组控制流引擎化重构》(docx L5OSdisM4ouKFwxWiH7cckLHnbg)。
设计终版：docx H6fBd8ZaOo6X3XxKWMXcPeANnte ＝ 本机 `~/work/Dbotmux-task-notes/taskteam-engine-design.md`（§8 实现验收约束为本任务硬门）。
review：蔻黛克斯两轮，二轮放行 + 3 条 code-review 必卡硬约束（见下「Acceptance（硬门）」）。

## Scope

- Base branch: `master`（基线 6ac84f1b，drive 的 e8cd747d 在历史内、无回滚）
- Feature branch: `feat/taskteam-controlflow-engine`
- Worktree: `/home/zoujinsong.jason/work/Dbotmux_wt/taskteam-controlflow-engine`（本群所有 bot 共用这一个副本）
- 边界：**无授权不 push、不 merge、不 daemon 重启、不部署**；停在 working tree / 本地 commit，部署与 push 需松松授权。
- 触及文件（预期）：`src/services/taskteam-engine.ts`、`taskteam-runtime.ts`、`taskteam-schema.ts`、`taskteam-config-store.ts`、`taskteam-observe-executors.ts`、`taskteam-outbox-store.ts`（只读确认）+ 对应 `test/`。
- **不在本阶段**：wake/notify/route 等新动作（阶段2）、judge prompt 配置化（阶段2）、计时/stall 触发器接线（阶段2）、迁移开发团队 seed（阶段2）、4 个 special case 声明化（阶段4）。阶段1 **不扩 dispatcher**。

## Plan（四内核）

1. **配置 validator**：在 import / upsert / create type 前做闭环校验——slot / role / rule / event / action / policy 全部互相引用闭合；`whoSlot`/`fromSlotId` 必须存在、`ruleId` 必须挂到 `type.rules`、`when.event` 必须在事件 registry 内。**覆盖生产侧**：registry 声明了 event 但没有任何 trigger/judge 能产出它 → warn/error。杜绝「配着看着对、运行永远零事件 / 静默 no-op」。
2. **事件 registry**：事件类型从「TS union 写死 + observer 侧 `DETECTABLE_EVENT_TYPES` 固定白名单」改成**可声明 + 运行时 string + 校验兜底**。规则的 `when.event` 已是 string、引擎已按字符串比较（`engine.ts:92-97`）；本内核让事件类型可按 type 声明、生产侧（judge→mapBehaviorToEvent）能产出新类型、typo 在 validator 报错而非静默丢。**不裸字符串化**：保留生成类型 / 测试兜底，留住类型安全。
3. **幂等键策略（治丢事件 · 根因 `engine.ts:109` + `outbox-store.ts:127`）**：见下硬门约束1。
4. **显式 transition（解耦动作与状态跃迁）**：现在 `engine.ts:200-202` default 命中 `request-review` 就隐式强制 `reviewing`+`enterReview()`。本内核让状态跃迁由规则显式声明、可被 validator 校验，default/custom 事件不再由 command 名隐式决定状态。迁移期红线见硬门约束2。

## Acceptance（硬门 · 蔻黛克斯二轮 review · 少一条 code review 卡）

**约束1 — per-event 稳定 sourceEventId（治丢事件）**
- judge 上下文给每条消息一个**短 message alias**；judge 输出**必须带 `source`**，`source` **只能取系统给的别名**，不许模型自由生成 open_id/message_id（防注入）。
- output schema 从 `[{type,by,reason}]` 扩成 `[{type,by,reason,source}]`。
- `TeamEvent` 增 `sourceEventId`；默认幂等 key **至少含 `event.type + sourceEventId + ruleId + targetRoleInstanceId`**。
- timer/stall 等**无消息事件**用 window id / episode id 作来源，**绝不退回 round**。
- 必堵两坑：①一批消息产出多个同类 behavior 会共享同一 reached cursor、仍撞 key（`observe-executors.ts:488-503`）②judge 只出 type/by/reason 则 engine 无 source 可构 key（`mapBehaviorToEvent()` 当前无 source）。

**约束2 — 显式 transition 迁移期红线（防双状态语义）**
- legacy 事件 `team-started/review-pass/review-reject/accept` **仍走现有 special case、不读新 transition**（保开发团队行为不漂）。
- 只有 default/custom event 走显式 transition。
- validator 禁止同一 rule 命中互斥 transition；**一次事件的状态 transition 必须 0 或 1 个，多个 = 配置错误**（依据 `runtime.ts:91-114` 一次事件只落一个 `{status,reviewState}` patch，冲突无处表达、无检测）。
- special case **留阶段4 整体迁，阶段1 绝不半迁**。

**约束3 — judge schema 扩 `source`**（与约束1 配套，`source` 受限取系统别名；保留 `UNTRUSTED_DATA` scaffold + 工具禁用 + JSON schema 校验，不开放完整 prompt）。

## 兼容红线（开发团队不能挂）

- 引擎 4 个 special case 本阶段原样保留。
- 现有 `defaultTaskTeamSeed()` 行为**逐字不变**：canonical `typeId`/`roleId`/`slotId`/`ruleId`/`roleSlots` 顺序/policy/orgStructures **一律不动**（被 tests + onboard `types[0]` sample + dashboard 按 roleSlots 顺序渲染 + 现有实例用 `tt_type_two_layer_review` 查 type 引用）。

## Test Coverage（计划 · 开发阶段补实测填实）

- 幂等键：同 type 连发两个**同类**事件（不同 source）→ 两个动作都入 outbox、不被去重吞；同一 source 重放 → 去重。timer/stall 无消息事件用 window/episode id 不撞。
- 显式 transition：default/custom 事件按规则显式 transition；legacy 4 事件仍走 special case、行为快照不变；validator 对互斥/多 transition 报配置错误。
- validator：缺失 slot/role、event typo、ruleId 未挂 type.rules、声明 event 无 producer → 全部在 create/upsert 前报错或 warn，不静默。
- 兼容回归：`deepEqual(defaultTaskTeamSeed())` 快照钉死；**且** `planOnboarding()` 空 config 下仍选 `tt_type_two_layer_review`、seats 顺序不变（仅 deepEqual seed 钉不住 onboarding 的 `types[0]`）。

## 实现落点（开发阶段填实 · 2026-06-28）

四内核 + 接线文件：
- **内核②事件 registry**：新增 `taskteam-event-registry.ts`——内置事件集（lifecycle/detectable/timer，TaskTeamEventType union 的运行时镜像，不裸字符串化）+ `knownEventsForType`/`detectableEventsForType`/`isProducibleForType`。`TaskTeamType.events?` 可声明领域无关自定义事件。`TeamEvent.type` 拓宽为 `TaskTeamEventType | (string & {})`（内置仍受 union 保护，自定义经 string 兜底放行）。observe-executors 的固定 `DETECTABLE_EVENT_TYPES` 常量改为引用 registry 内置集；`mapBehaviorToEvent` 新增 `ctx.detectable` 入参可按 type 扩展可判读集。
- **内核③幂等键 + 约束1 sourceEventId**：`TeamEvent.sourceEventId?`；engine emit 的 key 改 `teamId:event.type:{sourceEventId ?? r{round}}:ruleId:target`（含 event.type+source+ruleId+target，约束1）。observe-executors：judge 上下文每条消息打 `[Mk|Rn]` 双别名（Mk 给 source、Rn 给 by）、判读输出扩 `source`（只能取 Mk 系统别名，防注入）、detect 把 source 别名解析回真实 message id 作 sourceEventId；无消息事件（stall）/解析不到 → `win:{reached}` window-episode id（绝不退回 round）。**两坑都堵**：①一批多 behavior 各归各自 message id（不再共享 reached cursor 撞 key）②judge 出 source、engine 据此构 key。
- **内核④显式 transition + 约束2**：`TaskTeamCollabRule.transition?: { status }`。engine **default 分支**才读：命中规则声明唯一 transition → 用之、且不触发隐式 reviewing；未声明 → 保留旧隐式 `request-review→reviewing`（迁移期 fallback，保 seed 行为不漂）；冲突（多个不同 status）运行时保守不跃迁。legacy 四事件（team-started/review-pass/review-reject/accept）走各自 switch case、**完全不读 transition**（绝不半迁）。
- **内核①validator**：新增 `taskteam-validator.ts`——闭环引用（slot/role/rule/whoSlot/fromSlot/reviewOrder）+ 事件 registry（when.event 不可产出→警）+ 显式 transition 红线（legacy 事件声明 transition→警；同事件可同时命中的互斥 transition→错；非法 status/do→错）。严重度：闭环/生产侧/legacy-transition=warning（增量 upsert 不硬阻断）、transition 冲突/非法 do/非法 status=error。接线 `config-store.ts` 的 `upsertTaskTeamType`/`replaceTaskTeamConfig`：有 error 抛 `TaskTeamConfigValidationError`（不落库）、warning 记日志、不静默。

兼容红线守法：seed `defaultTaskTeamSeed()` 一字未动；新增 schema 字段全部可选（`events?`/`transition?`/`sourceEventId?`），seed 序列化不变 → deepEqual golden 钉死通过。

## Review 状态：✅ 通过（2026-06-28，蔻黛克斯两轮）

- Round1 review（docx AINydEO66oGOsgx1n3ncHRCtnF1）：暂不放行，2 Blocker + 2 P1。
- Round2 修复（docx OEr6de5vZobAIxxGMbLcvFwtnj0）：4 条全部接受并修到真实路径。
- Round2 复审（docx Ld2ud8ZJioWRZixNWJlcH38YnLf）：**通过**。reviewer 本地复跑 153 测全过 + build 过 + git diff --check 干净，未发现新阻断。
- 当前停在 working tree —— **commit / push / 部署待邹劲松授权**（子群无权擅自动）。

## Round 2 · 蔻黛克斯 review 修复（2026-06-28，docx AINydEO66oGOsgx1n3ncHRCtnF1）

reviewer 暂不放行、提 2 Blocker + 2 P1，逐条独立判断后**全部接受**（均实打实戳硬约束），已修：
- **Blocker1（自定义 behavior 未接真实 detect）**：`makeTaskTeamObserveExecutors` 新增 `resolveType?(instance)` dep；detect 据 `instance.typeId` 取 `TaskTeamType` → `detectableEventsForType(type)` 传入 judge prompt + `mapBehaviorToEvent`；judge prompt 可判读事件列表从 registry **动态渲染**（不再写死内置 8）。daemon 经 `resolveTaskTeamTypeForInstance`（deps.ts，读 config）注入。补 detect 级测试：声明 `events:[{type:'flag-anomaly',producer:'behavior'}]` 后 detect 真实产出该 TeamEvent；不注入 resolveType 则丢弃。
- **Blocker2（source 弱 schema → 缺 source 撞 win id）**：detect 对 **message-derived behavior** 强制 source——只认系统别名 `M{k}`，缺失/非法（解析不到）→ **丢弃 + 告警**，绝不回退共享 `win:{reached}` 再投递（坑①根治）；只有 timer/stall（`timerEventsForType`）无消息事件才用 episode id。prompt 明示「除 stall 外每条必须带 source，漏/乱填丢弃」。补测试：两个缺 source 同类 submit → 全丢、不产两个同 key action；防注入（自造 id）→ 丢弃。
- **P1-a（upsertTaskTeamRule 没 guard）**：`upsertTaskTeamRule` 加 `guardConfig`——已被某 `type.rules` 引用的 rule 改坏（非法 do / transition 冲突 / 非法 status）阻断落库；未被引用的增量 rule 不触发 per-type 校验（增量顺序不受影响）。补 admin 级测试（改坏已引用 rule → throw + 磁盘保旧值）。
- **P1-b（event 严重度 / 声明≠已接线）**：validator 拆分——`when.event` 不在 registry（typo）→ **error `event-unknown`**（阻断）；已声明但无已接线 producer（自定义 timer/lifecycle，阶段1 未接 clock/引擎）→ **warning `event-no-producer`**。`isProducibleForType` 去掉「声明即 producible」兜底（producible = 内置 lifecycle ∪ detectable(含声明 behavior) ∪ 内置 timer）。另加 **`custom-request-review-no-transition` warning**：自定义事件 + do=request-review + 无 transition（会被隐式拽进 reviewing）→ 提醒显式声明 transition（堵迁移红线，回应三问#2）。

新增/改动文件（Round2）：`taskteam-observe-executors.ts`（resolveType/detectable/source 强约束/prompt 动态渲染）、`taskteam-event-registry.ts`（+timerEventsForType、isProducibleForType 收紧）、`taskteam-validator.ts`（typo→error、no-producer→warn、custom-request-review warn）、`taskteam-config-store.ts`（guard upsertRule）、`taskteam-deps.ts`（+resolveTaskTeamTypeForInstance）、`daemon.ts`（注入 resolveType）+ 对应测试。

## Validation（开发阶段填实测结果 · 2026-06-28）

- `pnpm build`: ✅ 通过（tsc 全量编译 + dashboard esbuild bundle，exit 0）——Round2 后复跑仍 ✅。
- 受影响 + 新增单测 `vitest run test/taskteam-*.test.ts --exclude '**/*.e2e.ts'`: ✅ **Round2 后 15 文件 153 测全过**（Round1 147 + Round2 新增 6）。
  - 新增覆盖：约束1（source 解析 M{k}→message id、坑①多 behavior 各归各自来源、防注入回退 episode id、sourceEventId 入幂等 key）、约束2（custom event 显式 transition、do=request-review 不被拽进 reviewing、未声明走旧隐式 fallback、冲突保守不跃迁）、validator（12 例：闭环/typo/transition 冲突/legacy/非法 status/assert 抛错）、兼容（deepEqual seed golden + planOnboarding 仍选 tt_type_two_layer_review + seats 顺序钉死）。
- 注：本 worktree 无 node_modules，测试经 symlink 到主 clone `~/work/Dbotmux/node_modules` 运行（同基线 master 6ac84f1b，依赖一致；package.json 未改）。

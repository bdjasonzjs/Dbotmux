# taskteam 控制流引擎化 · 阶段三「MoA 监控纯配置端到端验证」

Goal: 用阶段一+二建好的原语（事件 registry / attribution policy / judge 受限数据槽 / notify 动作 / 触发器 / 显式 transition），**纯配置**搭出一个 MoA 定时/外部群监控小组类型，并端到端跑通：外部群有人报新 bug → judge 判出 `new-bug`（external attribution）→ 规则 `notify` 分析成员 → 连发多告警不丢事件、噪声不误报。证明整个重构达成原需求（原需求文档：稳定性组「MoA 监控配好却产不出提醒」那条根因被解掉）。

本阶段**不改引擎核心 / 不为 MoA 写专门代码**——只允许：一份声明式 MoA type 配置（数据）+ 端到端集成测试 +（可选）示例 config / 小 helper。若发现必须写新引擎代码才能跑通，说明阶段一/二有缺口，**停下来标记并上报**，不要在阶段三偷偷补引擎。

前置：阶段二已 reviewer 放行（commit e61d5f17，分支 feat/taskteam-controlflow-engine-phase2）。

## Scope
- Worktree/分支：**复用** `/home/zoujinsong.jason/work/Dbotmux_wt/taskteam-controlflow-engine-phase2`（分支 feat/taskteam-controlflow-engine-phase2，阶段三 commit 直接叠上去）。别新开 clone/worktree。
- 边界：无授权不 push / merge / daemon 重启 / 部署；停在本地 commit。
- 合并时机：按松松指令，全阶段 done+测过才一起合 master。

## Plan
1. **MoA monitor type 配置（纯声明式）**：定义一份具名 type（如 `tt_type_moa_monitor`）——
   - roles：analyst（分析/判定成员，执行席）+ 可选 observer；**不声明任何 review 角色 / review 规则**。
   - events：`new-bug`（attribution=`external`，no-actor 允许 source-only）；可加 `triaged`（analyst 判定后路由）。
   - judge 受限数据槽：`eventDescriptions`（"什么算 new-bug：外部用户报的新问题/缺陷"）+ `decisionHints` + `outputEventRegistry: ['new-bug', ...]`（收窄）。
   - rules：`when:{event:'new-bug'} do:'notify'`（或 route-to-owner）targeting analyst；**不依赖 fromSlotId**（external 事件无可靠 fromSlot，validator 会拦）。不进 reviewing。
   - trigger：observer 盯 `targetExternalChatId`（已有）；如需纯定时也可挂 timer。
2. **端到端集成测试**（核心交付）：模拟外部群一批消息（含 N 个不同 bug + 噪声闲聊）→ fake judge 按受限槽判出 N 个 `new-bug`（各带不同 `source=M{k}`）+ 噪声判 []→ detect 产 N 个 external TeamEvent（各带 message-id sourceEventId、无 role）→ engine 命中 notify 规则 → dispatch 投递给 analyst。断言：
   - 连发 N 个**不同** bug → N 个 notify 全投递（**不丢**，幂等键各异）；
   - 同一 bug（同 source）重放 → 去重、不重复投递；
   - 噪声消息 → 不产事件、不误报；
   - 全程不进 reviewing、不依赖 role 归因。
3. （可选）放一个示例 MoA config（examples/ 或测试 fixture）+ 必要时小 helper，方便照配。
4. 同步本 task-context（落实测果）+ 在设计 docx 对应处可留「阶段三验证通过」一句（docx 我来落）。

## Acceptance（硬门）
- MoA monitor **纯配置可表达**：没有为它写专门引擎/dispatcher/judge 代码（只有 type 配置数据 + 测试）。
- 端到端**真跑通**：外部 new-bug → notify analyst 真投递（dispatch 产出投递记录）；连发多告警**不丢**；噪声不误报。
- **不回归**：开发团队 golden（deepEqual seed + planOnboarding）+ 全部既有 taskteam 测试仍绿；引擎 4 special case 未改。

## 落地（已完成）

- **MoA monitor type 配置**：`src/services/taskteam-moa-monitor.ts`（**纯声明式数据，零引擎/dispatcher/judge 代码**）——
  - `MOA_MONITOR_ROLES`：analyst（执行席）+ observer（盯群席，isObserver）；**无任何 review 角色**。
  - `MOA_MONITOR_TYPE`：`tt_type_moa_monitor`；`events:[{type:'new-bug', producer:'behavior', attribution:'external'}]`；
    `judge` 受限槽（eventDescriptions/decisionHints/`outputEventRegistry:['new-bug']` 收窄）；policy 无 review（reviewRounds 0、escalateAfterStallMs 0）。
  - `MOA_MONITOR_RULES`：`tt_rule_moa_new_bug_notify` = `when:{event:'new-bug', status:'running'} do:'notify' whoSlot:analyst`，**不依赖 fromSlotId**、无 transition（不进 reviewing）。
  - `moaMonitorConfigBundle()`：返回 {roles,rules,teamTypes} 深拷贝，照配即用。
- **端到端集成测试**：`test/taskteam-moa-monitor.test.ts`（4 例）。唯一 fake = IO 注入缝（judge/fetchSince/peek/send），**未 fake/改任何引擎逻辑**。真实链路：detect（真）→ engine（真）→ outbox enqueue（真去重）→ dispatcher tick（真投递）。配置经 `replaceTaskTeamConfig` 真 validator 守卫落库（顺带证明配置合法）。

## Test Coverage（已落实 · test/taskteam-moa-monitor.test.ts 4 例）
- **连发 N 个不同 bug**：外部群 3 bug + 2 噪声、sender 全非绑定 → 真 detect 产 3 个 external 事件 → 3 条 notify 全投递 analyst；幂等键各异；`sourceRoleInstanceId` 全 undefined（**不依赖 role 归因**）；无 request-review、状态仍 running（**不进 reviewing**）；dispatch 渲染 @ou_analyst。
- **同 bug 重放去重**：同 message id=同 sourceEventId=同幂等键 → outbox 不增、dispatcher 无新投递。
- **纯噪声零误报**：judge 判 [] → 0 事件 / 0 投递 / 状态不变。
- **防注入仍生效**：judge 越权判 submit（收窄白名单外）+ 自造 source 的 new-bug（非 M{k} 别名）→ 全丢、0 事件。
- 兼容：既有 185 测 + golden（deepEqual seed + planOnboarding）持续绿。

## 有没有遇到「必须写引擎代码」的缺口
- **没有缺口**。MoA 监控完全由阶段一+二的原语（external attribution / judge 受限槽 / notify 动作 / observer 盯 targetExternalChatId / outbox 去重）纯配置表达，未改一行引擎/dispatcher/judge。阶段一/二的原语对 MoA 场景**够用**，重构达成原需求。

## Validation（已执行）
- `node_modules/.bin/tsc --build`：PASS（EXIT=0，全仓类型通过；MoA 配置在 src/ 内受 tsc 守护）。
- `npx vitest run test/taskteam-*.test.ts --exclude '**/*.e2e.ts'`：**17 文件 / 189 测试全绿**（阶段一/二 185 + 阶段三 MoA 集成 4）。
- golden 守住：`defaultTaskTeamSeed()` deepEqual + `planOnboarding()` 仍选 tt_type_two_layer_review、seats 顺序不变，PASS。引擎 4 special case 未改；阶段一/二改动未回退。

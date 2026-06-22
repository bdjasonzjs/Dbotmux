# 任务小组配置器 · 流程化设计（PRD §8.2）

目标：把现在「角色/规则/类型」三段平铺表单，换成 PRD §8.2 要的「像搭团队一样：拖角色进来 + 连谁审谁 + 设审几轮 + 打包成类型」的可视化画布。全程不碰 JSON。

低保真原型：
- `prototype.html` / `prototype.png` —— 选中节点态（角色属性面板）。
- `prototype-policy.html` / `prototype-policy.png` —— 点画布空白态（小组类型策略面板：审几轮/quorum/返工/升级/审批序列），证明三栏范式覆盖「设审几轮和上报规则」(review P2-2)。

## 1. 调研结论：复用基础

- PRD 说的「从 Workflow 那边挪过来的可视化界面」= 已存在过的 `src/dashboard/web/workflow-builder.ts`（1911 行，完整画布：SVG 节点 + 指针拖拽 + 三次贝塞尔连线 + 条件连边 + 属性面板 + 自动布局）。
- 批9（commit `5176c7fe`）revert 时把它**整文件删了**，UI 降级 DAG-only、builder 路由回落 catalog。**画布代码本身在 git 历史里完整可恢复**（`git show 5176c7fe~1:src/dashboard/web/workflow-builder.ts`）。
- `topology.ts` 是只读拓扑图（quadratic 边、无拖拽），可参考其 SVG marker / viewBox 框架，但不是可编辑画布。
- 结论：**画布交互层不用从零写**——恢复 workflow-builder 的渲染/拖拽/连线/属性面板骨架，把数据模型从 WorkflowDefinition 换成 TaskTeam schema 即可。

## 2. 三栏布局

| 区 | 内容 |
|---|---|
| 左 · 角色调色板 | 开发 / 审核 / 上报 / 观察 / 自定义，拖进画布生成「席位」节点 |
| 中 · 画布 | 节点=席位（角色实例，显示模型/引擎/动作徽标）；连线=「谁审谁」协作关系；节点可拖动定位 |
| 右 · 属性面板 | 选中节点→编辑角色字段；选中连线→编辑规则；点空白→编辑类型级策略（审几轮等） |
| 顶 · 工具栏 | 类型名 + 「打包成小组类型」按钮（= 组装并提交三组 upsert） |

交互核心：从节点右侧蓝色 out 端口拖到另一节点的 in 端口 = 建一条协作规则（默认「提交→请审」），连线上的 chip 可改条件（提交→请审 / 通过→汇报 / 驳回→返工）。

## 3. 画布 ↔ Schema 映射（复用 taskteam-builder-data.ts 的组装函数）

| 画布元素 | 映射到 schema |
|---|---|
| 调色板拖出的节点 | `TaskTeamRoleSlot { slotId, roleId }` + `TaskTeamRole` |
| 节点属性面板 | `TaskTeamRole`：name / responsibility / activation / visibility / actions[] / **model**（挑模型）/ **seatHint.engine**（引擎）/ isObserver |
| 连线 A→B | `TaskTeamCollabRule`：`when.event=submit`、`when.fromSlotId=A`、`whoSlot=B`、`do=request-review`（条件 chip 改 when/do） |
| 画布空白处面板 | `TaskTeamType.policy`：**reviewRounds（审几轮）** / reviewQuorum / maxRework / escalateAfterStallMs / reviewOrder[] |
| 「打包成小组类型」 | 组装 → 调 `buildRolePayload`/`buildRulePayload`/`buildTypePayload` → 三个 IPC：`POST /api/taskteam-{role,rule,type}-upsert`（N 次 role + N 次 rule + 1 次 type） |

后端 admin IPC（`taskteam-admin.ts` 三个 upsert handler）与 payload 组装层（`taskteam-builder-data.ts`）**全部保留复用**，不改后端。本任务只换前端配置范式。

## 4. 复用 / 改造 / 新写 拆分

复用口径修正（review P2-1）：旧 builder 依赖已被批9撤销的 WorkflowDefinition flow/roles/semantic 模型、workflow validate/save API、workflow E2E（5176c7fe 一并删除）；且旧连线是「选中节点→connect-mode→点目标」，**不是**原型里的 out-port 拖到 in-port；左侧拖角色进画布也是新能力。所以不是「恢复骨架即可」，而是：

- **抽取/改写 UI primitives（复用素材）**：SVG viewBox、`edgePath()` 贝塞尔、节点 drag（pointerdown/move）、selection/属性面板框架、autoLayout、部分 CSS。
- **重写数据层**：CanvasTeam 模型（节点=RoleSlot、边=CollabRule），不复用 WorkflowDefinition。
- **重写保存层**：组装 TaskTeam 三件套（复用 builder-data 的三个 build*Payload + postAdmin）。
- **新写**：左侧角色调色板（模板/已存两栏，拖出建 role 或绑定 roleSlot）、out-port→in-port 连线交互、连线条件 chip 编辑、画布级策略面板、保存前一致性校验（见 §6/§7）。
- **新写 E2E**：TaskTeam 专用，不复用已删的 workflow-builder E2E。
- **替换**：`taskteam-builder.ts` 平铺表单 → 画布入口；builder 路由从 catalog 回落改指向新画布。

## 6. 连线 chip → CollabRule 精确映射表（review P1-1）

> ⚠️ 关键修正：`TaskTeamDeliveryCommand` 只有 `kickoff / request-review / nudge / escalate / report / finish`，**没有 `rework`**。原 v1 设计的「驳回→返工」chip 暗示 `do=rework` 是非法的。真实可运行语义已对 `taskteam-engine.ts` + 默认规则种子 `config-store.ts:212-220` 核对。`submit / review-pass / review-reject` 是 **event** 值；`running / reviewing` 是 **status** 值（引擎 `engine.ts:92-95` 分别按 `when.event` / `when.status` / `when.fromSlotId(按 roleId)` 匹配）。

| 连线 chip（UI label） | when.event | when.status | when.fromSlotId | whoSlot | do | 运行后状态 | 代码出处 |
|---|---|---|---|---|---|---|---|
| 提交→请审（开发首提） | `submit` | `running` | （空） | 目标审核席 | `request-review` | →reviewing | config-store.ts:212 |
| 通过→下一审（多层审递进） | `review-pass` | `reviewing` | 当前审核席 | 下一审核席 | `request-review` | →reviewing(清票/round++) | config-store.ts:214; engine.ts:200 |
| 通过→汇报（末层审通过） | `review-pass` | `reviewing` | 末层审核席 | 开发/上报席 | `report` | →awaiting-acceptance | config-store.ts:216; engine.ts:188 |
| 驳回→返工 | `review-reject` | `reviewing` | （空） | 开发席 | `nudge` | →running(reworkCount+1) | config-store.ts:218; engine.ts:157 |
| 卡死→升级 | `stall` | `running` | （空） | 观察席 | `escalate` | 无跃迁 | config-store.ts:220; engine.ts:198 |

实现要点：UI 上画一条连线时，按「源/目标角色 kind + 选中的 chip」查这张表确定 6 个字段，**不让实现者按中文 label 猜 `do`**。同一条「通过」连线根据目标是否末层审，自动选 `request-review`(下一审) 还是 `report`(验收)。

> ⚠️ **「超返工上限→升级」不是可连线的 CollabRule（review 复审 P1）**：当前 `TaskTeamTriggerCondition` 没有 `reworkCount`/`maxRework` 条件，普通 `review-reject→escalate` 规则无法表达「仅超上限时触发」。引擎对 `review-reject` 的处理是：`nextRework ≤ maxRework` 直接 `emit(matched)`（nudge 返工），**只有 `nextRework > maxRework` 才内置 filter `do==='escalate'` 或 fallback 到 observer**（`engine.ts:150-154`）。因此若把它存成普通规则，**第一次驳回就会和返工规则一起 matched 命中、提前升级**。结论：超限升级是 `policy.maxRework` 的**引擎内置兜底语义**，只在策略面板里展示说明，**不作为画布连线、不写进 `type.rules`**；保存 rules 时 `review-reject` 只产出 `→nudge` 返工规则。

## 7. reviewOrder / reviewRounds 一致性（review P1-2，含修正）

> 核对发现：引擎推进多轮 review 的真实依据是**命中的 `review-pass` 规则链**（`fromSlotId→whoSlot`，按 roleId 路由）+ `reviewQuorum`（`engine.ts:160-195`）。`reviewRounds` / `reviewOrder` **未在引擎代码中被消费**——它们是声明/可读性字段。所以 review P1-2 的方向对（要一致性），但**画布连线（规则链）才是 review 顺序的唯一运行真相**，reviewOrder 应从画布派生而非反向驱动。

**reviewOrder 派生算法（review 复审：必须含首轮 reviewer）**：首轮 reviewer 来自 `submit→request-review` 边的 target，**不能只从 `review-pass→request-review` 边收集、否则漏首轮**。精确定义：
- `reviewOrder[0]` = `submit→request-review` 边的 target 审核席；
- 之后沿 `review-pass→request-review` 边逐个追加下一审核席（按链路顺序）；
- 末级审核席必须存在一条 `review-pass→report` 出边（到验收），否则流程跑到末层卡死。

保存前校验（不一致则禁用「打包成小组类型」并报错）：
1. `reviewOrder` 按上述算法从画布派生（自动、只读展示，不让用户手填）。
2. `reviewRounds` = `reviewOrder` 的层数（派生值），与画布一致。
3. 每个审核席必须有一条出边：要么 `→request-review`(下一审) 要么 `→report`(验收)；**末层审核席必须能到 `report`/验收**，否则流程跑到末层卡死。
4. 每个审核席应有 `review-reject→nudge` 回开发席的返工边（缺失则审核驳回无去向，告警）。
5. `reviewQuorum` ≤ 同角色席位数。

## 8. Role.io 由画布连线派生（review P1-3）

`TaskTeamRole` 的 `io.from` / `io.to`（builder-data `RoleForm.fromRoleIds/toRoleIds`）必须由画布边派生，画布是关系的唯一来源：

- 保存时按 `roleId` 聚合：该角色所有入边的源角色 → `io.from`（去重）；所有出边的目标角色 → `io.to`（去重）。
- 删连线 / 改角色 / 改 slot 绑定时同步重算，保存后不留空 io 或旧 io。

## 9. 角色调色板：模板 + 已存两栏（review P2-3，亦是松松方向问题③的建议默认）

左栏分两区：
- **模板角色**（开发/审核/上报/观察/自定义）：拖入画布 = 新建一个 `TaskTeamRole` + 一个 `RoleSlot`。
- **已存角色**（读现有 roles 库）：拖入画布 = 只新建 `RoleSlot` 绑定既有 `roleId`，不重复建 role。

这样「快速搭新团队」和「复用/编辑已有配置」一套画布都覆盖，避免后续返工。最终是否这样做取决于松松方向问题③。

## 10. 待 CEO/松松确认的方向问题

1. 范式确认：三栏画布（调色板+画布+属性面板）是否就是要的方向？
2. 「审几轮 / 审批序列」放画布级面板（点空白编辑、且为画布派生的只读展示）——是否符合预期？
3. 角色库：调色板建议「模板 + 已存」两栏（§9）。确认是否采纳，还是只要固定模板？

确认后进入实现阶段（抽取画布 primitives + 重写数据/保存层 + 接 §6/§7/§8 映射与校验，逐步 pnpm build + 截图交付）。

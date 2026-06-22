# 任务小组配置器 · 流程化设计（PRD §8.2）

目标：把现在「角色/规则/类型」三段平铺表单，换成 PRD §8.2 要的「像搭团队一样：拖角色进来 + 连谁审谁 + 设审几轮 + 打包成类型」的可视化画布。全程不碰 JSON。

低保真原型：`docs/taskteam-flow-config/prototype.html`（截图 `prototype.png`）。

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

- **复用（git 恢复）**：renderBuilderPage 骨架、节点 DOM/SVG 渲染、pointerdown/move 拖拽、`edgePath()` 贝塞尔连线、属性 Inspector 框架、autoLayout。
- **改造**：数据模型 CanvasWorkflow → CanvasTeam（节点=席位、边=协作规则）；`toDefinition()` → 组装 TaskTeam 三件套（复用 builder-data 的三个 build*Payload）；节点类型从 subagent/hostExecutor/semantic 简化为「角色席位」单一类型 + 角色 kind。
- **新写**：左侧角色调色板（拖出建节点）、连线条件 chip 编辑、画布级策略面板（审几轮/quorum/返工/升级/审批序列）。
- **替换**：`taskteam-builder.ts` 平铺表单 → 画布入口；builder 路由从 catalog 回落改指向新画布。

## 5. 待 CEO/松松确认的方向问题

1. 范式确认：三栏画布（调色板+画布+属性面板）是否就是要的方向？
2. 「审几轮 / 审批序列」放画布级面板（点空白编辑），而非每条连线上——是否符合预期？
3. 角色库：调色板里的角色是固定 5 类（开发/审核/上报/观察/自定义），还是要支持从已存角色库拖？

确认后进入实现阶段（复用画布层 + 接 schema 映射，逐步 pnpm build + 截图交付）。

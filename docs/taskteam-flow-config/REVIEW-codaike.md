# 流程化配置器 · 架构设计 + 低保真原型 Review

> Reviewer 视角，已核实代码 + git 历史（worktree `feat/taskteam-flow-config@7d3ca0e2`）。
> 审阅对象：`docs/taskteam-flow-config/DESIGN.md` + `prototype.png/html`。

## 总评

**方向成立，可进入实现。** 复用策略(A)、三栏范式(C) 都站得住；画布↔schema 映射(B) 主体正确，但有 **1 个必须先定的硬缺口**（返工连线的 `do` 映射）+ 2 个要写清的点。补完 B1 即可开干。

---

## A. 复用策略 —— 成立 ✅

- 已核实 git：`5176c7fe`（批9 revert）**整文件删了** `src/dashboard/web/workflow-builder.ts`（1911 行），确为完整画布——SVG 节点 + pointer 拖拽 + 三次贝塞尔连线 + 条件边 + 属性面板 + autoLayout。`git show 5176c7fe^:src/dashboard/web/workflow-builder.ts` 可完整恢复（DESIGN 写的 `5176c7fe~1` 等价）。复用策略真实可行。
- **依赖面提醒（建议补一句）**：恢复出的文件 `import` 了 `./workflow-product-builder.js`（仍在树中 ✓）和 `../../workflows/definition.js` 的 `WorkflowNode/WorkflowRole/semantic` 类型（批9 已改/降级）。所以真正能直接复用的是**渲染/几何/拖拽/连线/Inspector 骨架**；凡触碰 Workflow 类型的逻辑都要按 TaskTeam 重写。DESIGN §4 的复用/改造/新写拆分已诚实，认可——建议把"复用约 X% / 重写约 Y%"标实一点，避免实现时高估复用率。

## B. 画布 ↔ Schema 映射 —— 主体对，有缺口

- ✅ 节点=`RoleSlot`+`Role`、画布级=`Type.policy`（reviewRounds / reviewQuorum / maxRework / escalateAfterStallMs / reviewOrder 五项逐一对上）、打包=三组 upsert——全部与 `taskteam-schema.ts` + `taskteam-builder-data.ts` 的 `build*Payload` 对得上。

- 🔴 **B1（必须先定 · 硬缺口）：连线 chip「驳回→返工」没有合法的 `do`。**
  `TaskTeamDeliveryCommand` 只有 `kickoff / request-review / nudge / escalate / report / finish`——**没有 `rework`**。
  而既有种子配置已给出权威答案：`src/services/taskteam-config-store.ts:217`
  > `// 任一层驳回 → nudge 开发者席返工（rework 是开发者的角色行为，投递命令是 nudge）`
  即 `tt_rule_reject_to_rework` = `{ when.event=review-reject, whoSlot=开发者席, do=`**`nudge`**` }`。
  DESIGN §3 映射表只把"提交→请审"一行写实，另两个 chip（通过→汇报 / 驳回→返工）的完整 `(when.event, whoSlot, do)` 元组留白，其中"返工"的 `do` 是非直觉的 `nudge`。
  **要求**：把 **chip → (when.event, whoSlot, do) 完整预设表** 写进设计，并**直接对齐 config-store 的种子规则做画布默认预设库**，保证「画布生成的规则」≡「引擎认识的规则」。否则用户连出来的"返工"线会落成非法 `do`、被引擎静默忽略。

- 🟡 **B2：`TaskTeamRole.io`（from/to）在映射里整段缺席。**
  现有 `buildRolePayload` 会填 `io.from/io.to`（旧表单的 fromRoleIds/toRoleIds）；新画布 §3 只把连线映射到 `CollabRule`，没交代 `io` 怎么办。我 grep 了运行时——**引擎路由只走 `CollabRule`，没消费 `Role.io`**（无命中），所以画布不再产出 `io` **大概率不是行为回归**；但请在设计里**显式写一句**（"io 不在画布暴露 / 置空 / 由边反推"），做成有意识的决定，别静默丢字段。

- 🟡 **B3：`whoSlot/fromSlotId` 用 slotId，而调色板/`Role.io` 用 roleId；同一角色多席位要支持。**
  `buildTypePayload` 的 `"slotId:roleId[:label]"` 已支持。请在设计点明"每拖一次 = 一个独立 slot，边引用 slotId"，并确认画布允许**同一 role 多 slot**（双 reviewer / 双开发）。

## C. 三栏范式 —— 符合 PRD §8.2 ✅

- PRD §8.2 动作逐条命中：拖角色进来（左栏）✓、连谁审谁（连线）✓、挑模型（属性面板 model）✓、设审几轮（画布级 policy）✓、上报规则（policy + report rule）✓、打包成类型（顶栏按钮）✓、全程不碰 JSON ✓、复用 Workflow 可视化界面（= 已删的 workflow-builder 画布）✓。三栏节点编辑器是该范式的标准形态，原型视觉也对路。
- **小确认**：observer/观察席通常不靠 `CollabRule` 连线驱动（它只看），但原型里 观察 节点也连了边。请明确观察席**是否需要边**，还是仅 `isObserver` 标记即可，避免画出无意义连线。

---

## 结论

方向我这边 **过**。进实现前请先补：

1. **B1**：chip → `do` 完整预设表，对齐 `taskteam-config-store` 的种子规则（`reject_to_rework` 等）——**这是开工前必须定的**。
2. **B2 / B3**：各补一句话即可。

强烈建议：把"画布默认预设规则库"**直接复用 `taskteam-config-store` 的种子规则**，保证配置器产出与引擎完全同构——既消除 B1，也让"画布即引擎"成为结构性保证而非约定。

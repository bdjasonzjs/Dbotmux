# 流程化画布 · quorum cohort 修复复核（克劳德初号机）

> Reviewer = 克劳德初号机。已核实代码 + 亲自重跑单测（worktree `feat/taskteam-flow-config@0e1f5b98`）。

## 一、quorum cohort 修复 —— 核实通过 ✅

我上一轮提的「每席唯一通过出口 vs 同 roleId 多票席」冲突，本轮已正确修复：

- `validateCanvas` 把「通过出口唯一 / 缺通过出口 / 缺驳回」三处校验**从按 slotId 改为按 roleId cohort 聚合**：
  - `reviewerRoleIds` 去重后逐 role 统计 `passOut`（任意同 role 票席的 pass-next/pass-report 边），`>1` / `==0` 才报错；
  - 同 role 多票席（quorum cohort）共用 1 条通过出口，额外票席仅投票、不再被要求各自连出口；
  - 驳回校验同样改 per-role（warn）。
- 这与引擎按 roleId 路由 `when.fromSlotId`（`engine.ts:95`）一致——cohort 在引擎眼里是同一来源，整体一条规则即可，不再双触发。✅

证据核实：本地重跑 `vitest run test/taskteam-canvas-data.test.ts` → **23 passed**（含本轮补的 2 例：同 role 两票席各画 report 报错 / 只代表席连 report+票席仅投票 quorum=2 合法）。逻辑与测试都对。

## 二、唯一仍 open：F1（我前几轮已提）

🟡 **F1（中 · 真 bug，改动小）：自由文本角色名进分隔串 `slots`（第 341 行未变）。**
- `${slotId}:${roleId}:${name}` + `join(',')`，`name` 仍未 strip/escape；角色名是 Inspector 自由输入。
- 名字含 `,` 或 `:` → `buildTypePayload` 切分错位 → 抛「席位格式」错挡住保存。
- 修法：label 不进分隔串，或保存前 strip/escape，并补 1 单测。

## 三、结论

**可放行 ✅。** 所有结构性 / 拓扑 / quorum 校验均已正确收口，单测我已重跑全绿，E2E 上轮亲验真实，无方向性问题。

**F1 是我这边唯一仍挂着的项**——真 bug、改动很小、属"产品级质量"应收口，但不阻塞放行。建议进实现细化/合码前顺手收掉。其余我无新增 challenge。实现阶段仍待松松对 3 方向问题拍板。

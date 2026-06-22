# 流程化画布 · 剩余 P1 修复终审（克劳德初号机）

> Reviewer = 克劳德初号机。已核实代码 + 亲自重跑数据层单测（worktree `feat/taskteam-flow-config@d80b94ad`）。

## 一、本轮两处修复 —— 核实通过 ✅

| 修复 | 结论 | 核实 |
|---|---|---|
| ① 审核席「通过」出口唯一 | ✅ **正确** | `validateCanvas`：每个 reviewer 的 `pass-next`+`pass-report` 合计 `>1` 报错、`==0` 报错，恰好 1 条才过。语义对——避免一次 `review-pass` 同时触发"请下一审"和"汇报"两条规则。比上版只查 pass-next≤1 更严谨。 |
| ② 审核链无环 | ✅ **正确** | 从 `submitEdges[0].to` 沿 `passNextOf` 单链遍历，命中已访问即判环报错。因①已保证每席至多一条 pass-next，图退化为简单链，这个走法充分。 |

单测：我本地重跑 `vitest run test/taskteam-canvas-data.test.ts` → **21 passed**（含本轮补的 2 坏例）。E2E 上一轮我已亲跑确认真实，本轮纯校验逻辑增量、未动 assemble/engine 路径。

## 二、仍 open：F1（我前两轮已提，至今未修）

🟡 **F1（中 · 真 bug）：自由文本角色名进分隔串 `slots`。**
- 第 336 行仍是 `${n.slotId}:${n.roleId}:${n.name}` + `join(',')`，`name` 未做任何 strip/escape；角色名是 Inspector 自由输入框。
- 用户把角色名改成含 `,` 或 `:`（如「前端,后端」「审核:细节」）→ `buildTypePayload` 切分错位 → 抛「席位格式应为 slotId:roleId」这种看不懂的错，**合法名字被挡住保存**。
- 本轮新增坏例仍是拓扑类，未覆盖此例。
- 修法很小：label 不塞进分隔串（label 可选、省了也行），或保存前 strip/escape `,:`，并补 1 个单测。
- 不是放行 blocker，但属"产品级质量"应收口的项。

## 三、一处请确认（边界，非断言 bug）

🟠 **「每席唯一通过出口」与「同角色多席=quorum 票席」可能冲突——请执行者判断。**
- §校验里有一条豁免：reviewer 不在主链上但与链上某审 **同 roleId** 时按 quorum 票席放行。
- 但本轮新规则要求**每个 reviewer 席都恰好 1 条通过出口**。若真存在「同 roleId 两席凑 quorum」：
  - 只给链上那席连通过出口 → 另一票席被判「缺通过出口」error；
  - 给两席都连通过出口 → 引擎按 role 匹配 `review-pass` 规则，两条 pass 规则会**同时命中、双触发** request-review/report（`engine.ts` emit 不去重）。
- 即这两条规则在 quorum-cohort 场景下互相矛盾。
- **我未完整验证 UI 是否真能把同一已存角色绑进多个席位**（模板拖拽每次铸唯一 roleId，只有「已存角色」重复绑才触发）。所以这是**请确认项**：要么 quorum-cohort 当前不可达（那就没事，建议加注释说明），要么需要把「通过出口唯一」校验改成**按 roleId 而非按 slotId** 聚合。

## 四、结论

**主线可放行 ✅。** 本轮两处 P1 修复正确、单测我已重跑全绿，结构/范式无问题。

- **F1** 仍 open（真 bug、改动小），建议这次一起收掉再算"完成"；
- **三的 quorum-cohort 冲突**请执行者判断是否可达——可达则改按 roleId 聚合校验，不可达则加注释豁免。

两者都不影响画布范式与 schema 映射主线，不必为此卡死放行。实现阶段仍待松松对 3 方向问题拍板。

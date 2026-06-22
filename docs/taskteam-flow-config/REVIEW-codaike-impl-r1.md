# 流程化画布首版实现 · Code Review（蔻黛克斯）

> Reviewer 视角，已逐项核实代码（worktree `feat/taskteam-flow-config@3ea8272e`）。
> 审阅：`taskteam-canvas-data.ts`（纯函数）+ `taskteam-canvas.ts`（UI）+ `test/taskteam-canvas-data.test.ts`，并回到 `taskteam-engine.ts` / `taskteam-config-store.ts` 对照运行时语义。

## 一、四个重点 —— 核实结论

| 重点 | 结论 | 证据 |
|---|---|---|
| ① §6 chip→CollabRule 映射 | ✅ **正确** | `CHIP_META` 四项逐字段对上引擎语义：submit→request-review、pass-next/pass-report 带 `carryFrom`(fromSlotId)、**reject→`nudge`（非 rework）**。且引擎 `engine.ts:95` 是 `roleOfSlot(fromSlotId)` **按 role 匹配**，data 层存 slotId、引擎解析到 role，一致。 |
| ① §7 reviewOrder 派生 | ✅ **正确（含首轮）** | `deriveReviewOrder` 从 `submit-review` 边 target 起算（首轮 reviewer），沿 `pass-next` 链追加，带 cycle guard。与复审 R3 的修正一致。 |
| ① §8 Role.io 派生 | ✅ **正确** | `deriveRoleIo` 按 roleId 聚合入/出边对端、Set 去重；保存时回填 `RoleForm.fromRoleIds/toRoleIds`。画布为唯一来源。 |
| ② assembleSaveOps 三组 payload | ✅ **合法** | role（跳过 fromExisting、roleId 去重）+ rule（每边一条、ruleId `nextId` 去重、仅 carryFrom 带 fromSlotId）+ type（slots/rules/policy，reviewOrder+reviewRounds 派生）。全程复用 `build*Payload`，未自造 JSON。 |
| ③ 超返工升级不作连线规则 | ✅ **确认** | `assembleSaveOps` 只从 4 种 chip 产出规则，**永不产出 `do=escalate`**；`review-reject` 只出 `→nudge`。升级是 `maxRework` 引擎内置兜底（`engine.ts:150-154`）。与 R3 §6 决议一致。 |

**额外验证（非要求项，但关键正确性）**：多层同类 review（拖两个「审核」）——`addNode` 每次 `nextId('tt_role_…')` 铸**唯一 roleId**，引擎按 role 路由 fromSlotId 能区分各层，不会串。✅

测试方面：10 个数据层单测覆盖了派生/校验/assemble 关键路径，方向对。

## 二、发现的问题（往严了挑）

🟡 **F1（中 · 真 bug，建议实现细化时修）：自由文本 `name` 打进分隔串 `slots`，含 `,` 或 `:` 会破坏 type payload。**
`assembleSaveOps`：`slots = `${slotId}:${roleId}:${name}``，`join(',')`；而 `buildTypePayload` 先按 `,` 再按 `:` 切。用户在 inspector 把角色名改成「前端,后端」或「审核:细节」→ 切分错位 → `buildTypePayload` 抛「席位格式应为 slotId:roleId」（或丢 label）。**合法名字被一个看不懂的错误挡住保存**，不符合"产品级质量"。
建议：label 不塞进分隔串（label 可选，省略即可），或保存前 strip/escape 掉 `,` `:`。

🟡 **F2（低-中）：保存非原子，中途失败留孤儿 role/rule。**
顺序跑 N×role + N×rule + 1×type，`op#k` 失败即 `return`，前面已 upsert 的 role/rule 已落库、type 未建。重试可幂等收敛（id 稳定），但用户放弃即留孤儿。admin 工具可接受，建议失败提示补一句"已保存 k 项、其余未提交，修复后可重试"，让状态可预期。

🟢 **F3（nit）：`idSafe` 把中文名折成 fallback**，roleId/slotId 变 `tt_role_role` / `tt_role_role-2`。功能上 `nextId` 保唯一且合法、不影响运行，仅可读性差。可选改进（拼音/序号/允许 ascii 片段），不阻塞。

🟢 **F4（nit）：派生/校验假设 review 链是线性单链**（submit 取第一条、pass-next 单链）。多条 submit-review 边 / 分叉审链不支持。当前产品形态（单开发→多层审）够用，但建议：注释声明该约束，或对"多条 submit-review 边"给个 warn，避免静默取首条。

## 三、结论

**首版实现可放行 ✅** —— ①②③ 全部经代码核实落实，映射/派生/兜底语义与引擎一致，无方向性问题。

- **F1 是真 bug**（自由文本进分隔串），建议在实现细化阶段修掉再视为"完成"；
- F2 补个失败提示；F3/F4 酌情。

均为实现细节层面，不影响画布范式与 schema 映射这条主线。后续实现阶段仍待松松对 3 个方向问题拍板。

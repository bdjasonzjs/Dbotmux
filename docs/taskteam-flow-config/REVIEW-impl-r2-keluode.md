# 流程化画布实现整改 + E2E 复审（克劳德初号机）

> 署名更正：本系列 review 的作者是**克劳德初号机**（Claude reviewer 席位）。此前几份文档我误把署名写成了「蔻黛克斯」——那是本群另一位 Codex reviewer 的名字，容易和我混淆，特此更正，后续统一署名克劳德初号机。
>
> Reviewer 视角，已逐项核实代码 + **亲自重跑 E2E**（worktree `feat/taskteam-flow-config@89c05893`）。

## 一、整改逐条核实

| 项 | 结论 | 证据 |
|---|---|---|
| **P1-1** chip 源/目标 kind 约束 + 硬校验 | ✅ **过** | `allowedChips()` 四种 kind 组合正确（dev→rev=submit、rev→rev=pass-next、rev→rep/dev=pass-report、rev→dev=reject）。`validateCanvas` 新增硬校验：悬空连线、chip-kind 不匹配、**唯一首审**（>1 报错）、**审核链无分叉**（每 reviewer ≤1 pass-next）、**所有 reviewer 必在链上或同 roleId quorum 票席**、末级须 →report。9 个坏例单测覆盖到位。 |
| **P1-2** typeId 可编辑 + 前缀校验 | ✅ **过** | `TYPE_ID_RE = /^tt_type_[a-z0-9][a-z0-9_-]*$/` 允许下划线/连字符；空 & 非法前缀均 error，单测覆盖。 |
| **P2-1** Inspector 配 kind + isObserver | ✅ **过** | 角色名称/kind/isObserver 均 Inspector 可改；按松松方向③不写死 5 类模板卡，改 Inspector 配 kind——方向一致。 |
| **P2-2** 已存角色只绑不改 io + reasoningEffort | ✅ **过** | `assembleSaveOps` 跳过 `fromExisting` 角色的 role-upsert（只新建 RoleSlot），故库里原 io 不被画布改写；`deriveRoleIo` 注释明确该语义；`loadExistingRoles` 补 `reasoningEffort`。 |
| **E2E**（scripts/ttc-e2e-proof.ts） | ✅ **真实**（我亲自重跑） | 隔离真 store/admin/engine：upsert 真落库 → config-list 读回（重跑后 roles=7/rules=8/teamTypes=2，幂等再 upsert，证明是真持久化 store）→ 真建组 → submit → **status=reviewing**、产出 `request-review→tt_slot_rev`。结论成立。 |

额外：引擎规则作用域（`type.rules` scoped）经 E2E step4 验证——只用本 type 的规则驱动，不被 store 里 seed 规则污染。✅

## 二、仍未处理（我上一轮 F1，本轮整改清单未含）

🟡 **F1 仍在 open（中 · 真 bug）：自由文本角色名进分隔串 `slots`，含 `,` 或 `:` 会破坏 type payload。**
- 已确认角色名是 Inspector 自由输入框（`field('角色名称', node.name, …)`），用户可改成「前端,后端」「审核:细节」。
- `assembleSaveOps` 第 317 行仍是 `${n.slotId}:${n.roleId}:${n.name}`，`join(',')`；`buildTypePayload` 先按 `,` 再按 `:` 切 → 切分错位 → 抛「席位格式应为 slotId:roleId」这种用户看不懂的错，**合法名字被挡住保存**。
- 9 个新坏例单测覆盖了拓扑类校验，但**没有覆盖名字含分隔符**这一例。
- 建议（小改）：label 不塞进分隔串（label 可选，省略即可），或保存前 strip/escape `,` `:`；并补一个对应单测。

## 三、小 nit（不阻塞）

🟢 E2E proof 脚本 step2 打印的「submit 规则」取到的是 store 里的 seed 规则 `tt_rule_submit_to_architect`，而非本 e2e 的 `tt_rule_submit-review_tt-slot-rev`（脚本取了第一条 submit 规则）。**仅展示取值不精确**，step4 引擎实际驱动用的是本 type 的规则（routed→tt_slot_rev 正确）。建议脚本按 teamType.rules 过滤后再打印，免得证据看起来自相矛盾。

## 四、结论

**可放行 ✅。** P1-1/P1-2/P2-1/P2-2 全部经代码核实落实，E2E 我已亲自重跑确认真实，引擎按 upsert 的规则驱动 submit→reviewing 成立，无方向性/结构性问题。

唯一建议进下一步前顺手收掉 **F1**（自由文本进分隔串，真 bug、改动很小）+ 三的脚本 nit。两者都不影响范式与 schema 映射主线，不必为此卡住放行。实现阶段仍待松松对 3 方向问题拍板。

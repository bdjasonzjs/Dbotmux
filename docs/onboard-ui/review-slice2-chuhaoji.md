# 第二刀「用模板建真群」复审 — 克劳德初号机（reviewer）

复审对象：feat/onboard-ui working tree（未 commit）。新增 task-team-build.ts + dashboard.ts(available-bots/聚合 create) + daemon.ts(create-from-template 服务端组装) + taskteam-runtime.ts(userOpenIds 透传)。逐文件读真代码、对信任边界 + 用户进群合同核（带行号），不靠"看着对"。

**整体：两个合同真落地、对码准确、边界守住，可放行（建议先确认/改 1 个 transferOwnerTo 点）。** companyId 那条 carry-over 这刀也闭合了。

---

## 信任边界合同 —— ✅ 真落地

- **前端只给意图、不给身份**：task-team-build.ts:114 只 `POST /api/taskteam-create {typeId, selectedBotBySlot, goal}`，无 roleInstances/binding/botOpenId（注释 line 3 也声明）。✅
- **服务端组装 binding**：daemon `/api/taskteam-create-from-template` 读 `type.roleSlots`（按 typeId）+ `bots-info.json` 的真实 botOpenId，逐 slot 组装 `binding={bindingId, botOpenId(服务端源), larkAppId}`；`selectedBotBySlot` 缺项 / appId 无 openId → 收集 problems → **409 role_binding_invalid**（带 problems+neededSlots）。浏览器供不了 openId。✅
- **available-bots 与组装同源**（关键一致性，我特意核了）：dashboard `GET /api/available-bots` 的 `usable` 也取自**同一份** `bots-info.json`（`usable=!!botOpenId`），与 from-template 的 openId 源一致。`bots-info.json` 是真实文件（~/.botmux/data，2974B，cli 探测写入）。**不会出现"前端显示可选、后端 409 拒"的自相矛盾**。✅

## 用户进群合同 —— ✅ 真落地（一处 🟡）

- **无 operator → 建群前 409 堵 fallback**：dashboard 聚合层用 `pickCreatorForGroup(selectedIds, …resolvedAllowedUsers)` 选 creator，`operator=pick.userOpenIds[0]`，**空就 409 no_operator_open_id**（带"先给 bot 绑 owner/allowedUsers"的提示），不建无人可见的群。✅ 完全对应合同。
- **userInvited 不静默**：from-template 包一层 createGroup 捕获 `invalidUserIds/notifyError`，算 `userInvited=!op || !invalidUserIds.includes(op)`，连同 invalidUserIds/notifyError 一起透出。✅（invite 这条不静默）

## companyId carry-over —— ✅ 闭合
from-template：`companyId = body.companyId ?? 'tt_company_onboard'`，goal/acceptance 也给了默认。我前几轮交底的必填项缺口这刀补上了。✅

## 边界 / legacy —— ✅
`CreateTaskTeamParams.userOpenIds` 是**可选**新增、`createTaskTeam` 透传给 createGroup；新开 `create-from-template` 端点，**legacy `/api/taskteam-create`(daemon IPC) 未动**。向后兼容。停 working tree、未 commit。✅

---

## 🟡 值得改：transferOwnerTo 是契约外动作 + transferError 被静默

daemon from-template 给 createGroupWithBots 传了 `transferOwnerTo: body.notifyOwnerOpenId`——这会把**飞书群的群主权转移给用户**，超出"拉用户进群(invite)"的合同范围。两个问题：
1. **是否在范围内 / 是否有意为之？** 若产品意图是"用户拥有自己的群"，可保留；但这不在 v4/v5 合同里，建议确认（不是默认就该转群主）。
2. **transferError 被静默**：`CreateGroupResult` 有 `transferError/ownerTransferredTo`（group-creator.ts:81-82），但 from-template 的 `groupResult` 只捕获 `{invalidUserIds, notifyError}`、**丢了 transferError**。所以"邀请成功但转群主失败"会 userInvited=true 却悄悄没转成——违背"不静默"的精神。若保留 transferOwnerTo，请把 transferError/ownerTransferredTo 一并透出。

## 🟡 低优：companyId='tt_company_onboard' 的 org 可能不存在
from-template **不调 ensureSeed()**；若 config 没种过 seed org，建出的 team 引用一个悬空 companyId（runOnboarding 路径有 ensureSeed，这个新端点没有）。建议 ensureSeed() 或建前校验 company 存在，免得下游 org 绑定/observer 扫描出问题。

## 🟢 nit
- **path 重载**：dashboard `POST /api/taskteam-create` 的形状/语义（只收 selectedBotBySlot）≠ daemon legacy `/api/taskteam-create`（收完整 roleInstances），同名不同义分两层，易误导后人。建议聚合层也叫 `/api/taskteam-create-from-template`。
- **真群线上 E2E 未做**：执行者已诚实标注"待部署体验补"。后端隔离 PASS，但飞书真群+用户真在群里未端到端验证——本刀范围可接受，gate 时知悉即可。

---

## 结论
第二刀**信任边界 + 用户进群两合同真落地、对码准确、companyId 闭合、边界守住**。建议执行者：①确认 transferOwnerTo 是否有意 + 若保留则把 transferError 透出（不静默）；②（低优）ensureSeed/校验 companyId org。改完即可放行。真群 E2E 按执行者诚实标注留部署体验补。

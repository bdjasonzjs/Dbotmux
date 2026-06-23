# 设计稿 v4 复审意见 — 克劳德初号机（reviewer）

复审对象：`docs/onboard-ui/design.md`（v4 信任边界收口版）。两个核心合同 + config-list 逐条对真实代码核过（带行号）。注：v4 是**设计稿**，下面评的是合同是否健全/可实现，不是"是否已编码"。

**整体结论：你问的两个合同（信任边界 / 用户进群）都真闭合、可实现，架构方向对。进实现前只差补 1 个 companyId 来源（🔴 一句话决策）+ 定 goal/acceptance 收集屏（🟡）。** 比 v3 又紧一圈，很接近放行。

---

## 合同① 信任边界（§6/§3.2 服务端组装 roleInstances）—— ✅ 闭合、可实现

- 架构方向**正确**：v3 把组装放前端、靠"re-plan ready 复校"——那只证明"有足够 bot"，挡不住浏览器伪造 `binding.botOpenId/larkAppId`。v4 移到**服务端组装**是对的解法。
- 可信源**确认存在**：`TaskTeamType.roleSlots: TaskTeamRoleSlot[]`（taskteam-schema.ts:108），`TaskTeamRoleSlot = {slotId, roleId, label?}`（:78-82）。服务端按 typeId 读回 roleSlots 拿 slotId/roleId，`selectedBotBySlot` 按 slotId 键**对得上**。assembleSaveOps 的 type-upsert 已持久化 slots（canvas-data.ts:341/345，画布配置器现行路径）。
- botOpenId 服务端真实取得：`getBotOpenId(appId)` 现成（bot-registry.ts:175）。浏览器供不了、校验不过 409 的合同**可落地**。
- 校验链（appId 存在 ∧ ∈usableBots ∧ getBotOpenId 非空 ∧ slot 数对齐，否则 409）逻辑自洽。

→ 信任边界合同闭合。

## 合同② 用户进群（§3.2 fallback 堵 + 返回形状）—— ✅ 闭合、可实现

- **fallback 漏洞识别准确**：`pickCreatorForGroup` 确会 fallback 到无 allowlist 的在线 bot 并跳过邀请（operator-selector.ts:28-51）。v4 用"creator 无 operator open_id → 建群前 409"堵住，**绝不建无人可见的群**——对 onboarding 是对的强约束。
- **返回形状 plumbing 识别准确**：`createGroupWithBots` 返回确有 `invalidUserIds/notifyError`（group-creator.ts:75-87），但 `defaultCreateTaskTeamDeps.createGroup` 现把它截断成 `{chatId}`（taskteam-deps.ts:49-58），daemon route 也只返 `{ok,teamId,chatId,status}`（daemon.ts:1463）。v4 正确点出要扩**三层**（deps.createGroup 返回类型 / createTaskTeam 返回 / daemon route 响应）才能把 `userInvited` 透到 dashboard。这正是 v3 P1-2"落不了"的根因，v4 收对了。

→ 用户进群合同闭合。

## P2 config-list（§3.1 补 GET）—— ✅ 闭合

`loadExistingRoles()` fetch 的是 `/api/taskteam-config-list`（canvas-data.ts:374），dashboard 现只有 `GET /api/task-team/config`（task-team-api.ts:35-59）→ 撞 404。v4 补兼容 `GET /api/taskteam-config-list` 返 `readTaskTeamConfig()`、画布数据层不动，对。

---

## 🔴 仍开口（进实现前需定）：companyId 来源

我 v3 标过的"建实例必填项来源"，v4 收了一半：**goal/acceptance 这轮进了 create 入参合同（✅）**，但 **companyId 依然不在合同里**——
- §3.2 / §6 入参都定为 `{typeId, selectedBotBySlot, goal, acceptance}`，**没有 companyId**；
- 而 `CreateTaskTeamParams.companyId` 是**必填、无默认**（taskteam-runtime.ts:152）；
- §6 服务端组装只讲 roleInstances，没讲 companyId 从哪来。

→ 服务端调 `createTaskTeam` 时这个必填项空着，编译不过/运行报错。建议服务端补：默认 `companyId='tt_company_onboard'`（seed 已种，taskteam-config-store.ts:244），或加 company 选择。一句话决策，但不补建实例跑不通。

## 🟡 goal/acceptance 的 UX 收集点未定

入参有了 goal/acceptance，但 §5 向导步骤里"存成能用的小组"(建实例) 这步之前，**没有让用户输入目标/验收的屏**（dry-run 的小目标在更后、且可选）。需在建实例步前加一个轻收集（一句话目标 + 一句话验收），否则入参字段没数据来源。

---

## 结论
两个核心合同（信任边界 + 用户进群）**真闭合、可实现**，config-list 也收对，架构方向正确。**进实现前补两点即可放行第一切片**：
1. 🔴 定 companyId 来源（默认 tt_company_onboard / company 选择）——必填项，不定跑不通；
2. 🟡 在建实例步前加 goal/acceptance 轻收集屏。
补完这两点，第一切片可以开实现。

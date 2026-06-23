# 设计稿 v2 复审意见 — 克劳德初号机（reviewer）

复审对象：`docs/onboard-ui/design.md`（v2）。已对照真实代码逐条核地面真相（带行号），不靠"看着对"。

整体：v2 范围重定（给画布配置器套向导壳）方向清晰，且对现成代码的描述**准确**——`/api/taskteam-create`(daemon.ts:1455)、`createTaskTeam`(taskteam-runtime.ts:167)、`planOnboarding`/`runOnboarding`(taskteam-onboard.ts:55/134)、`assembleSaveOps`/`validateCanvas`(taskteam-canvas-data.ts:292/170) 的签名与字段我都核过，与设计一致。作者确实读了码，不是臆造。

下面按你给的三个复核点 + 额外发现，标了优先级。

---

## 焦点①：落库 + 建实例桥接是否成立

**主干成立**：`validateCanvas(team)→ValidationIssue[]`（error 挡下一步）→ `assembleSaveOps(team)→SaveOp[]`（N role-upsert + N rule-upsert + 1 type-upsert）→ `postAdmin`，再 `/api/taskteam-create`。这条链每一环代码都在，桥接逻辑成立。

但桥接的**最后一公里有两个真缺口**，都卡在 `/api/taskteam-create` 的入参上：

### 🔴 P1-1 建实例的 goal / acceptance / companyId 没人喂
`CreateTaskTeamParams`（taskteam-runtime.ts:151-161）里 `goal: string`、`acceptance: string`、`companyId: TaskTeamCompanyId` **都是必填**（非可选）。但 §4 的向导步骤里：
- "存成能用的小组"(建实例) 排在"（可选）当场跑一遍"**之前**；
- goal 只在最后那个**可选** dry-run 步才出现；acceptance、companyId 全程没收集。

→ 也就是说走到建实例那步时，这三个必填项无来源。要么调整步骤顺序（建实例前先收 goal+acceptance），要么明确 companyId 的默认/来源、并决定 goal/acceptance 缺省时给什么（空串能过 typecheck 但语义上是个没目标的组）。**这是焦点①的桥接断点，必须在设计里定掉。**

### 🟡 P2-2 seat → roleInstance 的字段映射没写清
§4 "roleInstances 由 botGap 那步的席位→bot 分配产出"——但 `OnboardingSeat{slotId,roleId,observer,assignedBot}`(taskteam-onboard.ts:19) → `TaskTeamRoleInstance[]` 的字段映射没给，也没确认 `TaskTeamRoleInstance` 的所有必填字段都能从 seat+bot 取到。建议补一张映射表，确认 1:1 可转。

---

## 焦点②：上轮 4 个 P1 是否真改到位

**在设计叙述层 4 个都改到位了**（注意：是"设计层"，代码还没写，落地时要回验）：

| 上轮 P1 | v2 处理 | 评 |
|---|---|---|
| 向导自有状态 | §8：客户端持 currentStep + CanvasTeam 草稿 + localStorage，明确"不把 plan.steps 当状态源" | ✅ 到位 |
| 补 bot 诚实合同 | §6：加现成 bot 主路径无需扫码；克隆走 cloneBot/ceo-spawn 而非 bot-onboarding，理由（不继承模型/无 openId 被滤）与代码一致 | ✅ 到位 |
| 验收两段 | §7：拆"配置+落库"/"真实引擎跑通"，且点明看 `status` 不是 `reviewState`、不承诺单次 create 跑完全程 | ✅ 到位 |
| 席位动态 | §7.2：按 `plan.seats` 动态渲染、不硬编码 3 席（两层 review = 4 席） | ✅ 到位 |

---

## 焦点③：§6 ceo-spawn sessionId 未决依赖处理是否合理

**态度对（诚实标注 + 承诺实现前先确认），但深度不够，有两处要修：**

### 🔴 P1-3 真正的拦路虎是"扫码 UX 本身 chat-bound"，不止 sessionId
核过 `ceoSpawn`(ceo-spawn-service.ts:106-128)：无 sessionId 直接 403，且 `cloneBotInChat` 把**二维码投到群**、`reply` 靠 `rootMessageId` 在群里回执、owner 在群确认。整个克隆激活 UX 是**聊天原生**的。
→ dashboard 无 chat，不只是"拿不到 sessionId"，是**二维码根本没地方显示、owner 没法在群里确认**。§6 两个选项（透传 ownerOpenId / 克隆先只做激活）都默认克隆机制能 headless 跑，但**二维码投递通道这层没解**。
要么 v1 把"克隆"那步交还给一个真实 chat（如管理群）去走现成 ceo-spawn，要么得新建 web 端二维码展示面——后者工作量远大于改 sessionId。**这是 v1 范围决策，建议你（执行者）上报父群让松松定边界，别在设计里自己拍。**

### 🟡 P2-4 §6 措辞：要透传的首要字段是 larkAppId，不是 ownerOpenId
ceo-spawn 真正硬依赖的是 `session.larkAppId`（CEO bot 身份）+ chatId + rootMessageId；ownerOpenId(senderOpenId) 只在扫码确认环节用。sessionless 改造首要透传的是 **CEO bot 的 larkAppId**。§6 写成"透传 ownerOpenId"会让实现时找错参数，纠一下。

---

## 额外发现

### 🟡 P2-5 §5.3 与 §6 关于 bot-onboarding 自相矛盾
§5.3 把 `/api/bot-onboarding/*` 列为"补 bot 扫码"复用项；§6 又明确说克隆"不是 bot-onboarding"。澄清 bot-onboarding/* 在补 bot 流程里到底担什么角色（还是其实不用、该从复用列表删）。

### 🟡 P2-6 plan 读的是已持久化 config，不是内存草稿（建议显式写出）
§5.1 `planOnboarding({config,...})` 的 `config` 是服务端从持久化配置读的。所以"看 bot 够不够"必须在"存成小组类型"(type-upsert 落库)**之后**、用新 typeId 当 sampleTypeId 才能按本小组算——§4 的步骤顺序已经对，但设计没点明这个隐性依赖（内存草稿单独不行；存完后又回去改草稿会 stale）。一句话写清，省得实现时踩。

---

## 结论
方向 + 主干桥接成立，对码事实准确，4 个上轮 P1 设计层已改到位。**放行前需先定掉 P1-1（建实例必填项来源）和 P1-3（克隆扫码 UX 的 v1 边界，建议上报父群）**；P2 几条是该补清的接线细节。建议执行者改完 P1 两点 + 补 P2 后再请复审。

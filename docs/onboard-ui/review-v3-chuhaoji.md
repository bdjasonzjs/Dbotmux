# 设计稿 v3 复审意见 — 克劳德初号机（reviewer）

复审对象：`docs/onboard-ui/design.md`（v3 合同收口版）。三个合同 + §6 转换表逐条对真实代码核过（带行号）。

**整体**：进步很大。三个硬合同**都真可实现、对码准确**，§6 转换表成立，作者确实读了码（proxyToDaemon、groups/create、ceo-spawn、TaskTeamRoleInstance shape 我都核了，描述属实）。**但有一个 v2 提过的 P1 漏在这轮收口清单外，仍是开口**——见下。

---

## 三个合同核验结果

### ✅ 合同① §3.1 dashboard 写代理（proxyToDaemon）——成立
- `proxyToDaemon(larkAppId, daemonPath, init)` **现成存在**（dashboard.ts:237-248），sessions/workflows 路由已用同款范式代理写操作到 daemon。
- 现状缺口属实：`handleTaskTeamApi` 只处理 GET、POST 在 task-team-api.ts:36 被 `return false` 挡掉 → 落 404。v3 把它标为"新建实现项"而非"已有"，**诚实纠正了 v2 自己写错的'已有代理'**。✅
- 工作量真实：按 workflow-api.ts 范式给 taskteam POST 路由接上 proxyToDaemon，约 200 行。链路通。

### ✅ 合同② §3.2 userOpenIds + app-scope open_id + 邀请失败不静默——成立
- `createGroupWithBots`（group-creator.ts:89）确实支持 `userOpenIds`，底层 `createChat` 用 `user_id_type='open_id'`（groups-store.ts:99）透传。v3 说"类型没串字段→永远 undefined"的诊断方向对。
- app-scope 取 creator bot 的 `resolvedAllowedUsers`——**正确**。代码里有 `assertCreatorAppScope`（taskteam-scope.ts）专门兜跨 app open_id 的 99992361 错误，取 creator 同源 open_id 是对的做法。✅
- 邀请失败不静默：ground truth `group-creator.ts:202` 返回 `invalidUserIds`、不抛错。v3 的 `{ok:true,userInvited:false,warning}`+重试入口 与之吻合。✅

### ✅ 合同③ §4 clone 裁剪（第一切片只加现成 bot / clone 置灰 / ceo-spawn 另设独立 API）——成立且正确
- ceo-spawn 确实硬依赖 session/chat（ceoSpawn→getSession，ceo-spawn-service.ts:106；QR/状态发到 chat）。
- 第一切片置灰 clone + 另设独立 dashboard clone API 作后续——**干净解决了我 v2 提的"QR 是 chat-bound、dashboard 无处显示"死结**，把大工作量正确推到后续切片。这一刀切得对。✅

### ✅ §6 CanvasTeam→roleInstances 转换表——成立
核 `TaskTeamRoleInstance`（taskteam-schema.ts:135-140）+ `TaskTeamRoleBinding`（:128-133）vs `OnboardingSeat`（taskteam-onboard.ts:19）：所有必填字段都能推出——slotId/roleId 取自 seat，binding.botOpenId/larkAppId 取自 assignedBot，roleInstanceId/bindingId 派生生成。未绑阻断 + 服务端复校 ready===true 防漂移，逻辑对。✅

---

## 🔴 P1（carry-over，仍未收口）：建实例的 goal / acceptance / companyId 来源

我 v2 复审标过 P1 的"建实例必填项无来源"，**不在这轮收口的三个合同里，v3 也没补**。核 ground truth 确认问题仍在：
- `CreateTaskTeamParams`（taskteam-runtime.ts:151-161）的 `goal`/`acceptance`/`companyId` **都是必填、createTaskTeam 内无默认值**。
- 只有 `runOnboarding` 才喂默认（companyId ?? 'tt_company_onboard'、goal ?? '示例小目标…'、acceptance 硬编，taskteam-onboard.ts:170-172）——**但向导走的是 §3.2 直连 `/api/taskteam-create`，不是 runOnboarding**，拿不到这些默认。
- §5 向导步骤里"存成能用的小组"(建实例) 排在"可选 dry-run"(给小目标) **之前**，建实例时 goal/acceptance 还没收集；companyId 全程没定来源。

→ 第一切片走到建实例会缺这三个必填项。建议明确收口：
- **companyId**：用 seed 已有的默认公司 `tt_company_onboard`（taskteam-config-store.ts:244 已种），或加 company 选择；
- **goal/acceptance**：在建实例步加一个轻量收集（一句话目标+验收），或先占位、dry-run 时回填。
一句话定掉即可，但不定向导跑不到建实例。

---

## 🟡 P2（接线细节）

**P2-1 invalidUserIds 没串上来**：§3.2 要返回 `userInvited:false`，但 `createGroupWithBots` 的 `invalidUserIds`（group-creator.ts:202）现在被 `createTaskTeam` 丢弃（只取 chatId）。要让 `userInvited` 信号到达 dashboard，得把 createGroup 结果透过 `createTaskTeam` 的返回值/响应串上来——**不只是加入参字段，返回 shape 也要带 invite 结果**。

**P2-2 §6 modelOverride 别再 hedge**：§6 写"observer modelOverride 若 schema 支持"——ground truth 确认 `TaskTeamRoleBinding.modelOverride?` 存在（taskteam-schema.ts:128-133），可直接进 binding。建议落定，不留"若"。

**P2-3 §3.1 选 daemon 要容错**：proxyToDaemon 对离线/未知 appId 返 503（dashboard.ts:237-248）。"选首个 bot 的 appId"需保证选**在线**的，建议加 online 过滤/fallback，否则首个 bot 离线时写代理直接 503。

---

## 结论
v3 三个合同都真可实现、对码准确，§6 转换表成立，clone 裁剪切得对。**放行第一切片前需补 1 个 carry-over P1（goal/acceptance/companyId 来源）+ 3 个 P2**。P1 是一句话级别的决策（默认值/轻收集），不大但卡在建实例必经路径上。改完即可放行。

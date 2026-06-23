# 第一刀 working tree 复审 — 克劳德初号机（reviewer）

复审对象：feat/onboard-ui working tree（未 commit）。新增 `task-team-onboarding.ts` + dashboard.ts 写代理/config-list + app.ts 路由 + task-team.ts 入口卡。逐文件读真代码、对 v4 合同核（带行号），不靠"看着对"。

**整体：第一刀扎实、可放行。** 三个 v4 合同（写代理 / 落库复用 assembleSaveOps / 三步复用 canvas-data）+ 松松"配模板=零 bot"纠正**都落对了**，我核到代码层。只有 1 个 P2（kindDefaults/defaultChip 重写非复用，值得趁现在改）+ 2 个 nit。

---

## 合同核验（均 ✅）

### ✅ 写代理 §3.1（选 daemon / 透传 / config-list 兼容）
- `dashboard.ts` 新增块：POST 命中 `{role,rule,type}-upsert` → `target = [...registry.list()].sort(botIndex)[0]`，无则 503 → `proxyToDaemon(target.larkAppId, 同 path, {body 透传})` → 回显 upstream status+body。**符合合同**。
- **我之前 v3 担心的"选 daemon 要在线过滤"——已满足**：`registry.list()` 就是在线集（dashboard.ts:176 `const online = new Set(registry.list()...)` 自证；registry.ts:81 同义）。选的是最小 botIndex 的**在线** daemon。
- config-list GET 兼容**正确无形状坑**：新 GET 返 `readTaskTeamConfig()`，而 daemon 正牌 `listTaskTeamConfig()` = `readTaskTeamConfig()`（taskteam-admin.ts:49-51，完全同一个）→ 形状一致；`TaskTeamConfigFile.roles` 顶层存在（schema:197）→ `loadExistingRoles()` 的 `cfg.roles`（canvas-data.ts:376）取得到。两个读者都对得上。

### ✅ 落库复用 assembleSaveOps（不重写）
`doSave()`（onboarding.ts:377）：`validateCanvas`(error 挡)→ `assembleSaveOps(team)` → 逐 op `postAdmin`，任一失败即停+回显。**全程复用 canvas-data 的纯函数，零重写配置逻辑**。payload 计数与证据一致（一套推荐=dev+reviewer+observer=3角色；autoConnect 出 submit-review/pass-report/reject-rework=3规则；1类型）。

### ✅ 三步配置复用 canvas-data
`allowedChips/validateCanvas/deriveReviewOrder/assembleSaveOps/idSafe/nextId/CHIP_META/类型` 全 import 自 `taskteam-canvas-data.js`（onboarding.ts:7-23）。CanvasTeam 模型/校验/派生/落库都是同一套。

### ✅ 配模板=零 bot（松松纠正落对）
向导四步 起名/加成员/连谁审谁/存好，**全程无任何 bot 选择/盘点/补 bot**。"加成员"加的是纯角色 slot（CanvasNode，仅 model 这种模板级提示，非 bot binding）。产出就是 bot-agnostic 的 TaskTeamType+roleSlots。**完全符合"配模板纯模板、bot 留到建群段"**。

---

## 🟡 P2（值得趁现在改）：kindDefaults / defaultChip 是本地重写，不是复用

`onboarding.ts:48-67` 本地重新实现了 `kindDefaults` 和 `defaultChip`，执行者注释也承认"canvas.ts 里是模块私有，这里按同一语义重述"。核过属实：这俩在 `taskteam-canvas.ts:62/72` 是**模块私有**（没导出），所以向导拿不到、只能重述。

问题：**两份副本要手工保持同步**。若 `canvas.ts` 改了某 kind 的默认 actions/visibility，向导这份不会跟着变 → **同一种角色，画布建的和向导建的会悄悄不一致**。这违背 v4"复用 kindDefaults/defaultChip"的契约精神。
建议（低成本）：把 `kindDefaults`/`defaultChip` 提到纯数据层 `taskteam-canvas-data.ts` 导出，`canvas.ts` 和向导都 import 同一份。当前值虽一致，但趁现在改省后患。

## 🟢 nit-1：loadExistingRoles 预加载后未用
`onboarding.ts:396` 进页面就 `loadExistingRoles()`，结果只 `void existingRoles` 存着没用（注释"后续切片用"）。等于每次进向导白打一次网络请求。建议留到真正用它的切片再加载，或显式标注 intentional preload。

## 🟢 nit-2：入口卡常驻、未做 firstRun 区分
`task-team.ts` 的入口卡是**常驻显示**，没按设计 §3/§8 的"首次进入弹醒目卡 vs 非首次常驻按钮"分。第一刀可接受，但 firstRun gating 还没做——提一句别忘了后续切片补。

---

## 结论
第一刀**质量扎实、合同全中、松松纠正落对**，可放行。建议执行者顺手改掉 P2（kindDefaults/defaultChip 提到数据层复用，10 分钟、消除漂移），两个 nit 可选。不需要返工重做。
（注：companyId 默认值是**下一刀建实例**才需要，本切片纯模板用不上，不在本轮范围。build 绿我未自跑、采信执行者证据 + 代码读无明显类型坑。）

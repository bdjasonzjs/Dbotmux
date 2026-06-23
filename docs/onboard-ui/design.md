# 新手引导（Onboarding）UI — 设计稿 v5（两段彻底分开：配模板=无bot / 建群=有bot）

> 范围（松松 2026-06-22 定 + 当日纠正）：给已做好的「流程化配置器（画布）」套一层"一步步带你走"的向导壳。
> **核心纠正**：把「配模板」和「建真群」两段彻底分开——
> - **第一段 · 配模板向导（onboarding 核心，全程零 bot）**：起名 → 加角色 → 连谁审谁 → 存成一个工作小组**类型**（bot-agnostic 模板）。
> - **第二段 · 用模板建一个真群（单独入口，这才碰 bot）**：挑真实 bot 填角色 slot → 建飞书群（+拉用户进群）→ 可开工。
> 旧"搭公司/root 群"已作废。基线：master；worktree `~/work/Dbotmux_wt/onboard-ui`（feat/onboard-ui）。
> v5 相对 v4 唯一变化：**把"bot 够不够/补 bot/建实例"从配模板向导里拿出来，归到第二段**——数据层本就如此（roleSlots 模板级、binding 建实例才发生），不用改数据层，只是向导不含 bot 步骤。

---

## 一、大白话：这东西是什么

分两段，对应两件事：

**第一段——配模板（不碰任何机器人）**：用户点一张卡，一步步「起名 → 加角色（谁干活/谁审/谁盯，纯角色，不绑机器人）→ 连谁审谁 → 存好」。产出是一个**可复用的工作小组类型（模板）**，存进 config。右边实时画出流程图。这是 onboarding 的核心，**全程零 bot**。

**第二段——用模板建一个真群（这才需要机器人）**：挑现成的机器人填进每个角色，建出飞书群、把用户拉进去，就能开工。"机器人不够 → 加现成的 / 克隆新分身"全在这一段（克隆延后、置灰）。

两段都复用你已做好的画布配置器 + 后端建组能力，不重写逻辑。

---

## 二、现成能复用的零件（已逐一核过代码）

### 前端（画布配置器，客户端 TS，复用核心）
- `taskteam-canvas-data.ts`（纯函数）：`CanvasTeam`、`allowedChips`/`validateCanvas`/`deriveReviewOrder`、`assembleSaveOps`（→三类 upsert）、`loadExistingRoles`。
  - ⚠️ 关键：`CanvasNode` 是**席位（roleSlot）**，不是 bot 绑定。binding（botOpenId/larkAppId）只在第二段建实例才出现。`CanvasNode.model` 字段虽存在于数据层（完整画布编辑器用），但**新手向导第一段不暴露/不设置模型**——模型随第二段挑的 bot 走。所以"配模板向导零 bot"天然成立。
- `taskteam-canvas.ts`：SVG 渲染（向导做只读 mini 预览）。

### 后端（daemon IPC，已存在）
- 第一段（配模板/落库）：`POST /api/taskteam-{role,rule,type}-upsert`、`/api/taskteam-config-list`（daemon.ts:1471-1502）。
- 第二段（建群/有bot）：`POST /api/taskteam-create`（daemon.ts:1455，建群+绑bot+apply team-started）；`POST /api/taskteam-onboard`（runOnboarding，含 planOnboarding botGap）；`addBotToChat`/`pickCreatorForGroup`/`createGroupWithBots`（用户进群）；`listBots`+`getBotOpenId`（真实 bot）。
- taskteam config/store = 全局共享文件 `~/.botmux/data`（taskteam-config-store.ts:28）；所有 daemon + dashboard 聚合进程读写同一份。

---

## 三、第一段：配模板向导（无 bot）—— 第一刀，已实现并验证

### 入口
任务小组 Tab 顶部醒目卡「✨ 第一次用？跟着引导建一个工作小组」→ hash 路由 `#/task-team/onboarding`。

### 向导每步（一屏一步、上/下步、右侧只读 mini 画布预览）
| 步 | 做什么 | 复用 |
|---|---|---|
| 起名 | 小组名 + 自动派生 typeId | 写 `CanvasTeam.name/typeId` |
| 加角色 | 默认预填一套示例（开发工程师/代码审查员/进度观察员），可改名/增删；每角色标含义。**不出现任何 bot、不配模型**（模型随第二段挑的 bot 走） | `addNode` 同款 + `kindDefaults` |
| 连谁审谁 | 「✨ 智能连好」自动连合法流程 + 手动加/删；实时 `validateCanvas` + `deriveReviewOrder` | `allowedChips`/`defaultChip`/`deriveReviewOrder` |
| 存好 | 校验过 → 存成可复用的小组**类型** | `validateCanvas`→`assembleSaveOps`→写代理（§五） |

逃生口「切到完整画布微调」保留。

### 第一段需要的后端接线（§3.1 写代理 + config-list 读兼容）
- 写：`POST /api/taskteam-{role,rule,type}-upsert` 在 `dashboard.ts` 新增代理 → 选一个在线 daemon `proxyToDaemon` 执行（config 共享文件，写哪个都落同一份），状态/错误透传。
- 读兼容：新增 `GET /api/taskteam-config-list`（返 `readTaskTeamConfig`），让画布数据层 `loadExistingRoles` 复用不撞 404。

> 第一刀就是这一段，已实现 + 验证（见 `slice1-acceptance.md` / `shots/`）：build 绿、Playwright 7 截图、存好 payload 正确（3角色+3规则+1类型）、隔离环境真后端 round-trip（config-list 查到新类型）PASS。**全程无 bot**。

---

## 四、第二段：用模板建一个真群（有 bot）—— 紧随的第二刀

单独入口/单独一步（不混进配模板向导）。从一个已存的小组类型出发：

1. **挑 bot 填角色**：`GET /api/available-bots`（服务端 `listBots`+`getBotOpenId`，客户端只勾选 appId）。
2. **盘点够不够**：`POST /api/taskteam-onboard-plan`（服务端读真实 bot + planOnboarding 的 botGap：needed/available/short）。不够 → 引导补：**加现成 bot**（主路径）；**克隆分身**（置灰，ceo-spawn 无 chat session 不能直接复用，另设独立 dashboard clone API 作更后续）。
3. **建实例（信任边界 + 用户进群，v4 已设计、保留）**：
   - dashboard `POST /api/taskteam-create` **只收** `{ typeId, selectedBotBySlot, goal, acceptance }`；**服务端**按已存 `TaskTeamType.roleSlots` + 真实 `usableBots` 组装 `roleInstances`（binding.botOpenId = 服务端 `getBotOpenId`，浏览器供不了）；slot 对不上/选不全/bot 不 usable → 409。
   - 用户进群：creator 取 `pickCreatorForGroup`，operator open_id 取自 creator bot 的 `resolvedAllowedUsers`（app-scope 同源）；无 operator → 建群前 409（堵 fallback，不建无人可见的群）；扩 `createGroup` 返回形状 + route 透 `userInvited/warning`，邀请失败不静默。
4. **（可选）当场跑一遍**：apply team-started + 轮询 `team.status`（running→reviewing→done，非只看 reviewState），贴真实证据。

> 第二段的所有 bot 逻辑（available-bots / onboard-plan / 信任边界 / 用户进群 / 克隆置灰）都归在这里，**绝不进配模板向导**。

---

## 五、CanvasTeam → roleInstances（仅第二段建群时、服务端做）

见第四段第 3 点：服务端按 `TaskTeamType.roleSlots` + `selectedBotBySlot` + 真实 `usableBots` 组装，binding 身份服务端生成。配模板第一段完全不涉及。

## 六、向导自身状态
客户端驱动：内存 currentStep + `CanvasTeam` 草稿（localStorage 可恢复），不拿 plan.steps 当状态源。firstRun 用"是否已存在用户建的类型/实例"判断。

## 七、边界
最大化复用画布+后端建组、不重写配置逻辑；不部署/不重启 botmux/不碰编译配置；同群唯一 worktree；给松松大白话不甩编号。

## 八、刀法
- 第一刀 = 第一段（配模板向导，无 bot）—— **已完成并验证**。
- 第二刀 = 第二段（用模板建真群，挑现成 bot + 服务端建实例 + 拉用户进群），克隆置灰留更后续。

---

## 附：reviewer 复审对照（v2→v5）
| 问题 | 处理 |
|-|-|
| v2 P1 dashboard 写代理不存在 | §3.1 新建代理（已实现于第一刀） |
| v2 P1 ceo-spawn 依赖未决 | 克隆置灰、另设独立 dashboard clone API（更后续）；归第二段 |
| v3 P1-1 create 信任边界 | 第二段：服务端组装 roleInstances，浏览器供不了 botOpenId |
| v3 P1-2 用户进群 + 返回形状 | 第二段：无 operator open_id 建群前 409 + 扩返回形状透 userInvited |
| v3 P2 config-list 404 | §3.1 GET /api/taskteam-config-list 兼容（已实现于第一刀） |
| **v5 松松纠正：配模板混了 bot** | **把 bot 够不够/补bot/建实例从配模板向导拿出，归第二段；配模板向导全程零 bot**（第一刀代码本就如此，无需改码，仅文档分段） |

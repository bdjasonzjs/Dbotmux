# 新手引导 · 第二刀实现验收（第二段「用模板建真群」，挑现成 bot）

> 范围：设计 v5「第二段 · 用模板建真群」（= 第二刀）。worktree `~/work/Dbotmux_wt/onboard-ui`（feat/onboard-ui，base=master）。
> 边界遵守：只停 working tree（未 commit / 未部署 / 未重启 botmux / 未碰编译配置）。克隆置灰、延后。

## 做了什么

1. **挑 bot 的页面**（新文件 `task-team-build.ts`，路由 `#/task-team/build`）：选一个已存模板 → 给每个角色配现成机器人（盯梢/观察角色自动默认便宜引擎 bot）→ 给小目标 → 「建这个真群」。克隆入口置灰标「开发中」。入口：onboarding 存好后「用这个模板建一个真群 →」+ 任务小组 Tab 一行「已有模板？用模板建真群 →」。
2. **GET /api/available-bots**（`dashboard.ts`）：服务端读 `listBots()` + `bots-info.json`（跨进程真实 botOpenId）→ 返回 `{larkAppId,botName,botOpenId,usable,online,isClone}`；`usable = 有真实 openId`。客户端只勾选 appId、供不了 openId。
3. **POST /api/taskteam-create**（`dashboard.ts` 聚合层）：入参只收 `{typeId, selectedBotBySlot, goal?}`；`pickCreatorForGroup` 选 creator + 取 app-scope operator open_id；**没 operator → 建群前 409**（堵 fallback、不建无人可见的群）；其余转 creator daemon。
4. **POST /api/taskteam-create-from-template**（`daemon.ts`，服务端组装）：按已存 `TaskTeamType.roleSlots` + `bots-info.json` 真实 openId **服务端组装 roleInstances**（binding.botOpenId 服务端生成）；slot 选不全/选了不可用 bot → **409**；调 `createTaskTeam`（建群 + 落实例 + team-started），返回 `{teamId,chatId,status,userInvited,invalidUserIds,notifyError}`。
5. **建群拉用户进群**（薄接线）：`CreateTaskTeamParams` 加可选 `userOpenIds`，`createTaskTeam` 透传给 `createGroup`（`createGroupWithBots` 本就支持）；端点包一层 createGroup 捕获 `invalidUserIds`，落 `userInvited:false` 不静默。**未改 legacy CLI 合同**（只加可选字段）。

## 验收证据（不靠"看着对"）

### A. 构建通过
`pnpm build`（tsc + esbuild bundle）全绿。

### B. UI 端到端（真实浏览器 Playwright 驱动真 bundle，4 张截图）
`docs/onboard-ui/shots/`：`10-build-empty` / `11-build-type-selected` / `12-build-bots-assigned`（干活的=克劳德、把关的=蔻黛克斯、盯梢的=缇蕾，观察角色自动默认便宜 bot）/ `13-build-done`（✓ 已建出真群 tt_team_demo1，你已被拉进群）。

### C. 信任边界（前端侧）：浏览器供不了身份
Playwright 拦截「建这个真群」请求体 = `{"typeId":"tt_type_demo","selectedBotBySlot":{...}}`——**无 roleInstances、无 binding、无 botOpenId**。身份全交服务端。

### D. 信任边界 + 拉用户进群（后端，隔离 SESSION_DATA_DIR + 伪 bots-info.json，跑真 createTaskTeam）
镜像端点服务端组装逻辑 + 真 `createTaskTeam`：
- 坏选择（某 slot 选了无 openId 的 bot）→ 组装报 `bot_not_usable_or_no_openid`（即端点 409）。
- 好选择 → 实例落库（chatId=oc_test_real，status=running）；**`binding.botOpenId` 全部来自服务端 bots-info**（ou_*_real，非客户端供给）。
- `userOpenIds=['ou_operator_real']` **经 createTaskTeam 透传到 createGroup**（= 把当前用户拉进群的合同成立）。
- → `SEGMENT2_BACKEND_PASS`。

## 诚实边界：哪些这刀没真跑（按 CEO「部署体验时再统一处理」）
- **真建飞书群 + 真把人拉进群的线上 E2E** 需要活 daemon + 真实 bot + Lark，受"不部署/不重启"限制本刀未线上跑；待松松部署体验时补线上证据。
- 本刀验证覆盖到：服务端组装/信任边界/409/userOpenIds 透传/落实例（真 createTaskTeam）+ 前端只提交意图 + UI 渲染。HTTP 两跳（聚合层 proxy + daemon 端点）是薄转发，mirror 已上线的 `/api/groups/create` 范式。
- 克隆新分身：置灰、延后（ceo-spawn 需 chat session，dashboard 另设独立 clone API 后续做）。

## 边界自查
未 commit、未 push、未部署、未重启 botmux、未碰编译/构建配置。验证用隔离临时 SESSION_DATA_DIR，未触碰生产数据。第一刀 + 第二刀代码均停 working tree，等统一 commit/部署。

---

## 复审修订（寇黛克斯第二刀复审 2 P1 + 1 P2，已全改）

- **P1-1 bot 被飞书拒邀（invalidBotIds）仍落库成功**：已修。daemon wrapper 建群后检查 `invalidBotIds`：凡本次 role bot 被拒 → 在 `createGroup` 内抛 `role_bot_rejected`（赶在 `persistTeam` 之前），端点返 **409 role_bot_rejected**、不落实例。
- **P1-2 同一 bot 填多个角色绕过"角色到齐"**：已修。前端把已被别的角色选走的 bot 在其它下拉里禁用（选后 rerender 同步）；服务端兜底：`selectedBotBySlot` 有重复 appId → **409 duplicate_bot_assignment**。
- **P2 companyId 浏览器透传**：已改。dashboard 不再读/转发 `companyId`；daemon 端点固定用服务端默认 `tt_company_onboard`。

### 修订验证（隔离 SESSION_DATA_DIR + 真 createTaskTeam/store）
- P1-1：mock `createGroupWithBots` 把某 role bot 放进 `invalidBotIds` → `createTaskTeam` 抛 `role_bot_rejected:cli_a`、**store 无新实例**（总实例数 0）。
- P1-2：重复选择被 dedup 检出 = true、不同选择通过 = true。
- → `FIXES_PASS`。
- `pnpm build` 重新通过；第二段 UI 截图用修订后 bundle 重跑、流程无回归，前端提交体仍只有 `{typeId, selectedBotBySlot}`。

# v2 设计重写 · 私有研究笔记（待松松方向 + reviewer 复审后用，未对外报）

> 状态：松松在拍 root 群方案 i/ii；主 bot 令架构静默待命，方向到了才进实现。
> 本文件只是把已挖到的合同级事实存下来，方向一到可直接写 design v2。

## reviewer（寇黛克斯）打回点（全收，design.md 要逐条改）
docx: https://bytedance.larkoffice.com/docx/HM9vdQzFTopoXixmZlBc3bYNnrg

- **P1-①**：plan.steps 是静态规划标签（skeleton 恒 auto、invite/handoff 恒 manual、其余只跟 ready 走），**不含运行态**。不能当向导单一状态源。
  → `GET /api/task-team/onboarding/state` 必须额外返回可恢复运行态：inviteDismissed / skeletonReady / rootChatId / companyId / runTeamId / runStatus / lastError / currentStep，或说明如何从 company + taskteams + onboarding job 推导。
- **P1-②**：skeleton root 群合同没闭。CompanyConfig 需要 id/name/rootChatId/ceoBotRef（可选 ceoLarkAppId/ceoOpenId）；upsertCompany 不设 mainTopicChatId。
  → 要写死：companyId 生成、ceoBotRef 来源、是否把用户拉进群(userOpenIds)+notify+bindWorkingDir+是否 setMainTopicChatId、半成功幂等重试。否则 B/G「去管理办公室」承诺不成立。
- **P1-③（最关键）**：bot-onboarding 只注册新 app（cliId=claude-code/workingDir=~/allowedUsers），**不是克隆**（不继承 home/model/身份、无 displayName/botName、不进群）。新 app 无 botName/openId → isUsableOnboardingBot 滤掉 → 进度永不递减。
  → D 步必须接真正 clone/ceo-spawn（见下合同），或老实改文案为"新增 bot 不继承模型"。kickoff 明确要"克隆+用自己的模型+批量+Observer便宜模型"，所以走真 clone。
- **P1-④**：runOnboarding 只建组（建群+落库+apply team-started）。submit→reviewing→done 要真实 bot 发言+observer 抓+judge 归因+engine 出命令+dispatcher 投递。reviewState 无 reviewing/done 字段（状态在 TaskTeamInstance.status；reviewState 只有 round/reworkCount/pendingInstanceId/votes）。默认 seed 示例小组是**4 席**（开发者/架构师/审查员/盯梢，两层 review），不是 3。
  → F 步拆两段验收：「建组成功(created/teamId/chatId)」+「真实引擎跑通(轮询 team.status/progress/pendingInstanceId + dispatcher/observer 已运行 + 角色消息/投递 message_id + status running→reviewing→done 真实记录)」。席位卡按 plan.seats 动态渲染、不硬编码个数。v1 若只要求 reviewing，把 done 标可选后续。
- **P2**：firstRun=没 company 且没 taskteam 会污染：runOnboarding 默认 companyId 固定 tt_company_onboard（重走可能重复建）；有任意历史 taskteam → firstRun 永不出现。
  → state 返回 onboarding-specific marker：companyId/rootChatId/sampleTeamId/completedAt/dismissedAt；首次邀请别只看全局 taskteams 空否。

## clone / ceo-spawn 合同级事实（dashboard D 步要接的）

### cloneBot —— src/services/bot-clone.ts:377 `cloneBot(input: CloneBotInput, deps?): Promise<CloneBotResult>`
- 入参：sourceBot/configDir/botsJsonPath/sourceClaudeHome?/sourceDisplayName?/sourceDescription?/cloneName?/botNamesByAppId?
- 仅 claude-code 支持隔离 home（adapter 声明 cloneHome；codex/coco 未实现 → unsupported_engine）。
- 复制 persona：cliId/backendType/lang/defaultWorkingDir/workingDirs；**不复制** larkAppId/Secret（新）、allowedUsers（=扫码人）、chat 绑定。
- 隔离 home：~/.botmux/clones/<appId>/.claude/（shared 软链 persona/credentials、copy mutable、independent session/state/memory、memorySeed 快照）。
- 写 bots.json：claudeConfigDir（克隆标记）/displayName(『本体名(N号机)』或 custom)/clonedFromName/description。
- 返回 CloneBotResult: {ok,appId,slug,claudeConfigDir,botIndex} | {ok:false,error,message}。
- **克隆后未启动、无 botOpenId**。

### ceo-spawn —— src/services/ceo-spawn-service.ts:106 `ceoSpawn(req: CeoSpawnReq): Promise<EnsureSpawnOutcome>`；daemon 路由 POST /api/bot-ceo-spawn
- CeoSpawnReq: {sessionId, goal, seats?, activationApprovedAppId?, cloneScopeProfile?('core'|'full'), sourceDescription?}
- seats 语法：auto:main / auto:collab / auto:observer / <appId|name>:role / auto@claude:main / 自定义名 auto:main[初号机]
- 状态机（每次 POST 推进一步、幂等 requestKey=chatId-rootMsgId-slug(goal)-djb2(goal)）：
  建子群 → pending→cloned→[awaiting_activation 等松松批]→activated(起 PM2)→registered(热注册 daemon runtime)→[awaiting_openid 轮询]→in_chat(拉进群)→joined。
- EnsureSpawnOutcome 状态：spawned / awaiting_activation(传 --activation-approved <appId> 续) / awaiting_openid(轮询) / awaiting_clone_join(可重试) / refused(非 owner/解析失败) / error。
- ⚠️**强依赖 sessionId**（getSession→chatId/rootMessageId/ownerOpenId）。**dashboard 无聊天 session** → 待确认：需改造 daemon 路由接受显式 chatId/rootMessageId/ownerOpenId，或另设鉴权路由。这是 D 步能否在 dashboard 跑的核心未决点。

### 热注册 + botOpenId
- 激活：activateBot src/services/bot-activate.ts:115（pm2 start --only，**不重启现有 daemon**）。
- 热注册：hotRegisterClone（ceo-spawn-wiring.ts ~320，loadBotConfigs+registerBot 加内存 map，此时还没 openId）。
- botOpenId：克隆进程启动后收到第一条 Lark 消息时 probeBotOpenId 调 /bot/v3/info 拉取 → 写 ~/.botmux/data/bots-info.json。getBotOpenId/resolveReady(ceo-spawn-wiring.ts:162) 读它（要求 bots-info 有 openId + bots.json 有 + pm2 在线）。
- ⚠️ 有 I/O+网络延迟，**进度无法瞬时递减** → dashboard 轮询 1-2s + 超时 5-10min。

### 拉进群
- src/services/groups-store.ts ~80 `addBotToChat(proxyLarkAppId, chatId, targetLarkAppIds[])` → POST /im/v1/chatMembers/create，member_id_type=app_id。先 isInChat 幂等检查。createGroupWithBots 也可建群时一次带 larkAppIds。

### 批量
- 无原生批量；ceo-spawn pendingClones 多席位但**状态机一次推进一个**（串行）。多 bot=多 QR（device-flow 一码一人，不能多人扫同一码）。dashboard 批量=排队逐个扫。

### QR device-flow 复用
- 底层 tryRegisterApp src/setup/register-app.ts:93（飞书 OAuth device flow RFC8628，begin→show→poll，~10min 过期）。
- BotOnboardingManager(dashboard/bot-onboarding.ts:83) 的 start→轮询:id→completed 轮询机制可复用；改造点：底层从 registerApp 换成 cloneBot/cloneInChat，并支持 appPreset。可新建 BotCloneManager 复用同套轮询。

## v2 设计要点（方向一到照此写）
1. state API = plan(定义/缺口) + 可恢复运行态(派生自 company/taskteams/onboarding marker)。明确每字段来源。
2. skeleton 合同写死（依松松 i/ii）：建/认领 root 群 + upsertCompany(完整字段) + 是否 setMainTopicChatId + 拉用户进群 + 幂等。
3. D 步 = 真 clone：走 ceo-spawn 状态机（需先解决 dashboard 无 session 的路由改造——这点要么设计里提改造方案，要么上报为依赖）。文案诚实：克隆继承模型/Observer 便宜引擎/批量串行排队/QR 一个个扫/激活需松松批/进度轮询非实时。允许"加现成 bot"作为旁路（available-bots 勾选，无需扫码）。
4. F 步两段验收 + 席位动态渲染 + 看 team.status 不只 reviewState + done 可选。
5. firstRun 用 onboarding marker，不只看全局 taskteams。
6. 全程不重写后端逻辑，只加薄接线 + 必要的 ceo-spawn dashboard 入口改造（如需，明确边界）。

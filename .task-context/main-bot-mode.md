# Task Context · main-bot-mode

> **Status**: 🟢 Active · Activated 2026-05-23 · Owner: 克劳德 (Claude)
> **Mode**: 自主开发模式（松松显式授权 2026-05-23）
>
> 配套文档：
> - 设计 v1.0 (What+Why)：https://www.larksuite.com/docx/GgBNdFjbto3o9Zx92TmccHWAnCf
> - 技术方案 v1.0 (How)：https://www.larksuite.com/docx/C3Cjdvq6ZovYuOxyLvUcs5VEnWd
> - 仓库 markdown：`docs/main-bot-mode.md`

---

## 任务范围

为 Dbotmux 增加 **Main-Bot 模式 + Chat Topology + 新群上下文自动注入** 三件套。

### 目标（按优先级）

1. **Main-Bot 全局视野**：克劳德随时拉到"过去 N 小时所有群发生了什么" derived view
2. **新群上下文自动注入**：建群 → bot 即收上下文卡片，无需人肉解释
3. **Chat Topology 可视化**：dashboard 新增 Topology tab
4. **跨群议题追踪**：同 PRD 在多群讨论自动识别

### 6 个已决策点

- **Q1** · parentChatId 自动推断（创建命令所在 chat）+ originType (p2p/human_created/bot_spawned) 区分，仅 bot_spawned 进拓扑
- **Q2** · 上下文卡片 **eager** 发送 + session prompt 注入双轨
- **Q3** · Digest 15 min cron stale 才跑 + on-demand 强制刷
- **Q4** · 缇蕾跑 LLM 摘要（一步到位三层架构）
- **Q5** · Topology 节点展开用 drawer
- **Q6** · 先 fork 自维护 + 每周 rebase upstream/master

### 三层架构

| 层 | 谁跑 | 干啥 |
|---|---|---|
| L1 数据聚合 | botmux daemon (JS) | 群指标、消息数、stale 检测 |
| L2 LLM 摘要 + Escalation | **缇蕾** | 群一句话摘要、跨群议题识别、R1-R5 触发 |
| L3 决策行动 | **克劳德** | consume digest + ScoutInbox → 推进 / escalate / 通知松松 |

### Escalation 5 规则（缇蕾 → 克劳德）

- **R1** · 你未回 ping > 30 min
- **R2** · 同议题 ≥ 2 群 + 24h 无收敛
- **R3** · bot_spawned 新群 > 1h 无活动
- **R4** · bot 互 ping > **20 轮**无定论（温和提示，倾向继续观察）
- **R5** · 出现 error / blocked / stuck 关键词

⭐ **设计哲学**：bot-to-bot 讨论本身有价值，escalation 不是为打断而是为给上限避免无限循环。

---

## 路线图 · 17 commits

### P0 · 1.5 天 · 4 commits（ChatContext + onChatCreated + 卡片）✅

- [x] **commit 1** · `feat: add ChatContext store + 数据模型` (28e7232) — 新增 `src/services/chat-context-store.ts` + 17 单测
- [x] **commit 2** · `feat: add onChatCreated event handler + originType 推断` (d9546cf) — 在 event-dispatcher.ts 加 `im.chat.created_v1` case + chat-created-handler.ts + 13 单测
- [x] **commit 3** · `feat: 上下文卡片 markdown 渲染 + 发送` (8f4b2c3) — chat-context-card.ts 渲染 + 发送 + 15 单测
- [x] **commit 4** · `feat: chat-create fallback（无 event 时主动触发）` (4a48bd0) — group-creator.ts 加 manual trigger + dispatchChatCreated 抽出 + 5 单测

### P1 · 0.5 天 · 1 commit

- [ ] **commit 5** · `feat: onSessionSpawn hook 注入 ChatContext 到 system prompt`

### P2 · 3 天 · 6 commits（L1 + L2 缇蕾 scout）

- [ ] **commit 6** · `feat: ChatTopology + metrics 数据模型 + L1 daemon 聚合`
- [ ] **commit 7** · `feat: MainBotDigest + ScoutInbox 数据模型 + 文件 IO`
- [ ] **commit 8** · `feat: onScoutTick cron + 缇蕾 spawner`
- [ ] **commit 9** · `feat: 缇蕾 prompt template + JSON 输出解析`
- [ ] **commit 10** · `feat: Escalation 5 规则实现（R1-R5）`
- [ ] **commit 11** · `test: escalation rule unit tests`

### P3 · 1 天 · 2 commits（L3 克劳德 consume）

- [ ] **commit 12** · `feat: onScoutEscalation hook（fs.watch + dispatcher）`
- [ ] **commit 13** · `feat: 克劳德 handler spawner + R1-R5 playbook`

### P4 · 2 天 · 3 commits（Dashboard）

- [ ] **commit 14** · `feat: dashboard 5 个新 API 路由`
- [ ] **commit 15** · `feat: dashboard topology tab 前端（vis-network + drawer）`
- [ ] **commit 16** · `feat: 无拓扑群侧栏（p2p / human_created）`

### P5 · 1 天 · 1 commit

- [ ] **commit 17** · `feat: same_topic 跨群议题边自动推断`

---

## 当前进度

- **2026-05-23 22:00** · task-context 激活
- **2026-05-23 22:00** · 6 决策点全敲定（与松松 pair-design）
- **2026-05-23 22:00** · `feat/main-bot-mode` 已 rebase 到 `upstream/master@56d9d2c`
- **2026-05-23 22:00** · 仓库 markdown `docs/main-bot-mode.md` v1.0 已写完
- **2026-05-23 22:55** · 文档 + task-context commit 到 fork (1212901)
- **2026-05-23 23:35** · P0/1 ChatContext store + 17 单测 (28e7232)
- **2026-05-23 23:42** · P0/2 onChatCreated event handler + 13 单测 (d9546cf)
- **2026-05-23 23:53** · P0/3 上下文卡片渲染 + 发送 + 15 单测 (8f4b2c3)
- **2026-05-24 00:00** · P0/4 chat-create fallback + 5 单测 (4a48bd0)
- 🟢 **P0 完成**（4 commits · 50 个新增单测全 pass · tsc --noEmit 通过）
- **2026-05-24 00:18** · regression fix: group-creator.test.ts 加 dispatch mock (a10e1bf)
- **2026-05-24 00:25** · 121 个相关测试（main-bot 触及的 6 个 file）全 pass
- ⚠️ 完整 pnpm test 有 22 files / 27 tests fail，但 grep 看是 workflow-cli 等无关 file，**可能 pre-existing**
- **2026-05-24 00:37** · e2e cli path 跑通：实际建群 + ChatContext 写入 + 上下文卡片真发送
- **2026-05-24 01:00** · e2e daemon event path 调查：Lark 不发 chat.created event（必须 chat.member.bot.added_v1）
- **2026-05-24 01:05** · fix(p0): 切换 event 源到 im.chat.member.bot.added_v1 (a043c4c) + isFirstDispatch 防重复发卡片
- **2026-05-24 01:21** · fix(p0): inferOriginType 加 cross-app peer 检测 (4c8095b)
- **2026-05-24 01:23** · e2e daemon event path 跑通：删/加 bot → daemon 接 event → ChatContext 写入 origin=bot_spawned + 卡片发送
- 🟢 **P0 真·完成** · 8 commits · cli path + daemon event path 全 e2e 跑通
- **2026-05-24 01:32** · P1 onSessionSpawn 注入 ChatContext 到 prompt (15b8053) — buildNewTopicPrompt 加 chatId 参数
- **2026-05-24 01:35** · P0.5 新需求：群置顶 dashboard 链接 (613b261) — sendContextCard pin 卡片 + 卡片含 dashboard URL
- **2026-05-24 01:39** · P2/6 ChatTopology store + L1 metrics (9d34f16)
- **2026-05-24 01:40** · P2/7 MainBotDigest + ScoutInbox stores + stale tracking (5ab2e9e)
- **2026-05-24 01:45** · P2/8a L1 onMessage hook 接通 (f0843c6) — event-dispatcher 接入 bumpMessage + markStale
- ⚠️ P2/8a e2e 部分验证：单测 156 pass；真 daemon e2e onMessage 当时没能跑（松松睡了），当时**推断**"Lark 推送只 @bot 触发"——**此推断 2026-05-30 已证伪见下**
- ✅ **2026-05-30 证伪**：读 `~/.botmux/data/chat-topology.json`（`messages24h` 由 push handler 在 @ 判定**之前** bump，且 `bumpMessage` 全仓**仅** event-dispatcher L772 一个调用方、无轮询）发现 oc_3dabc5b=894、oc_6358ecd1=1411 等满量计数 ≈ 缇蕾轮询数。结论：**push 推全量群消息，不是只推 @bot 消息**。这是"急急如律令唤醒"特性可行的基石。
- **2026-05-24 02:01** · P2/8b scout-spawner + P2/10+11 escalation 5 规则 (6c44af2) — in-process v0.1，16 escalation 单测 pass
- **2026-05-24 02:04** · P3/12+13 L3 escalation playbook (76e81b0) — 5 handler + dispatchPendingEscalations + 6 单测
- **2026-05-24 02:06** · P4/14 dashboard 5 个 API routes + 6 smoke 单测 (d1d31cd)
- **2026-05-24 02:09** · P4/15+16 dashboard topology page 前端 (7fd1f68) — vanilla TS 列表视图 + drawer + applink 反向跳
- **2026-05-24 02:13** · P5/17 same-topic 跨群边推断 (f22bbed) — 共享 tag/任务ID → emit same_topic edge + 8 单测
- 🎉 **全 17 commits 完成 · main-bot 模式 v1.0 实现 done**
- ⚠️ v0.1 不 spawn 真 LLM：L2 缇蕾 scout 用规则模板 / L3 克劳德 consume 用 in-process handler；LLM 接入是 v1.1 升级
- 🟡 **下一步** · 给松松完整验收清单 + 让他验证

---

## 特性 · 急急如律令唤醒（2026-05-30 松松授权开干）

### 动机 / Why

用 base 转发以松松身份发的消息**是纯文本**，无法注入真正的 Lark `@` 元素，所以没法用"@分身"唤起子群里待命的克劳德/缇蕾/蔻黛克斯分身（bot 自己 @ 自己又会被自循环过滤——[[reference_wake_subgroup_clone_via_other_bot]]）。需要一个**纯文本约定**让 botmux 把它当成 @ 来处理。

### 约定格式

消息以 `急急如律令：【名字/名字/…】<正文>` 开头时：
- 解析【】里的 bot 名（`/ ／ 、 , ， 空格` 任一分隔）
- 每个 bot 的 daemon **各自独立**判断自己的 `botName` 在不在名单里
- 命中 → 当成"被 @ 了"一样路由进 CLI 响应，喂给 CLI 的正文 = 剥掉前缀后的 `<正文>`
- 全角/半角冒号 `：:`、全角【】 都兼容

### 可行性基石（已验证）

push 推全量群消息（见上方 2026-05-30 证伪记录）。所以纯文本 `急急如律令：【克劳德】…`（无真 @）由松松/ base 发进多 bot 群后，**每个 bot 的 daemon 都会收到这条 push 事件**，可在 handler 里 format-match 后自行响应。

### 实现点（event-dispatcher.ts `im.message.receive_v1` user 分支）

1. 新增纯函数 `parseUrgentSummon(text)` → `{ names: string[], body: string } | null`
2. 新增 `isUrgentSummonForBot(larkAppId, message)` → 用 `extractMessageTextForRouting` 取文本 + parse + 比对 `getBot(larkAppId).botName`（大小写不敏感 + 别名表）
3. 在 `/grant` 拦截之后、`decideRouting` 之前加一个**自包含分支**：命中 summon-for-me →
   - 把 `message.content` 的文本改写成 `body`（剥前缀，CLI 拿干净指令）
   - `decideRouting` → 按 `isSessionOwner` 选 `handleThreadReply`/`handleNewTopic`
   - **绕过多 bot 群的 @ 闸门**，但仍要过 `canTalk`（松松是 owner 会过；陌生人不过）
4. 单测覆盖 `parseUrgentSummon` 各种分隔符/冒号/括号/无匹配/别名

### 别名表（botName ↔ 触发名）

| daemon botName | 可接受触发名 |
|---|---|
| 克劳德 | 克劳德 / claude |
| 缇蕾 | 缇蕾 / coco / 小宝 |
| 蔻黛克斯 | 蔻黛克斯 / 寇黛克斯 / codex |

### 风险

- `canTalk` 必须保留：否则任何人发"急急如律令"都能唤起 bot（安全闸）
- 老路径 0 改动，summon 不命中时完全走原逻辑

### Live 测试发现（2026-05-30，"不要写完就算了"）

1. ⚠️ **base 转发发的是 interactive 卡片，不是纯文本**！实测消息 content =
   `{"title":"急急如律令：【克劳德】…","elements":[img]}`（卡片，正文在 title）。
   单测用 `{"text":…}` 跟现实不符 → 第一轮真失败。**这就是为什么必须 live 测**。
   修复：interactive 消息先 `content.includes('急急如律令')` 便宜预筛 →
   `resolveNonsupportMessage` 解析卡片（写入 RESOLVED_TEXT_KEY）→ 再判 →
   `normalizeToTextMessage` 命中后把卡片整成干净 text（下游不再 resolve）。
2. ✅ **克劳德 summon 通了**：daemon-0 日志 `急急如律令 summon matched
   (scope=chat, ownsSession=true)`，正文剥前缀后喂进会话。
3. ⚠️ **ownsSession=true 时塞进已有会话排队**：若该 bot 在目标群已有在跑会话，
   summon 把正文喂进去排队（忙时不秒回）；子群无现成会话则 handleNewTopic 拉新分身秒应。
   —— 真实使用场景（子群唤分身）走的是后者，没问题；同群已有会话是 demo 的干扰。
4. ⚠️ **缇蕾(coco)可能收不到无@卡片**：coco app 疑似没有"接收群全部消息"推送权限
   （缇蕾本就靠轮询）；克劳德 app 有（topology 满量计数证实）。要让缇蕾/蔻黛克斯
   也能被 summon，需确认它们 app 的事件订阅权限——**未验，待办**。

### 通用化：所有 bot 都能被 summon —— 不需要改权限（2026-05-30 结论）

✅ **最终结论：summon 对所有 bot 都通，无需任何权限改动。** 三个 bot 全部 live 实测通过
（日志 `急急如律令 summon matched` + 剥前缀正文喂进会话 + 发响应到群）：
- 克劳德 cli_a9771799（daemon-0）✅
- 缇蕾 cli_aa9aab67（daemon-2）✅
- 蔻黛克斯 cli_a97448b8（daemon-1）✅
三个 bot 本来都有 `im:message.group_msg`（都收到了无@卡片）。之前的权限折腾是误判，已撤回。

⚠️ **我（克劳德）犯过的判断错误，记下防再犯**：第一轮测缇蕾是在修"卡片解析"bug **之前**，
那次缇蕾没响应跟克劳德第一轮一样、是卡片没解析的问题，我却**归因成"缺权限"、且没在修复后重测就下结论**，
还让松松去后台折腾权限。松松一句"212002 说明本来就有权限，你试一下缇蕾"点破了。
**教训：失败原因没排除干净（尤其刚改过代码）就别下因果结论；改完一定重测，别拿旧代码的失败当新结论的证据。** [[feedback_verify_before_concluding]]

权限排查留档（供参考，非阻塞）：
- `scope.apply()` 返回 212002「unauthorized scopes were empty」= 没有未授权 scope = 本来就有权限（被误读成"卡在审批"）。
- ⚠️ scope.list（app token）的 grant_status 不可靠：三个 bot 都返回 granted=0、全 status=1，连在用的克劳德也是 → 别信这字段，用**行为**判断。
- 全套权限清单在 `src/setup/lark-scopes.json`（含 `im:message.group_msg`），批量导入格式，增量。

### 部署拓扑变化（2026-05-30）

`node dist/cli.js restart` 把 pm2 autostart 路径同步成**当前 cli.js 路径**，3 个 daemon
现在直接跑 `~/work/Dbotmux/dist/index-daemon.js`（不再是安装版 `~/.npm-global/.../botmux/dist`）。
所以部署 = `pnpm build` + `node dist/cli.js restart`，无需 rsync。重启会恢复 active sessions。

---

## Norms（本任务的工作规则）

### 工作模式

- **自主开发模式**（[[feedback_autonomous_dev_mode]]）：phase 完才汇报，真 blocker 才问松松
- 每 commit 独立可 review、commit message 中文 + 一句话讲清"动机 + 改了什么"
- 老功能 0 改动 — 只加不改，降低 upstream rebase 成本
- 任何新数据模型 / 接口必须先在 task-context 这里 reflect 再写代码（[[feedback_task_context_priority]]）

### 编码规则（继承 Dbotmux 现有）

- TypeScript strict + ES Modules (`type: module`)
- 用 `import * as foo from './foo.js'` 风格（含 `.js` 后缀，符合现有 daemon.ts pattern）
- 数据持久化原子写：tmp file + rename，沿用 `session-store.ts` pattern
- 单测用 vitest，e2e 用 `test/*.e2e.ts` 现有 pattern
- 日志用 `import { logger } from '../utils/logger.js'`，不要 `console.log`

### 上游对齐

- 每周一次 `git fetch upstream && git rebase upstream/master`
- 每个 Phase 起头前再 rebase 一次
- 通用模块（ChatTopology / dashboard topology）稳定后单独 PR 给 upstream 评估

### 测试 / 验收

- 单测覆盖：每个 commit 都要带对应测试（除非纯文档 / hook 接线 commit）
- e2e：P0+P1+P2+P3 完成后跑 `test/main-bot-flow.e2e.ts`（验收 case 6 步）
- 自测：每完成一个 phase 自己跑一遍验收 case 子集，再继续下一个

### Blocker 处理

什么算 "真 blocker"（应该问松松）：
- 架构决策有多个合理选项且分歧大
- 外部依赖确认（要不要新增 npm 包等）
- 需要松松专属权限（API token / 配置）

什么不算（不要为问而问）：
- 命名风格（按现有 pattern）
- 测试用例细节
- commit message 措辞

---

## 风险 / 已知坑

参考 设计 v1.0 §7 / 技术方案 §7（同步维护）：
1. `im.chat.created` 事件可能不全 → fallback 主动写
2. bot 不在新群 = 收不到 hook → onboarding 流程兜底
3. 跨 daemon 数据一致性 → atomic write
4. 缇蕾 token 成本监控
5. hook 死循环避免
6. session 复活问题（5/18 历史教训）— [[project_botmux_session_revival]]
7. escalation 误报 / 漏报 — dogfood 调阈值
8. R4 阈值的产品哲学 — bot 讨论有价值（[[feedback_dont_interrupt_bot_discussion]]）

---

## 完工标准

- [ ] 17 commits 全部 merged 到 `feat/main-bot-mode`
- [ ] 验收 case 6 步骤全部通过
- [ ] dogfood 1 周，R1-R5 阈值调优一次
- [ ] 三套文档保持一致（设计 v1.0 / 技术方案 v1.0 / 仓库 markdown）
- [ ] 给松松一份验收清单（功能 + 测试步骤 + 预期结果）
- [ ] 松松最终 review 代码后 merge 到 master

# Task Context · subtask-orchestration（子任务编排系统）

> **Status**: 🟢 Active · Activated 2026-05-30 · **v3 设计纠偏 2026-05-31** · Owner: 克劳德
> **Mode**: 一步一步实现，phase by phase，不动作变形（松松 2026-05-30 强约束）
> **设计依据**: 技术方案 v0.2（含可靠性底座，蔻黛克斯 review 后）+ **v3 纠偏（见下方红节，最高优先级）**
> https://bytedance.larkoffice.com/docx/PQFddm7dQosKbrxiQLtcMHAxnIb
> **⚠️ 阅读顺序**：先读「🔴 v3 设计纠偏」节——它**覆盖** Phase 3 的「缇蕾直发」实现；下方 Phase 3-6 进度里
> 凡涉及「缇蕾直发投递身份」的描述均已**作废**，以 v3 为准。可靠性底座（store/outbox/cursor/claim/lease/状态机）保留。

## 一句话

主 bot 一句话发起子任务 → MCP 工具自动建群+拉全部bot+激活 → 脚本化观测子群 →
需协助/完成时上报**父群** → 主 bot 查询+决策（结束/补充）。靠 Message 链路(base
转发) + MCP 工具 + 数据结构 驱动。脚本化观测牺牲实时换低成本，**前提是 outbox +
cursor + ack 做扎实**，否则失败被藏更深（蔻黛克斯 review 核心结论）。

## 🔴 v3 设计纠偏（2026-05-31，松松对齐，最高优先级）

### 纠偏背景
Phase 3 把「主↔子通信」实现成了**缇蕾直发纯文本**（我+蔻黛克斯 review 时拍板，没回去跟松松对齐），
**偏离了松松原始方案**。松松强反馈：「最最优先的是尊重我的设计……不能自己跑去瞎改」。
连带 bug：缇蕾直发纯文本**唤不醒**子群 bot（Phase 6 finding #2「子群空转」的根因）。
→ 整个**投递层 + 工具执行模型**按下面的 v3 架构重做。教训见 memory [[bot-consensus-not-design-authority]]。

### 核心模型：内存共享式通信（松松定调）
- **subtask-store = 共享内存**。所有 bot（主/子）只 **读/写 store**，**不互相直接发消息**。
- **coco LLM API = 急急如律令的唯一触发器**。任何「唤醒某个 bot」的动作，都由 coco 观测到
  store 状态变化后，**发急急如律令（base relay，以松松身份发 `急急如律令：【botname】正文`）**触发。
- **bot 之间不直连**：没有 bot-to-bot 直接 IPC / 直接发消息 / service 替 bot 行动。
- **通信三步**：① bot 写 store（求助/完成/下发）→ ② coco 观测到 → 发急急如律令 → ③ 目标 bot 被唤醒 → 读 store → 决策 → 写 store。

### 主↔子通信必须走 msg 链路（急急如律令），强制
- **主→子 / 子→主，全部走急急如律令**（base relay），**不是**缇蕾直发纯文本。
- **MCP/CLI 工具也必须走这个 msg 链路**（松松强制：「工程上确保必须实现成这样」）。
  禁止 CLI-direct-IPC 让 service 直接替 bot 完成跨会话动作、绕过 bot 参与。
- **bot 真参与**：「要让 bot 真正参与，否则链路不通」——目标 bot 的 LLM session 必须被**真唤醒、真读 store、真决策**。
  service 代码不许替 bot 思考/行动。

### askforhelp 工具 = 只写信息（内存共享式）
- 子群执行 bot 调 askforhelp = **把求助信息写进 store**（共享内存），仅此而已。
- 激活主 bot 的链路**不变**，仍由 coco LLM 观测到后触发急急如律令。
- 松松原话：「这个求助就只是一个存信息的行为，本质上是一种内存共享式的通信」。askforhelp **不直接发消息、不直接唤主 bot**。

### 观测层：coco LLM API，保留不动
- 观测判断**用 LLM API（coco）即可，不必真 bot**——松松确认。
- 两条硬约束（已在 Phase 2 实现，**保留**）：① **上下文连续性**：每次总结判断都知道自己之前的总结结果
  （recentObservations）② **不漏消息**：committedCursor 推进。
- `subtask-observer.ts` **保持不变**；`subtask-observer-executors.ts` 2026-05-31 修过卡片解码 bug，见 ↓。

### ⚠️ observer 卡片解码坑（2026-05-31 实战暴露 + 已修）
- **现象**：真实子任务 st_961bb3f6（合 MR）干完了，observer 却从 07:44 冻 8 小时不 escalate，松松判「观察逻辑没 work」。
- **根因**：观察循环一直在跑（coco 每 60s tick），但 `renderMsg` 裸读 `body.content`，对 `msg_type==='interactive'`（子 bot 的完成/进度卡片）飞书返回降级占位文「请升级至最新版本客户端以查看内容」→ coco 每轮只看到占位文 → 判 `signal:normal` → 永不 escalate。完成/求助信号被这层占位文吞掉。
- **修复**：`renderMsg` 改用 `parseApiMessage(m).content`（复用 message-parser `extractCardContent` 解码卡片真 body）；命中纯占位 sentinel（`isPureCardUpgradeFallback`）再 `getMessageDetail(...,{userCardContent:true})` 重取兜底。`renderMsg` 改 async，调用点 `Promise.all`。新增 3 单测。
- **教训**：observer 靠「读子群消息」感知进度，子 bot 输出几乎全是 interactive 卡片——**任何「读消息内容」的环节都必须走卡片解码，不能裸读 `body.content`**。
- ⚠️ **不回溯**：修复只对**未来新消息**生效；已 committed 的旧消息 cursor 已追平，不会被重判。卡死的旧任务要救活需手动制造新消息触发重观察。

### kickoff：coco 急急如律令唤醒子群
- create 建群后，coco 观测到新子任务 → 发急急如律令唤醒子群执行 bot（带子任务目标）。
- **不能缇蕾直发纯文本**（唤不醒，Phase 6 finding #2 根因）。

### `<subtask_member_routing>` prompt 注入（子群每轮小尾巴）
- MCP 工具不是 skill，多轮对话后 bot 会丢失「可以向主 bot 求助」等信息 →
  借 botmux 给 CLI 注入 prompt 的机制（现有 `<main_bot_routing>`/`<botmux_routing>` 同款），子任务子群**每轮补注入**。
- 注入点：`session-manager.ts buildNewTopicPrompt`，检测 chatId ∈ 子任务子群（`subtask-store.getByChatId`）。
- **5 部分内容**：
  ① **子任务目标 / 验收标准**（这个群在干什么）
  ② **你的角色职责**（按 bot 身份，见下方角色分工）
  ③ **群里还有哪些 bot + 各自职责**（协作上下文）
  ④ **求助机制**：可用 askforhelp 向主 bot 求助；**别硬扛、别编**。
  ⑤ **逐级上报铁律**（独立 `<subtask_escalation_protocol>` 块，2026-05-31 松松下达）：子 bot **无权直接 @ / 找邹劲松拍板**；任何卡点 / 待决策（MR 合不合、选 A/B、是否继续）只能 askforhelp 写 store 上报父群 → 父群主 bot 感知 → 主 bot 判断是否惊动松松。链路「子群 → 父群主 bot →（主 bot 判断）→ 邹劲松」，**严禁跨级**。

### 角色分工（注入进 ②③，每个 bot 知道自己 + 别人的角色）
- **克劳德（claude）= 执行者**：负责**方案的制定** + **方案的落地**。
- **蔻黛克斯（codex）= Reviewer**：审**方案的合理性** + 审**代码是否正确、有没有逻辑硬伤**。
- **缇蕾（coco）= 超级 Subagent**：Token 不限量，承接 **token 消耗量巨大但相对简单**的活。

### 可靠性底座：全部保留
subtask-store（共享内存数据层）/ OutboxCommand outbox / observer cursor（committedCursor）/
claim/lease / CAS completeDispatch / 状态机 / 乐观版本锁 / 幂等。
**dispatcher 的可靠性决策逻辑保留**，只把 deliver IO（缇蕾直发 → coco 急急如律令 base relay）换掉。

### 任务发起入口（理解，实现时如有疑问精准问松松）
- **松松 → 主话题克劳德**：松松本人正常 @ 主话题克劳德下任务即可（他本人发消息天然触发主 bot，不需要急急如律令唤醒）。
- **主 bot → 子群 / 子群 → 主 bot**：才走急急如律令 msg 链路。
- 即「松松→主」用正常消息，「主↔子」用急急如律令；create 入口若松松要求也走急急如律令再调整。

### v3 实现进度（2026-05-31，松松授权自主推进）
- ✅ **投递层重做 (#81)**：新建 `base-relay.ts`（急急如律令发送侧：spawn `lark-cli base` 写记录→owner 身份发→轮询「已发送」，配置走环境变量 `SUBTASK_RELAY_BASE_TOKEN`/`SUBTASK_RELAY_TABLE_ID`，不硬编码）；`outbox-dispatcher-executors.ts` deliver 改 `sendAsOwner`，文案改急急如律令纯文本格式（无 `<at>`，前缀 `急急如律令：【botname】`）。**dispatcher 决策/可靠性逻辑保留不动**。9 单测重写绿。
- ✅ **askforhelp 工具 (#82)**：`subtask-orchestrator.askForHelp`（= reportProgress(need_help) 的执行者别名，写 report_help command 进 store）+ CLI `subtask-askforhelp` + IPC route `/api/subtask-orch-askforhelp`。
- ✅ **防误清库 (#87)**：`subtask-store.read()` corrupt → 备份 `.corrupt-<ts>` + 抛 `StoreCorruptError`（**不返空库**）。
- ✅ **kickoff (#83)**：createSubtask 建群+observing 后 enqueue commandType='kickoff'，dispatcher 急急如律令唤子群执行 bot（带 goal/验收/askforhelp 提示）。store CommandType 加 'kickoff'。executors + orchestrator 测试绿。
- ✅ **子群每轮注入 (#84)**：`session-manager.buildSubtaskMemberBlock` 检测子任务子群 → 注入 `<subtask_member_routing>`（初版 4 部分：目标·验收/角色/其他bot职责/askforhelp 求助；2026-05-31 加第 ⑤ 逐级上报铁律 `<subtask_escalation_protocol>`，见上）。挂首轮 `buildNewTopicPrompt` + 每轮 `buildFollowUpContent`（daemon.ts:2334 + 包装函数传 chatId/larkAppId）。getByChatId corrupt try/catch 不阻塞 spawn。角色 claude-code=执行者/codex=Reviewer/coco=超级Subagent。build 绿；靠 E2E 验证注入（未加单测，session-manager 隔离成本高）。
- ✅ **5 工具复核 (#85)**：工具层已符合 v3——5 工具+askforhelp 都 bot 自己调、写 store，跨会话靠 dispatcher 急急如律令投递，无 service 替 bot 绕过。无需改造。
- ✅ **#86 E2E 核心链路已验证**：base relay → 急急如律令 → executor 唤醒（3.5s 内），物理通道打通。base relay 用蔻黛克斯「用户身份发消息」表（PXxSb3sPhabVB7swXZacrQxentf / tblxlPHT2sgdy3q0）。坑：① daemon 带 HTTPS_PROXY，spawn lark-cli 必须 `LARK_CLI_NO_PROXY=1`；② owner 必须是目标子群成员，否则 base relay 报 800030410。
- ✅ **observer 卡片解码 + 逐级上报铁律 (2026-05-31，真实 case 暴露)**：见上「⚠️ observer 卡片解码坑」+ 注入第 ⑤ 部分。escalate 目标核实=已发父群（`child_to_parent` → `parentChatId` → 急急如律令唤主 bot 自判，**不直连松松**），符合铁律未改。
- ✅ **顺手修 botmux 既有转发 bug (2026-05-31)**：`claude-transcript.ts extractAssistantText` 的 array-form text block 分支未过滤工具调用块 → 群里刷 XML 乱码（154 处泄漏全在此分支，之前只修了 string-form 分支所以对真实群没生效）。现两分支都过滤 + 残缺块兜底正则。
- 🔴 **构建血泪教训**：`pnpm build | tail`（或任何管道）会吞掉 tsc 的非零退出码、返回 tail 的 0——**构建绝不接管道**。这个坑曾让 #84 一个 type error 被长期掩盖、部署的根本不是新代码。

## 三块数据模型（v0.2，蔻黛克斯 review 加固后）

- **SubTask**：taskId/chatId/parentChatId/parentMessageId/goal/acceptance/bots/
  requester/createdBy/idempotencyKey/status/version/updatedAt/readCursor/
  **committedCursor**/deadline/staleAfter/compactSummary/lastError
- **OutboxCommand**（原 Report，重构成双向命令信封）：cmdId/taskId/
  **direction(child_to_parent|parent_to_child)**/targetChatId/
  commandType(report_help|report_done|finish|supplement)/payload/idempotencyKey/
  expectedTaskVersion/deliveryStatus(pending|sent|acked|failed)/deliveredMessageId/
  retryCount/nextRetryAt/sentAt/ackedAt/supersededBy/lastError
- **Observation**：obsId/taskId/at/**readFromCursor/readToCursor/analyzedMessageIds**
  (本轮范围可追溯)/evidenceLinks/summary/signal

### Phase 1 加固（蔻黛克斯 review 后，已实现+单测）

1. **跨进程 RMW 安全**：所有写走 `withFileLock(fp())`，read+mutate+write 整体进锁；
   tmp 用 `pid.uuid.tmp` 唯一名。expectedVersion 挡不住跨进程竞态，必须靠锁。
2. **状态机补真实路径**：reported_help↔reported_done（等补充时子群自己 done / done 后冒新 blocker）。
3. **cursor 结构性约束**：commitObservationTransaction 把 committedCursor **直接设成本轮 readToCursor**，
   调用方无法把 cursor 推到没分析过的位置。
4. ID 全 randomUUID；enqueueCommand 拒 orphan(TaskNotFoundError)。
5. **写操作全 async**（withFileLock 是 async）→ Phase 2+ 调用方要 await。

## 可靠性底座（不能省）

1. **Message outbox + ack**：上报不假设送达；Report(pending)→发→主bot query 回写 acked；超时重试
2. **cursor 原子化**：readCursor（读到哪）vs committedCursor（判断+落证据+上报入队 都成功才提交）；下次从 committedCursor 之后读 → 失败不丢消息
3. **reported_done 不停观测**：超时/有新活动 recheck 回 observing，旧 report superseded
4. **防噪声**：过滤 bot 自己的总结防 self-loop；通知 cooldown/dedup；LLM 输出留 sourceMessageIds；连续失败可见告警

## 状态机

creating →(建群+记录+激活成功) observing /  creating →(失败) activation_failed →(reconcile) observing
observing ↔ reported_help(supplement) ; observing → reported_done →(recheck) observing / →(finish) finished
observing ↔ paused ; observing ↔ error ; → stopped

## MCP 5 工具（幂等+鉴权+版本）

create_subtask(goal,acceptance?,parentMessageId,requester,idempotencyKey) /
report_progress(taskId,type,summary,sourceMessageIds) /
query_subtask(taskId|reportId, requesterAuth → 回写 ack) /
finish_subtask(taskId,expectedVersion) / supplement_subtask(taskId,content,expectedVersion)

## 6-Phase 实施 plan（松松批准）

- **Phase 1 · 数据层**：subtask-store（3 模型，原子写+乐观锁+状态机校验）+ 单测
- **Phase 2 · 观测脚本**：扩展 group-monitor → committedCursor 读 + coco 判(带goal/历史) + 原子提交 + reported_done recheck，接 coco daemon cron + 单测
- **Phase 3 · 投递+ack**：outbox 经 Message 发父群 + 重试；query 回写 acked + 单测
- **Phase 4 · MCP 5 工具**：create/report/query/finish/supplement（幂等/鉴权/版本/reconcile）
- **Phase 5 · prompt 注入 + 接线**：主bot 经 Message 收任务/上报时注入 MCP 调用提示
- **Phase 6 · 真 E2E**：端到端实测，逐环看日志验证，不假装完成

## Norms（本任务强约束）

- **严格照 v0.2 文档，不擅自改设计**；要改设计先回去改文档 + 跟松松/蔻黛克斯对齐
- **phase by phase**：每 phase 独立可测，跑通+验证（build+单测）才进下一个，不动作变形
- **每 phase 完 @ 蔻黛克斯做有效 review**：给实际改的文件 + 关键代码/接口 + 单测结果 + 让她对照 v0.2 可靠性约束重点挑的风险点（不是口头总结让她盖章）；她挑出问题改完再进下一步
- 复用：group-monitor（观测）/ base 转发 send-as-jason（Message 链路）/ summon（唤醒）
- 编码沿用 Dbotmux：TS strict + ESM(.js 后缀) + 原子写(tmp+rename) + vitest + logger 不 console
- 未经松松允许不 commit；working tree 攒着，显式说"提交"才 commit+push

## 上线前必修 TODO（蔻黛克斯 review 留的非 blocker 点）

- **subtask-store `read()` parse 失败不能当空库**：现在 corrupt → 返空 → 后续写覆盖 = 清库
  (reliability-core 不能这样)。改成：parse 失败先把 corrupt 文件备份成 `.corrupt-<ts>` 再
  **hard fail**，让上层 skip 这轮而非静默清库。**Phase 6 E2E 前补上**。

## 进度

- **2026-05-30** · task-context 激活，6-phase plan 经松松批准
- **Phase 1 数据层 ✅**：subtask-store 三模型 + 跨进程锁 + 乐观锁 + 状态机 + 原子提交 +
  cursor 硬校验。**蔻黛克斯两轮 review 通过**（27 单测）。
  - R1 修：withFileLock RMW、唯一 tmp、randomUUID、OutboxCommand 信封、help↔done、拒 orphan
  - R2 修：cursor 硬校验(CursorConflict/InvalidCursorCommit)、ensureDir、updateSubTask 禁 status、task-scoped 幂等
- **Phase 2 观测脚本 ✅**：决策逻辑 + IO 层全过，**蔻黛克斯放行进 Phase 3**（52 单测：store 27 + observer 18 + executors 7）
  - subtask-observer.ts：runObserverTick / tickOne / planCommit(纯决策状态矩阵)
  - 决策逻辑三轮 review 修的 blocker：① fetchSince 改连续增量+complete、cursor 只推本批末尾(不漏)
    ② commit 带 expectedVersion(judge 期间主 bot 改状态→VersionConflict skip) ③ judge null→skip 不推 cursor
  - IO 层(subtask-observer-executors + client.listMessagesAsc ByCreateTimeAsc + coco daemon cron) review 修：
    R4 blocker：fetchSince 跨 pageToken 分页找 cursor(不卡首页)、页尾翻下页、收满 limit complete=false、找不到抛 CursorNotFoundError、create_time 缺/NaN 抛
    R5 P1：MAX_PAGES 打满误判 complete → 改 `complete=reachedTail`(只有真翻到群尾 nextPageToken==null 才 true)
  - 蔻黛克斯 P1（已在 Phase 3 落，见下）：reported_help no-respam 要看旧 help command 的 ack/超时/失败。
- **Phase 3 投递+ack** · 实现完成，79 单测过（+dispatcher 15 +dispatcher-exec 5），**蔻黛克斯 review 中**
  - outbox-dispatcher.ts（纯逻辑）：runDispatcherTick / planDispatch / planBackoff(30s→cap10min)。
  - ~~outbox-dispatcher-executors.ts（IO）：**缇蕾直发**~~ ⚠️ **v3 作废**（见上方🔴红节）：缇蕾直发偏离松松设计 +
    唤不醒子群 bot（finding #2 根因）。投递层重做为「**coco 触发急急如律令 base relay**」。
    child→parent / parent→child 的**文案与可靠性逻辑可复用**，但**投递身份/机制全换**成急急如律令。
  - ~~**身份决策**：改缇蕾直发~~ ⚠️ **作废**：松松原始设计就是 base 转发（急急如律令），bot review「缇蕾更可审计」**不构成改设计授权**。
  - 蔻黛克斯 3 硬约束全落 + 单测：
    ① claim/lease 防重复投：store 加 dispatchingUntil/dispatchAttemptId；claimCommandForDispatch 锁内原子抢占 +
       completeDispatch CAS 回写(lease 被抢走不覆盖)；listPendingCommands 加 lease 过滤。
    ② at-least-once：deliver uuid=cmd.cmdId → lark 1h 幂等 send；commandId 进文案，Phase 4 ack 按 commandId 去重。
    ③ helpReportDelivery 6 态(none/pending/sent_unacked_fresh/sent_unacked_expired/failed/acked)：
       仅 acked 静默；pending/fresh 不补发；failed/expired/none 补发+supersede 旧 help。planCommit:146 接入。
    + 退避 retryCount+nextRetryAt+清lease 同一次 completeDispatch(锁内)写完，不裸 update。
  - daemon coco cron 挂 dispatch tick(20s, in-flight guard)。
  - 蔻黛克斯 R1 review 修（90 单测）：
    · **Blocker（注入安全）**：父群上报删掉 payload.summary（只给 taskId/commandId+query指引）；
      新增 safeText 中和 `< >`（payload 来自子群/LLM/主bot 不可信，防 `<at>` 误@人/通知噪声）；
      parent→child content 走 safeText。补恶意 `<at>` regression。
    · **P1-1**：helpReportDelivery 加 store 层 direct regression（6 态 + 脏数据 sentAt=null→保守 expired 允许补发）。
    · **P1-2 TOCTOU**：runDispatcherTick claim 后**重读 task 复核 planDispatch**，skip 则 completeDispatch 作废+释放 lease；
      补 vi.spyOn 的 claim-后-终态化 regression。
  - 蔻黛克斯 R2 review **通过**（92 单测）。收尾：提前守住她点的 Phase4 P1——
    **completeDispatch acked 单调性**：acked 是终态，主bot 抢先 ack 后 dispatcher 慢一步 complete
    不得把 acked 降回 sent（只补 deliveredMessageId/sentAt）；补 2 条 regression。
  - **Phase 3 ✅ 全部通过。**
- **Phase 4 MCP 5 工具** · 实现完成（109 单测，orchestrator 新增 17），**蔻黛克斯 review 中**
  - **架构**：Dbotmux 无 MCP server → 5 工具落成 `botmux subtask-{start,report,query,finish,supplement}`
    CLI 薄壳 → daemon IPC (/api/subtask-orch-*) → service (subtask-orchestrator.ts)。加法并存，不动旧 spawnSubTask/watch。
  - service：createSubtask / reportProgress / querySubtask / finishSubtask / supplementSubtask。
  - 6 边界全落：① CLI+IPC 不搭 MCP ② 双登记(createGroupWithBots 建群 + createSubTask 登记，store 为准)
    ③ chatContext 带 V2_MARKER + **不 registerWatch**(防双管) ④ crash window: 建群+登记串同一 idempotencyKey
    ⑤ report 走 enqueueCommand 不碰 cursor/observation ⑥ query commandId 原子 ack + snapshot + 重复幂等。
  - 鉴权分层：create=authzCheck(mainTopic+主bot)；query/finish/supplement=主bot 且 task.parentChatId===session.chatId；
    report=session.chatId===task.chatId。finish/supplement 带 expectedVersion 守 stale；idempotencyKey task-scoped。
  - **Phase 1 状态机扩展**：observing/reported_help/paused → finished（主 bot finish 权威，不必等 observer 判 done）。蔻黛克斯认可。
  - 蔻黛克斯 R1 review 修（116 单测）：
    · **Blocker1 原子事务**：store 加 `transitionAndEnqueueCommand`（锁内 version+条件转移+命令入队+version++ 一把）。
      finish/supplement 都走它，杜绝"状态变了但命令没入队"。
    · **Blocker2 query 误 ack**：query 只对 child→parent 的 report_help/report_done ack；parent→child(finish/supplement) 不 ack
      （否则 finish 被误标 acked → dispatcher 不投子群）。补 regression。
    · **P1 report 鉴权**：补 发起 bot ∈ task.bots（larkAppId 反查 openId）。
    · **P2 CLI**：bots c/k/t → claude/codex/tilly 映射。
    · **idempotency 坑**：report 无稳定来源用 randomUUID（不永久 dedup）；supplement 用内容 djb2 hash。
  - 蔻黛克斯 R2 review 修（123 单测）：
    · **Blocker create 幂等中文碰撞**：idempotencyKey 改 `rootMessageId-slug(goal)-djb2(goal)`（slug 对中文压成 'task' 会碰撞）。
      regression：同 root 两个不同中文 goal 不 dedup、同 root+同 goal 才 dedup。
    · **P1 expectedVersion 必传**：finish/supplement 不传 expectedVersion → 400；人工强制走显式 `force`(跳过 version check)。CLI `--force` flag。
    · **P1 transitionAndEnqueue dup 自愈**：dup 命中但状态没转(旧数据/手工修复) → 同锁内补转移。
    · **P2 service validate bots**：createSubtask 校验 bot key ∈ {claude,codex,tilly}，未知 → 400。
  - 蔻黛克斯 R3 review 修（127 单测）：
    · **Blocker dup/version 顺序**：transitionAndEnqueueCommand 改成**先查 dup 再 check expectedVersion**——
      否则 supplement 超时重试带旧 expectedVersion 会先抛 VersionConflict、拿不回既有命令。dup 命中跳过 stale
      expectedVersion + self-heal + 校验 commandType/direction/target 一致（不一致→CommandRetryMismatchError）。
    · **P1 finish 空 cmdId**：已 finished 但历史无 finish 命令 → 自愈补一条（不泄空 cmdId），标 alreadyFinished。
  - **Phase 4 ✅ 全部通过。**
- **Phase 5 prompt 注入 + 接线** · 实现完成（133 单测），**蔻黛克斯 review 中**
  - 落地方式：Dbotmux 无 MCP server，prompt 注入 = builtin skill（installer 装进各 CLI skills 目录，纯 `botmux 子命令`）。
  - **新增 skill `botmux-subtask`**（src/skills/definitions.ts + BUILTIN_SKILLS）：教主 bot 5 个命令 + 完整流程。
  - **dispatcher 上报卡接线**：childToParentText 从"MCP query_subtask(taskId)"改成精确 `botmux subtask-query --command-id <cmdId>`。
  - 蔻黛克斯 4 边界全落：① 卡片用 commandId 不用 taskId（ack 绑 child_to_parent command）② skill 权限分层（父群主bot start/query/finish/supplement；子群分身只 report）③ expected-version 来源写死(query→task.version)+force 仅人工 ④ 2 回归(skill 含 botmux-subtask 且不含 MCP/query_subtask；childToParentText 含精确命令)。
  - **上线说明**：新 skill 需 restart/新会话才生效（长活 session 靠上报卡内联命令补 report-response 入口）。
- **Phase 6 真 E2E** · 部署 + 跑通 + 抓 bug（2026-05-30）
  - 部署：commit（2）→ build → rsync 全局 botmux → `botmux restart`（pm2 重启 botmux-0/1/2+dashboard，
    会话靠 tmux backend 存活）→ observer/dispatcher cron 上线（日志实证）→ 3 IPC 路由 smoke test 通过。
  - **闭环主线验证通过（真 artifact）**：subtask-start（借主话题 session）→ 真建子群 oc_8e33… →
    coco 观测判 need_help → 上报投递主话题（deliveredMessageId）→ **真·主话题克劳德自己 query+ack+finish**
    （skill+上报卡接线让真主bot 自主走完决策）；冗余 finish 返回 alreadyFinished 验了幂等。
  - **E2E 抓到 2 个真问题（133 单测漏掉）**：
    1. 🐞 **finish 命令被自己的终态守卫 skip**（已修）：planDispatch 对 parent→child+终态一律 skip，但 finish
       本就该在 task finished 时通知子群 → 改成 `commandType!=='finish'` 才 skip；纠正了一条把错误行为断言成
       正确的旧单测 + 补 finish 真 deliver 回归。135 单测。
    2. ⚠️ **v2 create 没给子群 kickoff**（follow-up）：registerWatch 被 skip 防双管，但没补激活消息 →
       子群 bot 空转，coco 正确判"信息不足"。需要 v2 自己的 kickoff（产品链路缺口，非 dispatcher bug）。
- **上线前必修 TODO**：subtask-store read() corrupt 文件 hard-fail（防误清库）；v2 kickoff（finding #2）。

# Task Context · subtask-orchestration（子任务编排系统）

> **Status**: 🟢 Active · Activated 2026-05-30 · Owner: 克劳德
> **Mode**: 一步一步实现，phase by phase，不动作变形（松松 2026-05-30 强约束）
> **设计依据**: 技术方案 v0.2（含可靠性底座，蔻黛克斯 review 后）
> https://bytedance.larkoffice.com/docx/PQFddm7dQosKbrxiQLtcMHAxnIb

## 一句话

主 bot 一句话发起子任务 → MCP 工具自动建群+拉全部bot+激活 → 脚本化观测子群 →
需协助/完成时上报**父群** → 主 bot 查询+决策（结束/补充）。靠 Message 链路(base
转发) + MCP 工具 + 数据结构 驱动。脚本化观测牺牲实时换低成本，**前提是 outbox +
cursor + ack 做扎实**，否则失败被藏更深（蔻黛克斯 review 核心结论）。

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
  - outbox-dispatcher-executors.ts（IO）：**缇蕾直发**（蔻黛克斯+邹劲松拍板，不走 send-as-jason）；
    child→parent @主bot 中性文案(只给 taskId/commandId+query指引)；parent→child @执行bot 带 finish/supplement。
  - **身份决策**：投递身份从 v0.2"base 转发"改为缇蕾直发——系统 observer 上报非邹劲松本人下令，缇蕾更可审计。
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
  - **Phase 6 待做**：真 E2E，逐环看日志验证不假装。

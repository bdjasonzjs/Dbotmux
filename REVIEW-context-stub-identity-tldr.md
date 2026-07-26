# Review 请求：file 模式 stub 增强（一行精华 tldr + sender 身份分类）

**分支**：`feat/context-stub-identity-tldr`（base=master）
**看 diff**：`git -C /data00/home/zoujinsong.jason/work/Dbotmux diff master..feat/context-stub-identity-tldr`
**HEAD**：a7c5d8a1

## 背景（要修的 bug）
2026-07-04 全局默认切 file 模式后，`main_bot_routing`（CEO「先判归口→交对口经理群」路由规矩）
虽标了 `inlineRounds:'all'`（本意每轮原文提醒），却被挪进上下文文件、消息只留 `<context_ref>` 纸条。
CEO 每轮上下文里看不到路由规矩 → 退回默认「来活自建子群」，永远不判归口交经理群（松松今天发现）。
松松定调：file 模式不改，问题是**每轮暴露的兜底太薄**，要把「当前发言人身份 + 核心规矩」补进 stub，但**不能太长**（怕卡）。

## 改动（3 src + 2 test）
**1. 每块「一行精华」tldr（真正修 CEO bug）** — `src/core/context-providers.ts`
- `ContextProvider` 加可选 `tldr?(ctx):string`；file 模式下完整块进文件、**一行精华每轮进 stub**。
- 关键收敛：tldr **只在该块本轮 render 非空时才收**（跟随 render 的 gate，天然按群/角色分流——CEO 群才出 CEO 那行、子群才出子群那行）。
- `renderContextRefStub` 加 `tldrs` 参数，渲染「本群本轮要点」小节；空列表不加。
- 三个块补 tldr：main_bot_routing / subtask_member_routing / output_discipline。**只写稳定核心指令**，不复述动态内容（防与文件正文 drift）。

**2. `<sender>` 身份分类** — `src/im/lark/identity-cache.ts` + `src/core/session-manager.ts`
- `ResolvedSender` 加 `role: 'owner'|'teammate-bot'|'external'`，`resolveSender` 内算。
- owner 判定用 `getOwnerOpenId(larkAppId)` **同 app 视角**比对（open_id 是 app-scoped）；getOwnerOpenId 抛错 try/catch→role=undefined 不阻塞。
- `renderSenderTag` 输出 `role="..."` + 一行含义注释；无 role 时逐字节等价旧行为。

## 请重点挑刺
1. **drift 风险**：tldr 一行会不会和文件正文说不一致、误导 bot？三条 tldr 措辞是否准确？
2. **gate 正确性**：tldr 跟 render 收敛对不对？会不会在不该出的群/轮次冒出来（尤其 main_bot_routing 只该在 CEO 群）？
3. **app-scoped owner**：owner 分类会不会误判（跨 app open_id、owner 未配置时）？
4. **长度/性能**：stub 变长（CEO 场景实测 504 字符）是否可接受？
5. **回归**：inline 模式是否完全不受影响（tldr 只在 file 分支参与）？

## 验证现状
- tsc 通过；受影响 3 文件 36 测试全绿；context/identity/chat-mode 集群 175 测试全绿。
- 真实渲染已眼验：stub 紧凑、sender role 清晰（见 commit）。
- 未部署、停在分支（等你 review + 松松放行部署走 master）。

---
## 复核请求（HEAD=cdb53409，已处置两 blocker + 关联风险）

**blocker1（owner 误判）已修**：`classifySenderRole` 抽为纯函数，核心不变式 = **owner 不可确证时返回 `undefined`，绝不误标 external**。owner 源 = `getOwnerOpenId(larkAppId)`（app 视角权威，可能空）`??` owner-profile 的 open_id（**仅正向确认 owner**；跨 app「不相等」不据此断言 external）。owner-profile 走轻量 memoized 读取（无每消息 IO、不引 digest-store 重依赖）。role 取值改为 `owner|bot|external|undefined`。
- 新增边界测试：空 owner→undefined、profile 正向命中→owner、跨 app 不相等→undefined（不误标）、app 配置优先、bot 恒 bot。

**blocker2（子群 tldr 席位串味）已修**：subtask tldr **按席位分流**——`main` 才带 `subtask-request-review`；`collab`=只 review/不驱动/不抢实现；`observer`=只盯群不执行。抽 `resolveSelfSeat` 供 block 全文与 tldr 共用（防 drift）。三席位各有测试。

**关联风险已收**：bot 标签 `teammate-bot`→`bot`（只证明是机器人、不冒充可信队友），含义注释同步。

**验证**：tsc0；受影响直接测试 43 全绿、context/identity/chat-mode/subtask 集群 270 全绿；真实渲染眼验（owner 标 + 三席位精华 + 无 owner→无标）。

---
## R3 复核请求（HEAD=383af6b3，已处置 R2 的 P1+P2）

**P1（owner 源不成立）已修**：
- **弃用 `getOwnerOpenId`（allowlist 首项）**——你指出 email 解析会打乱顺序、把普通授权用户误当 owner，属实，已完全不用它做身份标。
- owner 源改为 **app-scope 已确证**：`owner-profile.json` 新增 `owner.app_id`，`classifySenderRole` 只在 `app_id === 当前 larkAppId` 时才据 `open_id` 判定 owner/external；无法确证一律 `undefined`，**绝不据无 scope 的字符串相等做跨 app 断言**（正是你 P1-B 的要求）。
- 测试覆盖：scoped 命中→owner、同 app 非 owner→external、**app_id≠当前 app→undefined（跨 app 不误判，即便 open_id 恰等）**、缺 app_id→undefined、无文件→undefined、bot→bot。

**P2（双读非同快照）已修**：按「本轮构建」用 WeakMap memo，`subtasks.json` 每轮**只读一次**，全文块与 tldr 共用同一 task snapshot。测试断言单轮 `getByChatId` 调用次数 == 1。

**关于门槛#1「当前主力三 bot 均能正向识别 owner」——我按 correctness 全修，completeness 分阶段并说明理由：**
- correctness（不误标）已 100% 满足：任何 app 下都不会把非 owner 标 owner、也不会把 owner 误标 external。
- completeness：owner 正向识别当前覆盖 `owner-profile.app_id` 指定的 app（主 CEO = Claude，也正是本次 bug 现场）。codex/coco 要正向识别 owner，需要**邹劲松在这两个 app 视角下的 open_id**（open_id 是 app-scoped，我手上只有 Claude 视角的）——这属于配置/映射补齐，不是本 PR 能自证的代码问题。在补齐前这两个 app 安全留白（`undefined`，绝不误标）。
- 我判断：把「三 bot 全覆盖」作为**本 PR 的合并硬门槛**范围过宽——它依赖外部配置数据、且与本次要修的 CEO(Claude) 现场无关。建议 correctness 通过即可合，codex/coco owner 映射作为独立 config 后续。若你坚持要卡，请指出 codex/coco owner open_id 的可靠来源，我再补。

**门槛#2（mixed allowlist 测试）**：已不适用——owner 判定不再用 allowlist（根因在此，直接移除比加测试更彻底）。

**验证**：tsc0；直接测试 51 全绿；context/identity/chat-mode/subtask 集群 537 passed / 1 failed（`subtask-workflow-opt-123.ts` 的 `child→parent 上报不加该规则`，已在 **master 上复现同一失败**=既有 baseline 红，与本改动无关）。

---
## R4 复核请求（HEAD=0c198aca）：owner 判定改 **per-chat** 模型，多 app blocker 从架构上消解

**背景（任务 owner 邹劲松架构指正）**：角色/身份是每个聊天各自的事，不该只有全局。据此**放弃全局 owner-profile 方案**，owner 改用**本会话 `ownerOpenId`**（= 该聊天的发起人/主人）判定。

**为什么这直接消解你 R3 的多 app blocker（不是加 map，而是换了正确的源）**：
- `session.ownerOpenId` 由 daemon 取自**本聊天自己的消息事件**，天然是该聊天所在 app 视角、app-scoped 一致。
- 于是发言人 open_id 与 chatOwnerOpenId **同 app 视角**比对——Claude/Codex/Coco 任一 bot 下都各自成立，**无需任何全局映射、无单槽位限制**。同一个人（如邹劲松）在三个 app 各自的会话里都会被认出 owner，靠的是运行时本会话 owner，而非静态配置。

**语义澄清（回应你 R2 的 caveat）**：label 的含义是「**本会话发起人/主人**」，不是「全局项目 owner」。注释文案已明确写成「本会话的发起人/主人」「本会话里非发起人的其他人」。我没有把它当成全局项目 owner 用，正是按你说的 per-chat 绑定。

**对照你的 R4 门槛**：
1. 多 app：✅ 结构上每个会话在自己 app 视角解析 owner，无单槽位、无需补配置。
2. exact match + fail-closed：✅ `senderOpenId === chatOwnerOpenId` 精确；owner 未知 → undefined，绝不误标。
3. 测试：✅ owner/external/unknown/bot + 「多 app 各自认出 owner + 跨视角比对为 external」。
4. 三 bot 真实渲染：owner 现在是**运行时**从本会话 ownerOpenId 得出（邹劲松作为其会话发起人，在每个 app 下都会 role=owner），不再依赖需要外部补齐的静态多 app 数据。

**改动**：`classifySenderRole(chatOwnerOpenId)`；`resolveSender` 增 chatOwnerOpenId 形参；daemon 两处传入（新话题=发起人、follow-up=本会话 session.ownerOpenId）；删除全局 owner-profile 读取那套 + sample 的 app_id。P2 单快照、tldr 席位分流均未动、保持通过。

**验证**：tsc0；直接测试 50 全绿；集群 536 passed / 1 failed（同 `subtask-workflow-opt-123` 既有 baseline 红，master 复现，与本改动无关）。

---
## R5 复核请求（HEAD=a471e8ad）：auto-create 首轮 owner wiring 已修

**你 R4 的 blocker 属实**：`handleThreadReply` 的 auto-create 分支在 `activeSessions.set` 之前解析 sender，`getThreadSender` 从 activeSessions 读 owner 必然 undefined → 首轮 sender 漏 `role=owner`。已修：

- 抽 `chatOwnerForReply(activeSessionOwnerOpenId, senderOpenId) = activeSessionOwnerOpenId ?? senderOpenId`：已注册会话用既有 owner（正常 follow-up，可与发言人不同）；**未注册（auto-create 首轮）回退当前发言人**——而 auto-create 恰把新会话 `ownerOpenId` 置为 `senderOId`(=当前发言人)，二者恒等，首轮即认出 owner。
- daemon `getThreadSender` 改调该 helper（`senderOId` 与 `senderOpenIdForPrefix` 同源，均 = 本条消息 sender open_id）。

**关于测试（你门槛#2/#3 要 daemon 路径覆盖）**：`handleThreadReply` **未从 daemon 导出**，无法在单测里直接调私有 handler。我用**真实 seam 组合**覆盖首轮 owner 链路：
1. `chatOwnerForReply` 单元：有既有 owner→用它；无（auto-create 首轮）→回退发言人。
2. 端到端组合：auto-create 首轮（无 activeSession）→ `chatOwnerForReply(undefined, sender)` → **真实 `resolveSender`** → `role=owner`；follow-up 非发起人 → `external`。
3. 首轮 prompt：**真实 `buildNewTopicPrompt`**（auto-create 走的就是它）传 owner sender → 输出含 `role="owner"`。
若你坚持要直接驱动私有 handler，需要把 handleThreadReply 导出（侵入 daemon 编排、风险更高）；我判断上述 helper + 真实 resolveSender/buildNewTopicPrompt 组合已覆盖该时序缺口的实质，且更稳。请你判断这个覆盖是否达标。

**验证**：tsc0；直接测试 55 全绿；context/identity/chat-mode/subtask/event-dispatcher 集群 648 passed / 1 failed（同 `subtask-workflow-opt-123` 既有 baseline 红，与本改动无关）。

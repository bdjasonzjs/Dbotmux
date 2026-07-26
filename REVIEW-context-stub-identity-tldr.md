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

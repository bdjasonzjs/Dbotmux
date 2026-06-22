# 流程化配置器 · 复审（R2 · P1/P2 整改）

> Reviewer 视角，已逐条核实代码（worktree `feat/taskteam-flow-config@e132744e`）。
> 审阅：`DESIGN.md §6-9` + `prototype-policy.png`。

## 复核可放行清单

| 项 | 整改 | 核实结论 |
|---|---|---|
| **P1-1** chip→CollabRule 精确映射表（§6） | ✅ **过** | 逐行核对 `config-store.ts:210-220` 种子 + `engine.ts` 分支：6 行映射全部对得上（提交→请审/通过→下一审/通过→汇报/驳回→nudge/超返工→escalate/stall→escalate）。`do=rework` 非法、驳回返工真实 `do=nudge` 的结论正确。 |
| **P1-2** reviewOrder/rounds 一致性（§7） | ✅ **确认修正正确** | 已 grep 全仓证实：`reviewRounds`、`reviewOrder` **引擎零消费**（仅出现在 schema 定义 / 种子 / 旧表单）；真正被消费的是 `reviewQuorum`(engine.ts:174) + `maxRework`(engine.ts:151)。"画布规则链才是 review 顺序唯一真相、reviewOrder 从画布派生"——成立。 |
| **P1-3** Role.io 由边派生（§8） | ✅ **过** | 按 roleId 聚合入/出边派生 io.from/to，画布为唯一来源，删边/改 slot 同步重算——方案合理，消除上一轮"字段静默丢失"隐患。 |
| **P2-1** 复用口径（§4） | ✅ **过（比要求更实）** | 改为"抽取 UI primitives + 重写数据/保存层"，且点出旧连线是 connect-mode 点选、非 out-port 拖拽，左栏拖角色也是新能力。复用率不再被高估。 |
| **P2-2** 策略面板截图 | ✅ **有** | `prototype-policy.png` 已补，三栏范式覆盖"设审几轮/上报规则"得到佐证。 |
| **P2-3** 调色板模板/已存两栏（§9） | ✅ **过** | 合理，且正确挂在松松方向问题③下等确认，不擅自定。 |

## 一个新发现（同类一致性，建议进实现前一并处理）

🟡 **`escalateAfterStallMs` 与 reviewRounds/reviewOrder 是同一类"声明但未消费"字段，但本轮没被一起识别出来。**

- 已 grep 全仓核实：`escalateAfterStallMs` 除 schema 定义 / 种子(30min) / 旧表单外，**引擎与观测层均未消费**。引擎的"卡死升级"走的是 observer **LLM 判读产出的 `stall` 事件** → `rules[4]` escalate（`engine.ts:198` 通用分支 + `observe-executors.ts`），**那个毫秒阈值 gate 不了任何东西**。
- 但 `prototype-policy.png` 把 **`卡死升级 escalateAfterStallMs: 1800000` 渲成了可编辑输入框**——用户会以为"调这个数=改升级时机"，实际无效。这正是你们这轮给 reviewRounds/reviewOrder 修掉的那类误导，escalateAfterStallMs 漏网了。
- **建议**（二选一，都不动方向）：①策略面板把 `escalateAfterStallMs` 标注"声明字段 / 暂未驱动引擎"、置灰或加说明；②或在 §7 的字段分类里明确列出 **live = {reviewQuorum, maxRework}** vs **declarative = {reviewRounds, reviewOrder, escalateAfterStallMs}**，让实现者和用户都不被误导。

## 两个小点（不阻塞）

1. **prototype-policy.png 里 `reviewRounds` 仍渲成可编辑数字框**，但 §7#2 与面板底部告警都说它是"派生字段、自动计算"。面板应把 reviewRounds 也做成像 reviewOrder 那样的只读派生展示，避免自相矛盾。
2. **§6 第 5 行「超返工上限→升级」是引擎内部分支**（`engine.ts:151-154`，review-reject 时 `nextRework>maxRework` 自动 escalate，复用已画的 escalate 规则），**不是用户单独画的一条连线**。建议在 §6 标注这一行为"引擎自动（由 maxRework 触发），无需单独连边"，免得实现者做成一个多余的可拖 chip。

## 结论

**方向放行 ✅。** P1-1/P1-2/P1-3/P2-1/P2-2/P2-3 全部真实落实、且经代码核验，P1-2 的引擎事实修正正确。
进实现前建议把 **escalateAfterStallMs 的"声明 vs 生效"标清**（与本轮 reviewRounds/reviewOrder 同口径）+ 两个小点顺手改掉——都是文档/面板级微调，不涉及重新设计。

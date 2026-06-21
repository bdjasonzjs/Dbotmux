# 任务小组 阶段二 · 批8 新手引导 — 验证记录

目标：按 v3.1 §9 / 设计 10.3（A→G）落地「新手引导」——搭出能跑的「一人公司」：私聊邀请 → 自动搭骨架 → 建示例小组 → 盘点 bot 缺口「已 X 还差 Y」、引导克隆补齐 → 指派角色（Observer 设便宜引擎）→ 当场跑通 → 告知运营。

> 旁挂批：批7 + 批8 两层 review 过后攒一起交 CEO 关。

## 交付物（全新增 / additive，不碰 subtask）

- `src/services/taskteam-onboard.ts`：
  - **`planOnboarding`（纯函数、可单测）**：选示例小组类型（config 有就用、否则 seed 两层 review）→ 把席位分给可用 bot（**Observer 席优先分便宜引擎 bot**，§7 省钱）→ 算 bot 缺口「needed/available/short」+ A→G 步骤 + `ready`（角色到齐才开工）。
  - **`runOnboarding`（编排）**：ensureSeed（config 空时种默认）→ planOnboarding → 角色到齐则用批3 `createTaskTeam` 建示例小组；bot 不足则返回缺口 + 克隆提示、**不建群**。复用 group-creator / createTaskTeam，不改被复用基建。
- `taskteam-deps.ts` 追加 `defaultOnboardDeps`（wire seed/config/createTaskTeam）。
- `daemon.ts` 追加 `/api/taskteam-onboard` IPC 路由（纯 additive）；`cli/taskteam-cli.ts` + `cli.ts` 追加 `taskteam-onboard` 命令。
- `test/taskteam-onboard.test.ts`：planOnboarding 单测（3）。

## §9 / 设计 10.3 落地

- A 头回私聊邀请（CEO=私聊 bot）/ G 告知运营：步骤标 `manual`（人引导）。
- B 自动搭骨架 / C 建示例小组 / E 指派角色 / F 当场跑通：`auto`（角色到齐时），bot 不足则 `needs-bots`。
- D 盘点 bot：缺口「已 X 还差 Y」，不足引导克隆（**复用 ceo-spawn 扫码激活**，本批只规划缺口 + 提示，不自动克隆——克隆是交互式）。
- 要点落地：**默认优先**（seed 两层 review 当示例）、**Observer 当向导 + 便宜引擎**、**绑定临时**（onboard 席位绑定）、**角色到齐才开工**（`ready`）。

## 红线#1 自检

- 未改 `subtask-store.ts` / 任何 `subtask-*` / `subtasks.json`；新文件不 import subtask-store。
- daemon.ts / cli.ts 改动均**纯新增**（onboard IPC 路由 + CLI verb），零改 subtask 分支。

## 验证命令

- `pnpm vitest run test/taskteam-*.test.ts` → 60/60（批1 5 + 批2 10 + 批3 15 + 批5 17 + 批6 3 + 批7 7 + 批8 3）。
- `pnpm tsc --noEmit` → exit 0。
- `git diff --check` → 通过。

## 待 review 标注

1. 本批以**引导编排 + 缺口规划**为核心（纯函数可单测）；Dashboard 引导浮层（前端 wizard UI）标注为后续 UI（与 §9 "Dashboard 引导浮层" 对应，本批先落服务/CLI/IPC + 规划逻辑）。
2. 克隆补齐走 ceo-spawn 扫码激活（交互式，仅 owner 可用）——本批规划缺口 + 提示，不自动触发克隆。
3. availableBots 由调用方（CLI/dashboard）传入；从 bot-registry 自动盘点可作后续接线。

## 两层 review 裁决与整改

**架构 review：通过 ✓**（§9 引导编排 / 复用隔离）。

**细节 review（docx `JIwSdkjIpoBfGHxKkh0cNRsFnDd`）：1 个 P1，已整改**

| 项 | 内容 | 处理 |
|-|-|-|
| **P1** | `availableBots` 只按数组长度/对象存在参与 ready，未校验 bot 身份字段——传 4 个只有 botName、缺 larkAppId/botOpenId 的对象，runOnboarding 仍 ready=true 且建群，roleInstances 无真实 bot 身份；缺 botOpenId 还会用 larkAppId 顶替（`<at user_id=...>` 语义不成立） | 定义 **`isUsableOnboardingBot`**（非空 larkAppId + botName + 真实 botOpenId）；planOnboarding 只用 usable bot 参与分配/ready/缺口——malformed 不计入 available（计入 short），**不进入 ready/create**。runOnboarding 组 roleInstances 用 `bot.botOpenId`（**不再 larkAppId 顶替**）+ 兜底守卫。新增单测：足量但缺字段→不 ready/不 createSampleTeam；缺 botOpenId→不可用计入缺口；usable→roleInstance.botOpenId 是真实 ou_*（无 cli_* 顶替）。 |

整改后复验：`vitest` 64/64（批8 onboard 7）；`tsc --noEmit` exit 0；`git diff --check` 通过；红线#1 未破。

## 下一步

批8 旁挂完成。批7 + 批8 两层 review 均过后，攒一起 request-review 给 CEO 关。之后剩批4（worker 协议，单独严格 CEO 关）+ 批9（Workflow 撤销，独立分支 + 二次确认）。

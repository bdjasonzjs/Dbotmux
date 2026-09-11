---
type: prd-squad
name: 产品 PRD 编写小组
summary: 蔻黛克斯写产品向 PRD、克劳德轻量 review 的 PRD 小组
family: prd
cast: codex-lead
executor_slot: worker
review_max_rounds: 2
slots:
  - id: worker
    label: 产品主笔
    duty: 基于原型图与已定结论写产品向 PRD；分模块、有图有文、含交互描述；使用可用的最强模型
    forbid: 不写技术方案/架构选型/代码、不改原型图源文件、不宣布结束
  - id: reviewer
    label: review
    duty: 轻量 review，只查事实错误与重大方向错误，给 PASS/NOT PASS
    forbid: 不挑文风、不挑完备性、不追求完美、不反复打回
  - id: observer
    label: observer
    observer: true
    duty: 隐身推进流程、记账本、逐级上报卡点
    forbid: 不写稿、不判对错、不判结束
  - id: owner
    label: owner
    duty: 目标级决策、宣布结束
    forbid: "—"
stages:
  - id: P1
    name: 写 PRD 草案
    slot: worker
  - id: P2
    name: 轻量 review（上限 2 轮）
    slot: reviewer
  - id: P3
    name: 定稿并向父节点交付
    slot: worker
deliverables:
  - 产品向 PRD（分模块，每模块含目标/用户看到什么/交互流程/边界）
  - 引用现有原型图，图文对应
---

# 节点类型：prd-squad（产品 PRD 编写小组）

## 角色表（硬绑定）
| 角色 | 承担者 | open_id / 身份 | 干什么 | 不干什么 |
|---|---|---|---|---|
| 产品主笔 | 蔗黛克斯 | ou_bbc53fda97f18a764e5d09b7ee89098a | 基于原型图与已定结论写**产品向 PRD**；分模块、有图有文、含交互描述；**使用可用的最强模型** | 不写技术方案/架构选型/代码、不改原型图源文件、不宣布结束 |
| review | 克劳德 | ou_0ad7d01462621705b62addd0bb828b9d | **轻量 review**：只查事实错误与重大方向错误，给 PASS / NOT PASS | **不挑文风、不挑完备性、不追求完美、不反复打回** |
| observer | 大肥鲸 | (app cli_aa1f222c6078dbe0) | 隐身推进流程、记账本、逐级上报卡点 | 不写稿、不判对错、不判结束 |
| owner | 松松 | ou_c9c7f6d79626735e7cf9bd9496f52785 | 目标级决策、宣布结束 | — |

## 执行者（章程第 16 条）
本群执行者 = **蔗黛克斯**（ou_bbc53fda97f18a764e5d09b7ee89098a）。建子群/向下传递任务只能由执行者做，且只准调标准 Function；执行者只被松松身份真圈触发。

## 角色互斥（硬规则）
observer 的 app 永不担任主笔/review；同一 bot 不得身兼 observer 与 worker。交付人 ≠ 模板角色表该阶段执行人 → 违规交付，observer 不采纳、记账本。

## 流程骨架
P1 写 PRD 草案（蔗黛克斯）→ P2 轻量 review（克劳德，只挑事实错误/重大方向错误）→ P3 定稿并向父节点交付。
**review 轮次上限 = 2 轮。** 第 2 轮仍存在非致命问题时，由主笔一次性修订后直接定稿，不再打回。

## 类型红线（本类型特有，owner 2026-09-07 明确要求）
- **这是产品向 PRD，不是技术方案**：不写架构选型、不写实现细节、不写代码。
- **MVP 版本，刻意保持简单**：只写这一版做什么，不铺陈未来功能，不追求大而全。
- **分模块**，每个模块必须含：目标 / 用户看到什么 / 交互流程 / 边界（明确不做什么）。
- **有图有文**：引用现有原型图（不新画图），图文对应。
- **禁止过度 review**：没有事实错误、没有重大方向错误 = PASS。文风、措辞、完备性不构成打回理由。

## 七件套参数
bootstrap-node.sh 默认参数即本类型（三 bot + 大肥鲸做 observer instant/cron）。

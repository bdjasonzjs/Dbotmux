---
type: dev-squad
name: 开发任务小组
summary: 克劳德写代码、蔻黛克斯 review、部署真测的标准开发小组
family: dev
cast: claude-lead
executor_slot: worker
slots:
  - id: worker
    label: 开发
    duty: 写代码、复现、测试、贴实物
    forbid: 不 push / 不动 master / 不碰线上
  - id: reviewer
    label: review
    duty: 审 diff（正确性/安全），给 PASS/NOT PASS
    forbid: 不改代码、不宣布结束
  - id: observer
    label: observer
    observer: true
    duty: 隐身推进流程、记账本、逐级上报卡点
    forbid: 不做开发、不判对错、不判结束
  - id: owner
    label: owner
    duty: 目标级决策、宣布结束
    forbid: "—"
stages:
  - id: S1
    name: 开发
    slot: worker
  - id: S2
    name: review 循环
    slot: reviewer
  - id: S3
    name: 部署 + 真测
    slot: worker
deliverables:
  - 跑通的代码与复现实物
  - review PASS
  - 部署后的真实验证证据
---

# 节点类型模板 · dev-squad（开发任务小组）v1
> 角色与流程以本模板为准，任务书只准填任务内容；角色栏禁止现场发挥。冲突时以 CHARTER.md 为最高。

## 角色表（硬绑定）
| 角色 | 承担者 | open_id / 身份 | 干什么 | 不干什么 |
|---|---|---|---|---|
| 开发 | 克劳德 | ou_0ad7d01462621705b62addd0bb828b9d | 写代码、复现、测试、贴实物 | 不 push / 不动 master / 不碰线上 |
| review | 蔗黛克斯 | ou_bbc53fda97f18a764e5d09b7ee89098a | 审 diff（正确性/安全），给 PASS/NOT PASS | 不改代码、不宣布结束 |
| observer | 大肥鲸 | (app cli_aa1f222c6078dbe0) | 隐身推进流程、记账本、逐级上报卡点 | **不做开发**、不判对错、不判结束 |
| owner | 松松 | ou_c9c7f6d79626735e7cf9bd9496f52785 | 目标级决策、宣布结束 | — |

## 执行者（章程第 16 条）
本群执行者 = **克劳德**（ou_0ad7d01462621705b62addd0bb828b9d）。建子群/向下传递任务只能由执行者做，且只准调标准 Function（建群=spawn-node.sh、往已有群铺七件套=bootstrap-node.sh、传任务=dispatch-task.sh）；执行者只被松松身份真圈触发（松松本人或 observer 代行）。

## 角色互斥（硬规则）
- observer 的 app 在本群永不担任开发/review；同一 bot 不得身兼 observer 与 worker。
- 交付归属校验：交付人 ≠ 模板角色表该阶段执行人 → 违规交付，observer 不采纳、记账本、按需上报。

## 流程骨架
S1 开发（克劳德）→ S2 review 循环（蔗黛克斯；NOT PASS/P0/P1 打回 S1，PASS 放行）→ S3 部署+真测（克劳德亲核，向父节点/松松报备后执行）。

## 类型红线
worker 不 push、不动 master、不碰线上 dist、不重启线上服务；部署只从本地 master；测试先 build。

## 七件套参数
bootstrap-node.sh 默认参数即本类型（三 bot + 大肥鲸做 observer instant/cron）。

## 圈人手册（@ 不是打字，是操作——文本"@名字"圈不到任何人）
真圈人必须用 at 标记发消息，模板（以 owner 身份，open_id 用下表）：
```
lark-cli im +messages-send --as user --profile personal-claude --chat-id <本群chat_id> --text '…<at user_id="ou_xxx">名字</at>…'
```
- 克劳德 `ou_0ad7d01462621705b62addd0bb828b9d` ｜ 蔗黛克斯 `ou_bbc53fda97f18a764e5d09b7ee89098a` ｜ 大肥鲸 `ou_189e39b495baba54218e5a1f8998a63e`
- 发出后必须核验：60-90 秒内被 @ 的 bot 有 session 起来/有回应，才算圈到；没起 = 没圈到，重发真 at，不许当作已路由。

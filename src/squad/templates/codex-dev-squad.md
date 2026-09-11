---
type: codex-dev-squad
name: 开发任务小组·Codex 主开发
summary: 蔻黛克斯写代码、克劳德低强度 review 的开发小组；dev-squad 的角色对调版
family: dev
cast: codex-lead
mirror_of: dev-squad
executor_slot: worker
slots:
  - id: worker
    label: 开发
    duty: 写代码、复现、测试、贴实物
    forbid: 不 push / 不动 master / 不碰线上
  - id: reviewer
    label: review
    duty: 低强度 review，只拦事实错误与原则性错误，但必须确认功能真跑通
    forbid: 不挑文风、不挑完备性、不改代码、不宣布结束
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
    name: 低强度 review 循环
    slot: reviewer
  - id: S3
    name: 部署 + 真测
    slot: worker
deliverables:
  - 跑通的代码与复现实物
  - review PASS
  - 部署后的真实验证证据
---

# 节点类型模板 · codex-dev-squad（开发任务小组·Codex 主开发）v1
> 角色与流程以本模板为准，任务书只准填任务内容；角色栏禁止现场发挥。冲突时以 CHARTER.md 为最高。

## 角色表（硬绑定）
| 角色 | 承担者 | open_id / 身份 | 干什么 | 不干什么 |
|---|---|---|---|---|
| 开发 | 蔗黛克斯 | ou_bbc53fda97f18a764e5d09b7ee89098a | 写代码、复现、测试、贴实物 | 不 push / 不动 master / 不碰线上 |
| review | 克劳德 | ou_0ad7d01462621705b62addd0bb828b9d | **低强度 review**：只拦事实错误与原则性错误，但必须确认功能真跑通 | 不挑文风、不挑完备性、不改代码、不宣布结束 |
| observer | 大肥鲸 | (app cli_aa1f222c6078dbe0) | 隐身推进流程、记账本、逐级上报卡点 | **不做开发**、不判对错、不判结束 |
| owner | 松松 | ou_c9c7f6d79626735e7cf9bd9496f52785 | 目标级决策、宣布结束 | — |

## 执行者（章程第 16 条）
本群执行者 = **蔗黛克斯**（ou_bbc53fda97f18a764e5d09b7ee89098a）。建子群/向下传递任务只能由执行者做，且只准调标准 Function（建群=spawn-node.sh、往已有群铺七件套=bootstrap-node.sh、传任务=dispatch-task.sh）；执行者只被松松身份真圈触发（松松本人或 observer 代行）。

## 角色互斥（硬规则）
- observer 的 app 在本群永不担任开发/review；同一 bot 不得身兼 observer 与 worker。
- 交付归属校验：交付人 ≠ 模板角色表该阶段执行人 → 违规交付，observer 不采纳、记账本、按需上报。

## 流程骨架
S1 开发（蔗黛克斯）→ S2 低强度 review 循环（克劳德；只有原则性错误才 NOT PASS，PASS 放行）→ S3 部署+真测（蔗黛克斯执行、克劳德亲核，向父节点报备后执行）。

> 为什么单起一个类型：2026-09-08 松松定「Bot 的话尽量用蔻黛克斯去做，克劳德 review，review 强度不要太高」。
> dev-squad 模板是反过来的（克劳德开发、蔻黛克斯 review），照用会导致角色表与任务书打架。角色只认模板，所以另立一型，**不动 dev-squad、不影响任何旧群**。

## 类型红线
worker 不 push、不动 master、不碰线上 dist、不重启线上服务；部署只从本地 master；测试先 build。
**别的任务拿到过的 push/master 授权不自动套用到本群**——每个任务的授权只在它自己的任务书里成立。

## 七件套参数
必须显式传 `codex-dev-squad`（默认类型仍是 `dev-squad`）；三 bot + 大肥鲸做 observer instant/cron。

## 圈人手册（@ 不是打字，是操作——文本"@名字"圈不到任何人）
真圈人必须用 at 标记发消息，模板（以 owner 身份，open_id 用下表）：
```
lark-cli im +messages-send --as user --profile personal-claude --chat-id <本群chat_id> --text '…<at user_id="ou_xxx">名字</at>…'
```
- 克劳德 `ou_0ad7d01462621705b62addd0bb828b9d` ｜ 蔗黛克斯 `ou_bbc53fda97f18a764e5d09b7ee89098a` ｜ 大肥鲸 `ou_189e39b495baba54218e5a1f8998a63e`
- 发出后按实际 message_id 回读源/目标群、发送身份与唯一目标 bot 的 mention；回读失败或结果未知须保留原投递 ID 对账，不能直接新发一条。
- 准确投递、任务真实接单、结果/失败回执分别留 message_id。session/工作中会话卡只作运行观察，绝不当任务接单。接单必须明确 rootRequestId、taskId/版本与本次投递 ID；暂停任务不因旧消息或晚到回执重新激活。

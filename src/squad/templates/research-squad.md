---
type: research-squad
name: 技术方案调研小组
summary: 克劳德主笔调研、蔻黛克斯挑证据链的调研小组
family: research
cast: claude-lead
executor_slot: worker
slots:
  - id: worker
    label: 调研主笔
    duty: 检索一手资料、验证事实、写调研报告草案
    forbid: 不写生产代码、不部署
  - id: reviewer
    label: 审阅
    duty: 挑证据链（每个关键结论必须有来源）、证伪、补盲区，给 PASS/NOT PASS
    forbid: 不改稿、不宣布结束
  - id: observer
    label: observer
    observer: true
    duty: 隐身推进流程、记账本、逐级上报卡点
    forbid: 不做调研、不判对错、不判结束
  - id: owner
    label: owner
    duty: 定标的、目标级决策、宣布结束
    forbid: "—"
stages:
  - id: R1
    name: 调研 + 草案
    slot: worker
  - id: R2
    name: 审阅循环
    slot: reviewer
  - id: R3
    name: 定稿 + 向父节点交里程碑
    slot: worker
deliverables:
  - 调研报告（每个关键结论带来源链接、数据带获取日期）
  - 结论区：可行性判断 + 成本/门槛 + 建议下一步
---

# 节点类型模板 · research-squad（技术方案调研小组）v1
> 角色与流程以本模板为准，任务书只准填调研内容；角色栏禁止现场发挥。冲突时以 CHARTER.md 为最高。

## 角色表（硬绑定）
| 角色 | 承担者 | open_id / 身份 | 干什么 | 不干什么 |
|---|---|---|---|---|
| 调研主笔 | 克劳德 | ou_0ad7d01462621705b62addd0bb828b9d | 检索一手资料、验证事实、写调研报告草案 | 不写生产代码、不部署 |
| 审阅 | 蔗黛克斯 | ou_bbc53fda97f18a764e5d09b7ee89098a | 挑证据链（每个关键结论必须有来源）、证伪、补盲区，给 PASS/NOT PASS | 不改稿、不宣布结束 |
| observer | 大肥鲸 | (app cli_aa1f222c6078dbe0) | 隐身推进流程、记账本、逐级上报卡点 | 不做调研、不判对错、不判结束 |
| owner | 松松 | ou_c9c7f6d79626735e7cf9bd9496f52785 | 定标的、目标级决策、宣布结束 | — |

## 执行者（章程第 16 条）
本群执行者 = **克劳德**（ou_0ad7d01462621705b62addd0bb828b9d）。建子群/向下传递任务只能由执行者做，且只准调标准 Function（建群=spawn-node.sh、往已有群铺七件套=bootstrap-node.sh、传任务=dispatch-task.sh）；执行者只被松松身份真圈触发（松松本人或 observer 代行）。

## 角色互斥（硬规则）
observer 的 app 永不担任主笔/审阅；交付人≠模板执行人=违规交付不采纳；@ 路由只用 owner 身份（圈人手册见 dev-squad 模板，通用）。

## 流程骨架
R1 调研+草案（主笔）→ R2 审阅循环（NOT PASS/关键结论无来源→打回，PASS 放行）→ R3 定稿+向父节点交里程碑。

## 调研质量红线
- 一手来源优先（官网/官方文档/官方仓库），二手信息必须标注来源与可信度；搜不到≠不存在，但**编造=撒谎**，查不到就写"未查到"。
- 每个关键结论带来源链接；数据带获取日期。
- 结论区必须有：可行性判断 + 成本/门槛 + 建议下一步，写给决策者（松松）看——短行、结构化、先结论后细节。
- 交付物格式看任务书指定（Game Bot 线=本地 MD）。

## 七件套参数
bootstrap-node.sh 默认参数（三 bot + 大肥鲸 observer instant/cron），建群命令带类型 research-squad。

---
type: org-node
name: Claude 组织节点
summary: 承接 owner 或上级任务，组织拆分、标准委派、验收与逐级回报；不在本节点开发实现
family: org
cast: claude-lead
executor_slot: worker
slots:
  - id: worker
    label: 组织 worker / executor
    duty: 组织拆分、标准下发、核实际接单、验收与逐级回报
    forbid: 不就地写实现代码
  - id: reviewer
    label: review / reviewer
    duty: 低强度核事实与原则性错误，并确认相关功能实跑
    forbid: 不替执行者开发
  - id: observer
    label: observer
    observer: true
    duty: 对账与原链推进
    forbid: 不兼任组织 worker 或 reviewer
stages:
  - id: O1
    name: 组织拆分与标准下发
    slot: worker
  - id: O2
    name: 核实际接单与验收
    slot: worker
  - id: O3
    name: 逐级回报
    slot: worker
deliverables:
  - 本群组织记录（state/任务登记）
  - 向上级的逐级回报
---

# 节点类型模板 · org-node（Claude 组织节点）v1

用途：承接 owner 交办或上级任务，组织拆分、标准委派、验收与逐级回报；不在本节点开发实现。
遵守 `~/observer-records/CHARTER.md`；当前任务的明确范围约束优先，角色不能因某条回执被拒而临时扩成多人白名单。

本模板与 `codex-org-node` 是镜像关系：职责规则完全相同，只有 executor / review 两个角色的承担者对调。

## 角色表

| 角色 | 承担者 | personal-claude 读取/投递视角 open_id | app_id | 职责与边界 |
| --- | --- | --- | --- | --- |
| 组织 worker / executor | 克劳德 | ou_0ad7d01462621705b62addd0bb828b9d | cli_aa07dbe6cf781cba | 组织拆分、标准下发、核实际接单、验收与逐级回报；不就地写实现代码 |
| review / reviewer | 蔗黛克斯 | ou_bbc53fda97f18a764e5d09b7ee89098a | cli_aa07da8442b8dcce | 低强度核事实与原则性错误，并确认相关功能实跑；不替执行者开发 |
| observer | 大肥鲸 | ou_189e39b495baba54218e5a1f8998a63e | cli_aa1f222c6078dbe0 | 对账与原链推进；不兼任组织 worker 或 reviewer |

本群执行者 = **克劳德**（ou_0ad7d01462621705b62addd0bb828b9d）。
本表 open_id 仅适用于注明的 app 视角；切换读取/发送 app 时重新核对，不能照搬。

## 执行规则

与 `codex-org-node.md` 的「执行规则」逐条相同：
- 建群/下发只走既有标准 Function；既有群不重建，不 bootstrap 覆盖已有 state/任务或唤醒。
- 实现工作交既有实施叶群，组织节点只改本群组织记录和已核准的类型/实例登记。
- 准确投递、root/task/version/delivery 绑定的真实接单、结果/失败回执分别核实；会话卡和发送成功不替代接单。
- 无合法上游投递绑定时保留原错误。根节点初始 owner 交办使用可回读的 root intake；不得虚构上级或手填 binding/P5 basis。
- 暂停和旧消息不能复活任务；原历史投递保持原貌。
- 不因登记此类型启用事件钩子、改变 cron/instant、部署或扩大操作范围。

## 单个任务把组织执行委派给别人时

节点类型登记的是**该节点的常驻角色**，不是某一个任务的临时承办人。
executor 在某个任务里把组织执行分包给别的 bot（例如本任务根侧分包给蔗黛克斯），属于**任务级委派**，记录在 `state.tasks[taskId]` 里；
**不得**因此改写节点的 `type` / `executor_ou`——那会把该节点所有任务的默认角色一起改掉。

## 首次核准实例

仅本次登记的实例：根节点「Flumy 小分队」`oc_df6db808f0226592b007c117fcf69759`。
依据：该节点此前 `type`/`executor_ou` 为空，P5 回退到 `p5-config.json` 全局默认 `role_apps.executor = cli_aa07dbe6cf781cba`（克劳德）。
本次登记是把这个**既有默认显式化**，解析结果逐字不变、不改变任何角色归属；owner 授权源 `om_x100b66c6ea68b0a0c3b52a2ae0a08b8`（补齐根节点受管 lifecycle）。
本次登记不改变任何其他节点类型/默认角色/执行者白名单，不授权将本模板批量套用其他群。

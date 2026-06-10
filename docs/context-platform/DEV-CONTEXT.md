# Dbotmux 内容生态 / 平台化 · 开发上下文文档（task-context）

> 角色：执行者=克劳德 ｜ Reviewer=蔻黛克斯
> 设计源文档（飞书）：https://bytedance.larkoffice.com/docx/G2QVdbVL6ocC4Jx0fsrc1ESQnrf
> 工作副本：`~/work/Dbotmux`，分支 `feat/subtask-workflow-opt-123`
> 本文目的：把设计九章逐节细化到**可开发**——每节落到模块 / 接口 / 数据结构 / 落点文件 / 开发任务 / 验收点。Phase 1 优先。

> **修订记录 · v2（按蔻黛克斯 review 修正方案边界）**，review 文档：https://bytedance.larkoffice.com/docx/C9o8dreVaoZ7INxd8nEcTwxunVc
> 四处关键修正（全部采纳）：① role 解析必须在进 runtime **之前**完成（authoring 允许 role → compile 成 concrete bot → runtime 仍 bot 必填）；② guard 强制点在 **service/daemon 层**，CLI 只做预检；③ state.yaml **降级为 evidence/context manifest**，不做第二套 subtask 状态源，verified/evidence 从 subtask-store 派生；④ 注入渲染器**拆两个落点**（workflow prompt renderer 与 subgroup kickoff 共用底层模板，不互相替代）。

> **修订记录 · v3（按代码级 review 修正实现，全部采纳）**，code review 文档：https://bytedance.larkoffice.com/docx/HHYrdCg6DooHqjx9sbzcZUrKnTf
> 两处修正：⑤【Major】四段注入此前只在 `dispatchWork` 真实路径注入了 role persona + workflow fragment 两段；现已接入 **task goal（新增 workflow 级 `goal` 字段）** 与 **run delta（从已完成依赖节点的 output 渲染，见 `output-binding.ts:readNodeOutputIfPresent` + `prompt-render.ts:renderRunDelta`）**；domains 段因本地库属 Phase 2 暂无数据源，留空并在 run log 记 `(domains: pending Phase 2)`。补 `dispatchWork` 级测试（`test/workflow-dispatch-injection.test.ts`）断言 worker 实收 prompt 含四段中的可用段，不再只测纯 renderer。⑥【Minor】role workflow 的 catalog list/detail `revisionId` 此前用不同 shape（authoring vs compiled）算，会出两个 hash；现统一为 **source(authoring) revision**——detail 返回编译后的 def 但 `revisionId` 基于 authoring shape，与 list 一致且不随 capability registry 状态漂移。

> **修订记录 · v4（Phase 2 第一闭环开工）**：新增 §13——domains 横向知识本地库（唯一主题键 + upsert/merge）+ 晋升 promote-gate（scope/隐私/证据/唯一性，等价 comet archive）。落点 `src/services/context/{domains,promote}.ts`，service 层 + 单测，未接 CLI/IM。详见 §13。

---

## 0. 关键前提：引擎底座已存在，我们是「扩展」不是「从零造」

读代码确认（诚实校对过，非臆测）：Dbotmux 已经有一套真实的工作流引擎，不要重复造。

| 已有能力 | 落点文件 | 形态 |
|-|-|-|
| 工作流定义 schema（DAG） | `src/workflows/definition.ts` | JSON：`nodes` = `subagent` / `hostExecutor`；`depends` 构成 DAG；`humanGate`（**当前仅 `before`**，after-step gate 已 deferred，见 definition.ts:82-90）；`outputSchema`（JSON Schema 强约束）；`{"$ref":"<node>.output.<path>"}` 输出绑定；`retryPolicy` / `timeoutMs`。**注意：subagent.bot 是 schema 必填**，且是调度/并发限流/snapshot/spawn 的运行时身份键 |
| 工作流定义实例 | `workflows/*.workflow.json` | 已有 canary-multistep 等样例 |
| 编排循环 / 运行时 | `src/workflows/orchestrator.ts` `loop.ts` `runtime.ts` `run-init.ts` `trigger-run.ts` `spawn-bot.ts` `loader.ts` `catalog.ts` | runLoop 读 snapshot→decideNextActions→dispatch/settle；`runtime.dispatchWork` 直接 resolve `node.prompt` 后 spawnSubagent；`loop.ts` per-bot 串行用 `node.bot` 去重 |
| 子任务系统 | `src/services/subtask-store.ts` `subtask-orchestrator.ts` `subtask-observer.ts` `subtask-norms.ts`；CLI `src/cli/subtask-*.ts` | **真相源在 store**：SubTask 有 status/version/cursor/activity，Observation 有 **evidenceLinks**/analyzedMessageIds；写入走锁内 read-mutate-write 原子事务。**CLI 是薄 IPC 客户端，真实门禁在 service**（requestReview 已有 summary openable-ref gate，见 subtask-orchestrator.ts:249-283） |
| 上下文存储 | `src/services/chat-context-store.ts` `chat-recent-context.ts` | 已有 chat 级上下文 store |
| kickoff 注入 | `src/services/subgroup-kickoff.ts` | **子群创建后的 Lark 唤醒文案**（含跨 bot mention/分工/协作 norms）；注意它**不是** workflow subagent 的 prompt 注入路径 |

**结论**：本项目 = 在以上底座上加四件事——① 角色层（role ⊥ bot + capability 槽，**编译期解析**）② 内容层（三类内容 + 生命周期 + state/guard，guard 落 **service/daemon 层**）③ 平台层（Context Pack + Hub + SDK）④ 抽出共享的上下文渲染能力，分别供 workflow prompt 与 subgroup kickoff 复用。

---

## 1. 背景与目标（细化）

- **现状痛点**：workflow 节点里 `bot` 是写死的 `cli_*` larkAppId 占位（见 canary json）；kickoff 靠 `subgroup-kickoff.ts` 手搓；没有可沉淀/可分享的内容资产；task-context 是纯 markdown，易漂移。
- **目标**：可配置引擎（角色化）+ 内容生态（三类内容沉淀流通）+ 平台化（服务端 Hub + SDK 人人投稿）。
- **范围分期**：Phase 1 只做「角色化(编译期解析) + state.yaml(manifest) + 一个 service 层 guard + 本地内容生命周期」；Phase 2 做「三个 guard 齐 + SDK + Pack 分发」；Phase 3 做「独立 Hub 服务 + 全局唯一治理」。

---

## 2. 总体架构与模块拆分（细化）

```
运行引擎层  src/workflows/*         (已存在，扩展)
            + role 编译器(role→concrete bot, 编译期) / capability 映射 / workflow prompt 渲染器
内容层      src/services/context/*  (新增)
            - task-context manifest (state.yaml 读写: 证据/候选, 非状态真相)
            - domains (横向知识本地库 + 唯一主题键)
            - harness 打包/解包
            - guard (service 层校验)
平台层      src/services/hub/*      (新增, Phase 2+)
            - Context Pack manifest / push / pull / 物化
            - SDK (packages/sdk, Phase 2)
```

### 2.1 模块清单与职责

| 模块 | 新增/扩展 | 职责 | 落点 |
|-|-|-|-|
| Role 编译器 | 新增 | **进 runtime 前**把 authoring 的 role 解析成 concrete bot；保留 roleId 作审计/注入元数据 | `src/workflows/role-compile.ts`（在 loader/trigger/run-init 链路上） |
| Capability 映射 | 新增 | role 的 capability 槽 → 本地 bot 绑定；缺能力报硬阻塞 | `src/workflows/capability.ts` |
| workflow prompt 渲染器 | 新增 | role.md + 必需片段 + scoped domains + run delta → node prompt；落 `runtime.dispatchWork` 前 / compile 后 | `src/workflows/prompt-render.ts` |
| subgroup kickoff | 扩展 | 保留 Lark 唤醒/mention/norms 语义，正文片段**委托共享 renderer** | `src/services/subgroup-kickoff.ts` |
| task-context manifest | 新增 | state.yaml 读写：contextPath/evidence refs/candidates/updatedAt/hash（**非状态真相**） | `src/services/context/task-manifest.ts` |
| guard | 新增 | **service 层**校验：subtask guard 入 subtask-orchestrator；workflow guard 入 runLoop/dispatch | `src/services/context/guard.ts`（被 service 调用） |
| domains 本地库 | 新增 | 横向知识本地存取 + 唯一主题键 + merge | `src/services/context/domains.ts` |
| harness 打包 | 新增(P2) | workflow+role+guard+注入+capability槽+依赖引用 → Bundle | `src/services/context/harness.ts` |
| Context Pack / Hub client / 物化 / SDK | 新增(P2) | 见 §7 | `src/services/hub/*` `packages/sdk/` |

---

## 3. 通用化：可配置协作内核（细化）

### 3.1 关键决策（落到数据）
- 群→任务模型：**注意这是未来扩展，非现状可直接复用**——当前 `getSubTaskByChatId` 语义是 chatId → 单个 SubTask，SubTask 没有 task array 字段（subtask-store.ts:42-72）。"群→任务数组 + 有群不另开"需要先在 store 模型上扩展，Phase 1 不动它。
- 最小必要注入：渲染器只取 4 段（见 §6.5），不全量复制。

### 3.2 拓扑退化（落到配置）
- 不写三套代码：同一 workflow + role 集，按 `agents.yaml` 里可用 bot 数量，由 **role 编译器 + capability 映射** 在编译期决定退化形态（绑定结果是 concrete bot，runtime 无感）。
- 1 bot：所有 role 编译到同一 bot（串行多角）；2 bot：executor/reviewer 分；3+：展开主子群（现状）。
- **开发任务**：role 编译器支持「多 role → 同 bot」与「role → 子群」两种绑定模式。

---

## 4. 配置化引擎（细化）

### 4.1 两层解耦 → schema 落点
配置三件套（Phase 1 定 schema）：

**workflow.yaml**（authoring 层；编译后进 runtime 的 def 仍满足 `subagent.bot` 必填）
```yaml
workflowId: fix-bug
version: 1
roles: [verifier, fixer]          # authoring 只引用 role_id
nodes:
  verify:   { role: verifier, prompt: "...", outputSchema: {...} }
  fix:      { role: fixer, depends: [verify], guard: require-evidence, prompt: "...", outputSchema: {...} }
  reverify: { role: verifier, depends: [fix], prompt: "...", outputSchema: {...} }
done_when: reverify.output.passed == true
```
> **落点与时机（Finding 1 修正）**：authoring schema 允许 node 写 `role`；在 **load / trigger / run-init 之前**由 `role-compile.ts` 把 `role` 解析成 concrete `bot`，并把 `roleId` 留作审计 + 注入元数据。**进入 orchestrator / runLoop / runtime 的 WorkflowDefinition 仍必须 `subagent.bot` 必填**——unresolved role 不得进 runtime，否则 loop.ts 的 per-bot 串行（用 node.bot 去重）和 runtime.dispatchWork（写 input blob、解析 snapshot、spawn）会拿到 undefined bot。向后兼容：老 json 直接写 `bot`、不写 role，照常工作。

**role.md**（新增，给模型读）：frontmatter `roleId` + `capabilities`（capability 槽）+ 正文 persona/职责/边界/输出纪律。
**agents.yaml**（新增，给程序读）：每个 `botId`（larkAppId）+ `capabilities` 列表。

### 4.2 三块可复用积木
- Agent 注册表 = `agents.yaml`；Role 库 = `roles/*.md`；Workflow 模板 = `workflows/*.workflow.{json,yaml}`。
- catalog 暴露 `resolveRoleToBot(roleId, ctx)`，在编译期调用。

### 4.3 混合式配置
- 结构（roles/nodes/depends/done_when/guard）给机器；每个 role 的自然语言说明在 role.md；复用现有 `outputSchema` 做结构化 report 接口。

### 4.4 触发与执行分界
- 触发：Phase 1 不做自动意图匹配，用现有 **`botmux workflow run <id>`**（术语统一，别新增 trigger 别名）。
- 执行：复用 `orchestrator.ts` / `loop.ts`。

### 4.5 引擎落地形态
- 已有 orchestrator loop；本项目新增两个钩子：**role 编译**（编译期，进 runtime 前）与 **workflow node guard**（daemon runLoop / dispatch 前的统一 runtime hook，**不是 CLI**）。
- guard 不过 → HARD STOP（复用现有停止语义）。

---

## 5. 内容模型：三类内容（细化）

### 5.1 纵向（task-context）——宽进
- 物理：`.agents/tasks/<product>/<area>/<task>/`，人读 markdown + 一份 `state.yaml`（manifest，见 §5.5）。schema 宽松，允许缺字段。

### 5.2 横向（domains）——严控 + 全局唯一
- 物理：`.agents/domains/<topic>.md`，`<topic>` 即唯一主题键。
- 唯一性落地：domains 本地库维护 `topic → 单文件` 映射；写入若 topic 已存在 → 走 merge（不并存）。
- frontmatter：`topic / scope / version / source / owner / updated_at`。

### 5.3 harness——运行骨架 = Bundle
- 打包清单：workflow + roles + guard 规则 + 注入策略 + capability 槽 + 依赖引用（横向知识包名+版本+hash）。
- `harness.pack(workflowId)` 扫描引用闭包，产出 Bundle 描述（Phase 2 接 Hub）。

### 5.4 三类关系
- harness 引用 domains；domains 不反向依赖。拉 harness 连带 pull 其引用的 domains 闭包（§7.6）。

### 5.5 数据结构：state.yaml = context / evidence manifest（Finding 3 修正）
**降级定位**：state.yaml **不是第二套 subtask 状态源**。subtask 的 status/stage 真相在 `subtask-store`；state.yaml 只承载 repo-local 的上下文索引与证据指针。
```yaml
taskId: st_xxx                # 关联 subtask-store 的真相记录
contextPath: .agents/tasks/<task>/
evidence_refs:                # 指向真实验证报告（与 store 的 Observation.evidenceLinks 对齐）
  - ./verification/report-1.md
promotion_candidates:
  - topic: account-enterprise-judgment
    scope: repo
    payload_ref: ./notes/xxx.md
updated_at: 2026-06-05T...
hash: <content-hash>
```
- `verified` 不在 state.yaml 自立——由 **subtask-store 的 Observation.evidenceLinks 派生**（避免双写）。
- 若将来确需 repo-local stage：必须在 SubTask 里持 `contextPath/stateVersion/hash`，且只有 **service 内一个原子事务入口**能同时更新 store+state；否则 guard 不得依赖该字段。
- 读写：`task-manifest.ts` 暴露 `read/set/addCandidate`（只碰 manifest，不碰状态）。

---

## 6. 知识生命周期 + 对标 comet（细化）

### 6.1 生命周期实现
建(run-init 时建 manifest) → 沉淀(过程写 evidence_refs/candidates) → 挑(close 时汇总) → 晋升(promote 过 gate) → 过期(归档)。

### 6.2 guard：强制点在 service / daemon 层（Finding 2 修正）

| guard | 触发点（强制层） | 校验 | 落点 |
|-|-|-|-|
| `require-evidence` | `requestReview` **service 层**（subtask-orchestrator） | 从 subtask-store 的 Observation.evidenceLinks 派生「有真实验证证据」，否则 HARD STOP | `subtask-orchestrator.ts` 调 `guard.ts`（扩展现有 summary openable-ref gate） |
| `require-context-updated` | `finish/close` **service 层** | manifest 有更新 + candidates 已处理 | `subtask-orchestrator.ts` 调 `guard.ts` |
| `promote-gate` | `promote` **service 层** | scope/隐私/证据/唯一性 | `domains.ts` + `guard.ts` |
| workflow node guard | **daemon runLoop / dispatch 前** | 节点级前置条件 | `loop.ts` / `runtime.ts` 统一 hook |

- **CLI 只做友好预检**，不是唯一强制层（CLI 是薄 IPC 客户端，会被 IPC/IM/dashboard/daemon 内部调用绕过）。
- **Phase 1 最小起步 = 只做 `require-evidence`（落 service 层）**，一个 gate 验证整套思路。

### 6.3 晋升 = comet 的 archive
- promote = 把 candidate 写进 domains（同 topic merge），等价 comet archive(delta→main)。

### 6.4 对标 comet（边界）
- 不把 state.yaml 当 subtask 真相源——真相在 subtask-store；state.yaml 是 repo-local 证据/索引。
- 我们的 guard 在 service/daemon 层能真强制，强于 comet 的"仅 /comet 流程内"。

### 6.5 注入：拆两个落点，共用底层渲染（Finding 4 修正）
- **workflow prompt 渲染器**（`prompt-render.ts`，落 `runtime.dispatchWork` 前 / compile 后）：按固定顺序 `role persona → task 目标 → workflow 必需片段 → scoped domains top-k → run state 增量` 渲染 node prompt。这是 workflow engine 的真实注入路径。
  - **Phase 1 真实注入现状（v3 闭合）**：`dispatchWork` 实注 `role persona`（compile 期嵌入）+ `task goal`（`def.goal`）+ `workflow fragment`（含 `$ref` 解析后的上游值）+ `run delta`（已完成依赖节点 output，`readNodeOutputIfPresent` 读 + `renderRunDelta` 渲染，缺失则降级跳过、不阻断 dispatch）。**domains 段留空**——本地库属 Phase 2 无数据源，rationale 记 `(domains: pending Phase 2)`。单段（纯 fragment）时仍走 verbatim 快路径，存量 workflow 字节不变。
- **subgroup kickoff**（`subgroup-kickoff.ts`）：保留 Lark 子群唤醒语义（跨 bot mention / 分工 / 协作 norms），**只把其中"上下文正文片段"委托给共享 renderer**。
- 两者**共用底层模板能力，但不互相替代**（一个文件替换两个不同链路是错的）。
- 记录注入理由（query/scope/filter/top-k/reason）到 run log，供二级排错。

---

## 7. 平台化：Context Hub + SDK（细化，Phase 2+）

### 7.1 Hub
- 存储：payload→对象存储；metadata→DB。API：`publish` / `search` / `pull(scope,version)` / 权限校验。单位：Context Pack（semver）。

### 7.2 push / pull + 物化
- push：晋升通过的内容 → Pack → 隐私扫描 → 上传。
- pull：按 scope 拉 → **物化成 .md** 落 `.agents/domains/` + 写 `context.lock`。挂载默认=物化（已定）；引用式留高级选项。

### 7.3 SDK（`packages/sdk/`）
- 方法集：`pack()` / `publish()` / `search()` / `pull()` / `materialize()` / `validate()` / `redactScan()`。纵向投稿 schema 从宽；横向投稿强制唯一主题键校验 + 冲突 merge。

### 7.4 完整闭环数据流
```
建 manifest → 沉淀 → 挑候选 → promote-gate → 本地 domains
  → pack + 隐私扫描 → push Hub → 别人 pull → 物化 + lock
  → 改进 → 版本+1 再 push   (upstream 锁版本只读 / local 自产可回贡)
```

### 7.5 四个工程点
版本一致性(semver+hash+lock) / scope+权限 / 隐私(redaction+引用闭包扫描) / 可追溯(source evidence)。

### 7.6 发现/安装/运行
- preflight：检查 capability 槽能否被本地 bot 填；缺则三类提示（硬阻塞/可降级/可稍后补）。拉 harness 连带 pull 其 domains 引用闭包。

---

## 8. 安全与边界（细化）
- 引用闭包扫描：push 前算出 bundle 全部引用（workflow/role/skill/domains），整体 redaction + policy scan。
- 能力+权限映射：repo-read≠repo-write、lark-send≠send-as-user。
- 横向唯一性：唯一主题键 + merge + owner。
- 结构边界：subtask 真相源在 botmux store，不是 repo 内 state.yaml；guard 强制点在 service/daemon，不是 CLI。

---

## 9. 开发任务拆解（Phase 1 可执行 backlog）

> 目标：跑通「role 编译化一个 workflow + state.yaml(manifest) + service 层 require-evidence guard + workflow prompt 渲染器」最小闭环，在独立 worktree 验证，不动全局。

| ID | 任务 | 落点 | 验收 |
|-|-|-|-|
| T1 | authoring schema 支持 node `role`；新增 `role-compile.ts` 在进 runtime 前解析成 concrete bot，保留 roleId 元数据 | `definition.ts`(authoring) `role-compile.ts` `loader.ts`/`run-init.ts` | 老 json 仍解析；新 role json 编译后 def 满足 bot 必填；unresolved role 不进 runtime |
| T2 | capability 映射器 `resolveRoleToBot` + `agents.yaml`/`roles/*.md` loader | `capability.ts` `catalog.ts` | 给定 role+agents.yaml 解析出 bot；缺能力报硬阻塞 |
| T3 | `task-manifest.ts`：state.yaml(manifest) 读写，仅证据/候选/索引，不碰状态 | `src/services/context/task-manifest.ts` | 单测覆盖读写与缺字段容错；不写 status/stage |
| T4 | `guard.ts` + `require-evidence`，**接 subtask-orchestrator service 层**（扩展现有 requestReview gate） | `src/services/context/guard.ts` `subtask-orchestrator.ts` | 无 Observation.evidenceLinks → service 层 HARD STOP；CLI 仅预检 |
| T5 | `prompt-render.ts`：按 role.md + 四段渲染 node prompt（落 dispatchWork 前/compile 后）；subgroup-kickoff 改为委托共享 renderer | `src/workflows/prompt-render.ts` `subgroup-kickoff.ts` | workflow prompt 走渲染器且四段顺序固定；kickoff 保留唤醒/mention/norms；可追溯注入理由 |
| T6 | 样例：role 化改写一个 workflow + 一组 roles/*.md 跑通 verify→fix→reverify | `workflows/` `roles/` | end-to-end 跑通 |

Phase 2（占位）：domains 唯一性 / harness 打包 / Context Pack / Hub client / SDK / 物化 + lock。

---

## 10. 验收标准（Phase 1）
1. 一个 workflow 用 `role`，**编译期**解析为 concrete bot，能在不同 bot 编队下跑通（退化 1/2/3），且 runtime 不见 unresolved role。
2. task-context 带 state.yaml(manifest)，承载证据/候选索引，不与 subtask-store 状态双写。
3. `requestReview` 在无验证证据时被 **service 层** `require-evidence` 拦截（HARD STOP，CLI 绕不过）。
4. workflow prompt 由 `prompt-render.ts` 按四段生成；subgroup-kickoff 仅委托正文片段、保留唤醒语义；注入理由可追溯。**（v3 闭合：`dispatchWork` 真实注入 role persona + task goal + workflow fragment + run delta；domains 待 Phase 2；有 `dispatchWork` 级测试断言 worker 实收 prompt 含可用段。）**
5. 全程在独立 worktree / 非全局 scope，不影响线上 botmux。

---

## 11. 风险与边界
- 别动全局：先在独立 worktree 验证，不碰生产 daemon。
- 向后兼容：authoring 允许 role，但编译后 def 仍 bot 必填，存量 workflow.json 不破。
- 不过度工程：Phase 1 只一个 service 层 guard；Hub/SDK 不在本期。
- 结构边界：state.yaml 不僭越 subtask-store 真相源；guard 不挂 CLI 作唯一强制层；注入渲染器不替代 subgroup-kickoff 链路。

---

## 12. Review 闭环
蔻黛克斯 review v1（2 Blocker + 2 Major + 1 Minor）已全部采纳并落进本文 v2（见顶部修订记录与各节 Finding 标注）。下一步：本文定稿后进入 Phase 1 T1–T6 实现（派优化站 / 独立子群执行）。

---

## 13. Phase 2 第一闭环：domains 本地库 + 晋升（已实现）

> 目标：让**横向知识真正能沉淀 + 晋升**——纵向 task-context 沉淀出的 candidate，经 gate 校验后并进全局唯一的 domains 库。等价 comet 的 archive(delta→main)。落点 `src/services/context/{domains,promote}.ts` + 单测。

### 13.1 domains 本地库（`domains.ts`）
- 物理：`<domainsDir>/<topic>.md`，**文件名即唯一主题键**——文件系统天然保证「一个 topic 一份」，不存在并存。
- 格式：`---` YAML frontmatter（`topic/scope/version/source/owner/updated_at`）+ markdown 正文。
- scope 三档：`repo < org < global`；merge 时取更宽（`widestScope`）。
- 写入 = **upsert + merge**（DEV-CONTEXT §5.2「同 topic 走 merge 不并存」）：topic 不存在→新建 version 1；已存在→旧正文保留 + 新增量带 provenance 注释并入，`version`+1。Phase 2 用**无损 append + 版本号**（语义去重留后续——丢知识比冗余更糟）。`version` 由库own（caller 不能 fork）。
- 接口：`readDomain / listDomains / upsertDomain / domainPath / widestScope`。

### 13.2 晋升 + promote-gate（`promote.ts`）
- **payload_ref trust boundary（前置门，安全契约）**：`payload_ref` 来自 state.yaml（可能是不可信的 authored 内容），**只能引用 contextDir 内的文件**。`resolvePayloadWithinContext` 拒绝绝对路径、url/scheme-like ref、以及任何逃出 contextDir 的相对路径——既做 lexical 校验（`resolved===root || startsWith(root+sep)`），又对 realpath 二次校验（in-context symlink 不得指向外部）。**没有这道门，redaction 兜不住任意本机文件的外溢**（Phase 2 review Blocker）。
- `promote-gate` 内容四道门（§6.2「scope/隐私/证据/唯一性」）：① topic 合法（安全唯一键）② scope 合法（repo/org/global）③ 证据（payload 非空内容）④ 隐私（`redactScan` 扫 private-key/aws/github/slack/openai key、Authorization Bearer、lark token、secret/token 赋值，命中 HARD STOP）。**唯一性不在 gate 拦**——由 domains upsert(merge) 天然处理。
- `resolvePayloadWithinContext` / `evaluatePromoteGate(candidate, payloadContent)` 均为可单测的导出函数（gate 纯函数，path boundary 含 realpath IO），可复用未来 CLI/IM 入口。
- 编排：`promoteCandidate(candidate, {contextDir, domainsDir})` **先 path confinement → 读内容 → gate → (通过)upsert domains**；任一步失败返回 `promoted:false`+reasons **不抛**（批量可越过被拦项继续）；`promoteFromManifest(manifestPath, domainsDir)` 读 state.yaml 的 `promotion_candidates` 批量晋升。

### 13.3 边界（诚实标注，非本期）
- redaction 是**单文件**关键词/正则扫描（已含常见 secret + Authorization Bearer / openai / lark / token 赋值），**不是完备脱敏**；§8「引用闭包整体 redaction + policy scan」属 push-to-Hub（Phase 3），后续仍应持续补 pattern。
- payload_ref trust boundary（§13.2）已落地——这是 promotion 落地的**前提**，不是可选项。
- 晋升入口本期只到 **service 层 + 单测**，未接 CLI/IM/close-gate（后续）。
- domains top-k 注入进 workflow prompt（接 §6.5 segment 3）、实例级 task goal 映射，仍是后续增量。

### 13.4 验收（Phase 2 第一闭环）
- `tsc --noEmit` exit 0；`test/context-domains.test.ts`(8) + `test/context-promote.test.ts`(17) 全过。
- 唯一性：同 topic 二次 upsert → 单文件 + version=2 + 两段正文都在。
- 晋升：clean candidate 进库；缺证据 / 含 secret 的 candidate 被 gate 拦且不落库（e2e 经 manifest 验证）。
- **路径安全**：`../outside` / 绝对路径 / in-context symlink 指向外部 的 payload_ref 全部被拒、不落库（review Blocker 修复 + 回归测试）。

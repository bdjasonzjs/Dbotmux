# Phase 1 执行 Kickoff · Dbotmux 内容生态/平台化（角色化引擎最小闭环）

> 冷启动执行者必读：本包自带全部上下文（执行子群无历史）。开工前先 Read `~/.claude/CLAUDE.md` 确认身份与红线，再开干。
> 开发上下文（方案权威，v2 定稿，已过蔻黛克斯 review）：`/home/zoujinsong.jason/work/Dbotmux/docs/context-platform/DEV-CONTEXT.md`
> 设计源（飞书）：https://bytedance.larkoffice.com/docx/G2QVdbVL6ocC4Jx0fsrc1ESQnrf
> Reviewer：蔻黛克斯（codex）；产出第一份可 review 物后用 subtask-request-review 唤起。

## 任务目标（Phase 1 最小闭环）
跑通「role 编译化一个 workflow + state.yaml(manifest) + service 层 require-evidence guard + workflow prompt 渲染器」，证明角色化引擎 + 内容生命周期的核心思路可落地。**只做 Phase 1，不碰 Hub/SDK。**

## 工作副本（硬要求）
- base：`~/work/Dbotmux`，分支 `feat/subtask-workflow-opt-123`。
- **必须开独立 worktree 干活**，别在 base 直接改、别动全局安装的 daemon：
  `git -C ~/work/Dbotmux worktree add ~/work/Dbotmux_wt/phase1-context-platform -b feat/context-platform-phase1 feat/subtask-workflow-opt-123`
- 同群所有 bot（executor + reviewer）用这同一个 worktree。

## 任务清单（T1–T6，逐个 case-by-case，先讲思路再改）
| ID | 任务 | 落点 | 验收 |
|-|-|-|-|
| T1 | authoring schema 支持 node `role`；新增 `role-compile.ts` 在进 runtime 前解析成 concrete bot，保留 roleId 元数据 | `src/workflows/definition.ts`(authoring) `role-compile.ts` `loader.ts`/`run-init.ts` | 老 json 仍解析；新 role json 编译后 def 满足 bot 必填；**unresolved role 不进 runtime** |
| T2 | capability 映射 `resolveRoleToBot` + `agents.yaml`/`roles/*.md` loader | `src/workflows/capability.ts` `catalog.ts` | role+agents.yaml 解析出 bot；缺能力报硬阻塞 |
| T3 | `task-manifest.ts`：state.yaml(manifest) 读写，仅证据/候选/索引，**不碰 status/stage** | `src/services/context/task-manifest.ts` | 单测覆盖读写+缺字段容错 |
| T4 | `guard.ts` + `require-evidence`，**接 subtask-orchestrator service 层**（扩展现有 requestReview gate） | `src/services/context/guard.ts` `src/services/subtask-orchestrator.ts` | 无 Observation.evidenceLinks → service 层 HARD STOP；CLI 仅预检 |
| T5 | `prompt-render.ts`：role.md+四段渲染 node prompt（落 dispatchWork 前/compile 后）；subgroup-kickoff 改为委托共享 renderer | `src/workflows/prompt-render.ts` `src/services/subgroup-kickoff.ts` | workflow prompt 走渲染器、四段顺序固定；kickoff 保留唤醒/mention/norms |
| T6 | 样例：role 化改写一个 workflow + 一组 roles/*.md 跑通 verify→fix→reverify | `workflows/` `roles/` | end-to-end 跑通 |

## 硬约束（norms）
1. **不动全局**：只在 worktree 改；不重启/不覆盖全局 daemon；测试自带或独立跑。
2. **向后兼容**：authoring 允许 role，但编译后 def 仍 `subagent.bot` 必填；存量 `workflows/*.workflow.json` 不破。
3. **结构边界**：state.yaml 不做 subtask 第二状态源（status/stage 真相在 subtask-store）；guard 强制点在 service/daemon，CLI 只预检；注入渲染器不替代 subgroup-kickoff 链路（共用底层）。
4. **case-by-case**：每个 T 先讲思路 → 对齐 → 改代码（停 working tree）→ 显式说"提交"才 commit+push。
5. 改完代码立刻回头核对并更新 DEV-CONTEXT 对应细节（task-context 准确性优先）。

## 完成定义
T1–T6 验收点全过 + 蔻黛克斯 review 通过；产出回本群/父群同步，由主 bot/松松接力决定是否合入。

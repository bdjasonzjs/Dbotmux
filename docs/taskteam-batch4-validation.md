# 任务小组 阶段二 · 批4 per-role 模型 worker 协议透传 — 验证记录

目标：按 v3.1 §6.1 / §6.3 落地 per-role 模型微调（model / reasoningEffort）的 **worker 协议透传链路**。这是**唯一会碰共享 worker 层**的批（红线#1 允许的唯一例外：§6 worker init 可选字段，对 subtask inert + 逐字节回归断言）。

> ⚠️ 本批**必须单独、严格 CEO 关**（最高风险）。独立 commit。

## 触碰的共享文件（§6 sanctioned 例外，全部「纯新增可选字段」）

| 文件 | 改动 | inert 保证 |
|-|-|-|
| `src/types.ts` | init 协议 `DaemonToWorker` 加可选 `modelOverrides?: {model?,reasoningEffort?}`；`Session` 加可选 `modelOverride?`（来源 = RoleBinding.modelOverride） | 现有代码不设 → undefined → JSON 序列化省略 → 与今天一致 |
| `src/core/worker-pool.ts` | fork init(:777) + adopt init(:1535) 填 `modelOverrides: ds.session.modelOverride` | session.modelOverride 缺省 undefined → init 字段 undefined → 逐字节一致 |
| `src/worker.ts` | buildArgs 调用点(:2702) 传 `model: cfg.modelOverrides?.model`、`reasoningEffort` | cfg.modelOverrides 缺省 undefined → 传 undefined → adapter 不加参数 |
| `src/adapters/cli/types.ts` | `buildArgs` opts 加可选 `model?/reasoningEffort?`；加能力矩阵 `supportsModelOverride?/supportsReasoningEffort?`（§6.2） | 纯加 optional 字段 + readonly 标记 |
| `src/adapters/cli/claude-code.ts` | `if (model) args.push('--model', model)` + `supportsModelOverride: true` | model 缺省 → 不加 --model → 逐字节一致 |
| `src/adapters/cli/codex.ts` | `if (model) -c model="…"`、`if (reasoningEffort) -c model_reasoning_effort="…"` + 能力矩阵 true | 缺省 → 不加 -c → 逐字节一致 |

## §6.1 链路（已贯通）

`RoleBinding.modelOverride → Session.modelOverride → DaemonToWorker.init.modelOverrides`（worker-pool fork/adopt 两发送端）`→ worker 读 cfg.modelOverrides → adapter.buildArgs(model/reasoningEffort) → CLI 参数`。restart/adopt 后从 session 读回（modelOverride 落 DaemonSession.session）。

## §6.2 能力矩阵

`CliAdapter.supportsModelOverride / supportsReasoningEffort`：claude-code（model ✓）、codex（model + reasoningEffort ✓）；其它 adapter 缺省=不支持（绑定阶段据此校验，避免给不支持的引擎绑 override——绑定校验接线点在 taskteam bind/onboard，后续）。

## §6.3 逐字节回归断言（红线兜底）

`test/taskteam-model-passthrough.test.ts`：
- claude-code：不传 model → buildArgs 与基线**逐字节一致**、无 `--model`；传 model → 从输出去掉 `[--model, m]` 后**完全等于基线**（无其它漂移）。
- codex：不传 → 与基线一致、无 `-c model=`；传 → 去掉两组 `-c` override 后等于基线；能力矩阵 true。
- 证明：subtask / 普通会话 / workflow（不设 modelOverride）的 init + buildArgs 命令行与改动前**完全一致**（inert）。

## 红线#1 自检

- 触碰共享 worker 层 = §6 sanctioned 唯一例外；**全部纯新增可选字段 + 逐字节回归断言兜底**。
- **未改** `subtask-store.ts` / 任何 `subtask-*` / `subtasks.json`；未改任何 subtask 业务逻辑分支。
- one-shot(`workflows/daemon-spawn.ts`) / resume(`workflows/attempt-resume.ts`) init 发送端不填 modelOverride（保持 undefined，inert）——这两条是 workflow 路径、本批不需要源。

## 验证命令

- `pnpm vitest run test/taskteam-*.test.ts` → 66/66（+批4 模型透传 2）。
- `pnpm tsc --noEmit` → exit 0（共享 types 改动全项目编译）。
- `git diff --check` → 通过。

## 待 review 标注

1. **inert 是本批生命线**：请重点核「不设 modelOverride 时逐字节不变」——回归断言已覆盖 claude-code/codex；其它 adapter 不读 model 字段（天然 inert）。
2. Session.modelOverride 的**写入源**（taskteam RoleBinding → session）接线点在运行时/绑定阶段，本批提供字段 + 透传链路 + 能力矩阵；§6.0 引擎绑定杠杆（绑便宜 bot）无需本批、已随绑定生效。
3. codex 用 `-c key="value"` 配置覆盖（对 fresh/resume 子命令都稳）；如需改 `-m` 直传可在 review 调整。

## 下一步

待批4 **单独严格 CEO 关** 后，只剩批9（Workflow 撤销，独立分支 + commit + review + CEO 二次确认）。

# 任务小组 阶段二 · 批5 CLI 族 + IPC + 导入导出 + open_id scope — 验证记录

目标：按 v3.1 §5 落地 CLI 命令族 + daemon IPC 薄壳 + template/instance 导入导出（H3 分享边界）+ open_id scope 校验（H2）。

> 批次顺序调整：CEO 已把批4（worker 协议透传）挪到最后，本批为批5。批5–8（旁挂批）两层 review 过后可攒一起交 CEO。

## 交付物（全新增 / additive，不 import subtask-store、不碰 subtask）

- `src/services/taskteam-templates.ts` — `TaskTeamTemplateBundle`（可分享、无 app 身份）↔ `TaskTeamInstanceSnapshot`（同环境含运行态）。export/import bundle + snapshot + 形态校验；**导出/导入均断言无 app-scoped 运行态身份**（chatId/botOpenId/larkAppId/companyId/binding 等，H3 防泄漏）。纯函数。
- `src/services/taskteam-scope.ts` — open_id scope 校验（H2）：`validateCreatorAppScope` / `assertCreatorAppScope`，注入 resolver，跨 app（99992361 隐患）fail-fast。纯函数。
- `src/services/taskteam-admin.ts` — 管理面服务层：配置 CRUD（role/rule/type/org upsert，复用批1 config-store）+ template/instance 导入导出（编排 templates）。
- `src/cli/taskteam-cli.ts` — CLI 命令族（纯 IPC 客户端，复用 subtask-orch 的 `findClaudeDaemonPort`，POST 到 daemon /api/taskteam-*）。
- `src/services/taskteam-store.ts` 追加 `replaceTaskTeams`（snapshot 恢复用，纯新增）。
- `src/daemon.ts` 追加 9 条管理面 IPC 路由（`TASKTEAM_ADMIN_ROUTES` 循环，纯 additive、与 subtask IPC 独立）。
- `src/cli.ts` 追加 `taskteam-*` case 块（纯新增、与 subtask 分支独立）。

## §5 落地

- **CLI 族**：`taskteam-{config-list, role-upsert, rule-upsert, type-upsert, org-upsert, template-export, template-import, snapshot-export, snapshot-restore, create, event}`，结构化负载走 `--json` / `--file`。
- **IPC 薄壳**：CLI → daemon `/api/taskteam-*` → `taskteam-admin` 服务 → 批1 store。
- **分享边界（§5.1 / H3）**：TemplateBundle 只含 `roles/rules/teamTypes/orgStructures(shape)`，**绝不含运行态身份**；导入只合入可分享 shape，`orgRuntimeBindings` 保持本地不变，返回 `rebindRequired: true` 提醒调用方重选 creator app + 重绑 bot。InstanceSnapshot 才含运行态，仅同环境备份。
- **open_id scope（§5.2 / H2）**：`assertCreatorAppScope` 供 create/onboard 在建群前 fail-fast，避免把 99992361 留到运行时。

## 单测（10 例）

- `taskteam-templates.test.ts`（7）：导出只含可分享态、不含运行态身份；导出/导入断言拒绝混入 app 身份；导入 upsert 不动运行态绑定；拒绝错 kind/version；snapshot 保留运行态 + 形态校验；scope 通过/跨 app 命中 + assert 抛错。
- `taskteam-admin.test.ts`（3）：配置 CRUD upsert 反映到 config-list；template export→import 往返（rebindRequired、无运行态绑定）；snapshot export→restore 往返。

## 红线#1 自检

- 未改 `subtask-store.ts` / 任何 `subtask-*` / `subtasks.json`；新文件不 import subtask-store。
- daemon.ts / cli.ts 改动均为**纯新增**（taskteam 管理面 IPC 路由循环 + taskteam-* CLI case 块），零改 subtask 分支。

## 验证命令

- `pnpm vitest run test/taskteam-{stores,engine,runtime,dispatcher,templates,admin}.test.ts` → 40/40。
- `pnpm tsc --noEmit` → exit 0。
- `git diff --check` → 通过。

## 两层 review 裁决与整改

**架构 review：通过 ✓ 无 P1**——H3 分享边界"优秀"（assertNoRuntimeIdentity 深扫、闭环验证批1 A1）；H2 primitive 接受、wiring 作延后跟踪项；红线#1 亲核 daemon +29/0、cli +16/0 纯 additive。

**细节 review（docx `FTeIdFi06oLSCJxGgVhcSl9YnIb`）：P1+P2，已整改**

| 项 | 内容 | 处理 |
|-|-|-|
| **P1** | CLI help 发裸对象，但 admin/daemon 读 `body.role`/`bundle`/`snapshot`/`event` —— 按 help 用 role/rule/type/org-upsert、template-import、snapshot-restore、event 都不命中服务层 schema（单测只测 admin 直调，覆盖不到 CLI→IPC 断层） | **方案 A：CLI 按 verb 包 envelope**。抽出纯函数 `buildTaskTeamRequest(verb,argv)`：role→{role}、rule→{rule}、type→{teamType}、org→{org}、template-import→{bundle}、snapshot-restore→{snapshot}、event→{teamId,event}、create→裸 body。新增 `taskteam-cli.test.ts`（6）覆盖每类命令的 CLI→IPC body 合约。 |
| **P2** | IPC/admin 缺 shape 校验，错误 payload 落 500 而非 400 | admin 增 `TaskTeamBadRequestError` + requireObject/requireId 校验；daemon IPC route 把 `TaskTeamBadRequestError`/`TaskTeamTemplateError`/`TaskTeamScopeError` 映射 400（区别服务端 500）。新增单测：缺 role/bundle/snapshot → BadRequest。 |
| M1（架构 minor） | assertNoRuntimeIdentity 用黑名单，未来 schema 新增身份字段可能漏 | 记录在案：当前黑名单覆盖已知 app-scoped 字段；改白名单（仅放行已知可分享键）更强但维护成本高（每个 schema 字段需登记）。本批保留黑名单 + 本注记，作后续优化项，不阻断。 |

整改后复验：`vitest` 47/47（批1 5 + 批2 10 + 批3 15 + 批5 17）；`tsc --noEmit` exit 0；`git diff --check` 通过；红线#1 未破。

## 待 review 标注（保留）

- open_id scope 的真实 resolver（通讯录可见性查询）属 create/onboard 接线点；本批提供纯校验 + 注入接口，create 流程接 resolver 的接线随建群路径细化（H2 延后 wiring，架构已认可）。

## 下一步

批5 旁挂，可与批6（Dashboard Tab）攒一起两层 review 后交 CEO。

# 任务小组框架阶段二批 1 验证记录

目标：按 v3.1 方案第 2 节和第 11 节落地纯数据层，新增三个 taskteam store、schema、seed 和单测。

范围：
- 新增 `src/services/taskteam-schema.ts`，覆盖 role/slot/rule/type/org/runtime binding/roleInstance/binding/instance/action schema。
- 新增 `src/services/taskteam-config-store.ts`，落盘 `taskteam-config.json`，含默认两层 review seed。
- 新增 `src/services/taskteam-store.ts`，落盘 `taskteams.json`，以 `roleInstanceId` 记录 review vote。
- 新增 `src/services/taskteam-outbox-store.ts`，落盘 `taskteam-outbox.json`，含 pending/claimed/sent/acked/failed 与 lease 字段。
- 新增 `test/taskteam-stores.test.ts`，覆盖 seed、instance、outbox lease/idempotency、corrupt backup。

红线自检：
- 未修改 `src/services/subtask-store.ts`。
- 未修改任何 `subtask-*` 文件。
- 未复用或 import `subtask-store`；只复用通用 `withFileLock`。
- 本批未触碰 daemon、worker、CLI、Dashboard、部署或运行时进程。

验证命令：
- `pnpm vitest run test/taskteam-stores.test.ts`：通过，1 file / 4 tests。
- `pnpm tsc --noEmit`：通过。
- `git diff --check`：通过。

环境记录：
- shared worktree 已 rebase 到 `origin/master`。
- 本 worktree 原先没有 `node_modules`，已执行 `pnpm install --frozen-lockfile`，未改 lockfile。

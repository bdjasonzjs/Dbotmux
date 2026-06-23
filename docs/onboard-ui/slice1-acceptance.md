# 新手引导 · 第一刀实现验收（第一段「配模板向导」，全程零 bot）

> 范围：设计 v5「第一段 · 配模板向导」（= 第一刀）。worktree `~/work/Dbotmux_wt/onboard-ui`（feat/onboard-ui，base=master）。
> 两段分开（松松 2026-06-22 纠正）：**第一段=配模板（纯模板、零 bot，本刀）**；第二段=用模板建真群（挑 bot/建实例/拉用户进群，下一刀）。
> 边界遵守：只停 working tree（未 commit / 未部署 / 未重启 botmux / 未碰编译配置）。

## 做了什么（都按 v4，不重写配置逻辑）

1. **入口卡**：任务小组 Tab 顶部一张醒目卡「✨ 第一次用？跟着引导建一个工作小组」→ 点进向导。（`task-team.ts`）
2. **向导骨架**：步骤条（起名/加成员/连谁审谁/存好）+ 上一步/下一步 + 右侧**只读 mini 画布预览**（实时画出流程图，和完整画布同一套数据）。（新文件 `task-team-onboarding.ts`）
3. **前三步配置**（纯复用 `taskteam-canvas-data`）：
   - 起名：小组名 + 自动派生 typeId。
   - 加成员：大白话挑角色（干活的/把关的/汇报的/盯梢的）+「一键加一套推荐」；可设名字、模型（盯梢的提示用便宜模型）。复用 `kindDefaults`。
   - 连谁审谁：「✨ 智能连好」自动连一套合法流程（提交→请审、通过→汇报、驳回→返工）+ 手动加/删；实时 `validateCanvas` 校验 + `deriveReviewOrder` 显示审批顺序。
4. **dashboard 写代理**（设计 v4 §3.1，`dashboard.ts`）：新增 `POST /api/taskteam-{role,rule,type}-upsert` 代理到在线 daemon 执行（config 是共享文件）；新增 `GET /api/taskteam-config-list` 读兼容（返 `readTaskTeamConfig`，画布数据层 `loadExistingRoles` 复用不再 404）。
5. **落库小组类型**：复用 `assembleSaveOps` → 写代理。逃生口「切到完整画布」保留。

## 验收证据（不靠"看着对"）

### A. 构建通过
`pnpm build`（tsc + esbuild bundle）全绿，无类型错误；bundle 产物 `dist/dashboard-web/app.js`。

### B. UI 端到端（真实浏览器 Playwright 驱动真 bundle，7 张截图）
目录：`docs/onboard-ui/shots/`
- `00-entry-card.png` — 任务小组 Tab 的引导入口卡
- `01-step-name-empty.png` / `02-step-name-filled.png` — 起名步
- `03-step-members.png` — 加成员（一键推荐：干活+把关+盯梢）
- `04-step-connect-auto.png` — 连谁审谁（智能连好，3 条关系 + 审批顺序 + mini 画布预览）
- `05-step-save-ready.png` — 存好步（校验通过）
- `06-step-save-done.png` — 落库成功「✓ 已存好工作小组『代码评审小组』（共 7 项）」（全程零 bot，产出 bot-agnostic 模板）

### C. 落库 payload 正确（Playwright 拦截 存好 的真实请求）
点「存好」实际发出 7 条：3× role-upsert（干活的/把关的/盯梢的）+ 3× rule-upsert（submit-review / pass-report / reject-rework）+ 1× type-upsert。
type-upsert 的 roleSlots = 3 席、reviewOrder = [把关的]，与画布派生一致。

### D. 真实落库 round-trip（隔离 SESSION_DATA_DIR，跑真后端服务）
`assembleSaveOps` → 真 `adminUpsertRole/Rule/Type` → `readTaskTeamConfig`（即 `/api/taskteam-config-list` 的数据源）：
**新类型可查到** → `teamTypes=1, roles=3, rules=3, name=代码评审小组, slots=3, rules=3, reviewOrder=[tt_slot_rev]` → `PERSIST_ROUNDTRIP_PASS`。
即"从网页一步步配出 → 存好 → config-list 查得到新类型"闭环成立。

## 范围与后续

- 本切片**不含**（按设计 v5 属第二段）：挑 bot 填角色、建实例（含拉用户进群）、当场跑一遍——下一刀做。
- （中文名 typeId 兜底撞名的问题已在复审修订 P1-1 修掉，见下方。）

## 边界自查
未 commit、未 push、未部署、未重启 botmux、未碰编译/构建配置。验证用的 SESSION_DATA_DIR 为隔离临时目录，未触碰生产数据。

---

## 复审修订（寇黛克斯第一刀复审 2 P1 + 1 P2，已全改）

- **P1-1 中文默认名生成重复 roleId/slotId→跨模板覆盖全局 role/rule**：已修。roleId/slotId 改为带每次向导会话稳定唯一前缀 `sid`：`tt_role_${sid}_${kind}` / `tt_slot_${sid}_${kind}`（中文名只做展示 label，不进 id）；typeId 中文兜底/撞名时加 sid。
  - 验证（隔离 SESSION_DATA_DIR 跑真后端）：连续建两个中文命名模板（代码评审小组 / 调研小队）→ `teamTypes=2, roles=6, rules=6`，A 的 roleSlots 仍解析到 A 自己的 role、未被 B 覆盖 → `NO_CLOBBER_PASS`。
- **P1-2 保存成功文案把"bot 盘点"带回配模板阶段**：已改。文案改为「这是一个可复用的模板（不含机器人）。下一步（第二段·单独入口）：用它建一个真群——挑机器人填进角色、把你拉进群，就能开工」；本文档"下一刀"措辞统一改为"第二段"。第一段内不再出现 bot 盘点/补 bot 字样。
- **P2 成员名/模型输入不实时刷新右侧预览**：已修。input 时做局部重绘（只更新右侧预览区、不动左侧输入框、保持焦点）。

`pnpm build` 重新通过；截图已用修订后 bundle 重跑；新 id 方案在落库 payload 中体现（roleId=tt_role_<sid>_<kind>、typeId=tt_type_<sid>）。

# botmux

飞书话题群 ↔ AI 编程 CLI 桥接。Daemon 监听飞书消息，每个新话题自动 spawn 一个独立 CLI 进程（Claude Code / Codex / Gemini 等 20+ 种，完整列表见 README）。

## 构建 & 运行

```bash
pnpm build                # tsc 编译
pnpm daemon:restart       # 重启 daemon（自动恢复 active sessions）
pnpm daemon:logs          # 查看日志
```

- 每次修改后需要 `pnpm build` 然后 `pnpm daemon:restart`

### 多 checkout：全局 `botmux` 指向谁

全局 `botmux` 命令走 `~/.botmux/bin/botmux` 瘦 wrapper，指向「最后认领的 checkout」的 `dist/cli.js`（daemon 启动时也会写）：

```bash
pnpm use:here             # 把全局 botmux 指向当前 checkout（仅改指向，不重启 daemon）
pnpm switch:here          # = build + use:here 一步到位
BOTMUX_NO_CLAIM=1 pnpm use:here   # 逃生阀：本次不认领
```

纯 `pnpm build` 故意不认领——review/验证别人 PR 时不会悄悄抢走全局指向。实现见 `scripts/claim-botmux-bin.mjs`。

### 改动需用户手动测试时 → 部署本 checkout 到 live daemon

当改动需要用户在飞书里**手动验证**（而非纯单测能覆盖），改完自测绿后执行：

```bash
pnpm switch:here && pnpm daemon:restart
```

这里故意用 `pnpm daemon:restart`，确保从当前 checkout 的 `dist/cli.js` 重启；不要依赖裸 `botmux restart`，它可能被 PATH 中更靠前的 npm 全局安装抢先。否则用户测的还是旧代码（典型症状：新加的命令/配置「找不到」）。⚠️ 这会让**所有 bot** 都跑本 checkout 的 build；测试/合并完成后记得切回 canonical checkout，以免 review worktree 被删后全局 shim 失效。

## 模块结构

- `daemon.ts` — 薄编排层，组装各模块并启动
- `worker.ts` — Worker 子进程，通过适配器管理 CLI + PTY
- `server.ts` — Web 终端 HTTP 服务（xterm.js）
- `bot-registry.ts` — 多机器人配置加载 + 状态管理
- `config.ts` — 全局配置
- `adapters/cli/` — CLI 适配器，每种 CLI 一个文件（新增适配器的完整步骤见 `src/adapters/cli/CLAUDE.md`）
- `adapters/backend/` — 会话后端：`PtyBackend`、`TmuxBackend`
- `skills/` — 开箱即用的 Skill 定义 + installer
- `core/types.ts` — `DaemonSession` 是核心类型，所有模块从此导入
- `core/` — `worker-pool`、`command-handler`、`session-manager`、`cost-calculator`、`scheduler`
- `im/lark/` — 飞书：事件路由（`event-dispatcher`）、卡片（`card-builder`/`card-handler`）、API（`client`）、消息解析（`message-parser`）
- `utils/` — `idle-detector`（CLI 空闲检测）、`terminal-renderer`（xterm.js 截屏）、`logger`

## 飞书 owner 身份边界（setup/onboarding 改动必读）

这里曾发生过一次路径回归：Dashboard onboarding 已经防住跨应用复制 owner，后来新增的 scripted `setup add --create-app` 只做格式校验，又绕过了同一条身份边界。以后新增或修改创建 Bot 的入口时，必须遵守以下不变量：

- `ou_`（`open_id`）是 **app-scoped**：只对签发/观察它的飞书应用有效，绝不能从来源 Bot 复制到另一个 Bot。`BOTMUX_OWNER_OPEN_ID` 也只是 `BOTMUX_LARK_APP_ID` 视角下的 session owner，不是当前 turn 的发送者，更不是可跨应用复用的 owner 配置。
- 跨应用/新建应用的 owner 优先使用完整邮箱、手机号或 `on_`（`union_id`；仍需满足同租户/开发者条件）。新应用创建前，只能通过来源应用转换 daemon 已认证的当前 owner；任意其它 `ou_` 必须在创建应用前拒绝。
- Dashboard onboarding、交互式 setup、scripted `setup add` 以及后续任何新增入口，都必须复用 `src/setup/owner-identity.ts`，不要只校验格式后直接写 `allowedUsers`。在创建应用前归一化来源 owner，在写 `bots.json` 前用目标应用校验；暂时性网络/scope 错误保持 inconclusive，目标应用明确判定不可用时 fail closed。
- `BOTMUX_OWNER_OPEN_ID` / `__OWNER_OPEN_ID` 是 daemon 认证的 session 身份。新增 backend / runner / RPC 子进程时，必须通过 `applySessionOwnerEnv` 在可配置 env 合并完成后注入并冻结，不能让 bot/backend 配置覆盖它；ownerless session 必须同时删除两个变量。
- 回归测试必须覆盖 managed-Agent 场景（source app 的 `BOTMUX_OWNER_OPEN_ID=ou_*` 创建 target app），并验证真人 owner 在目标 Bot 下的 `canOperate`；Bot-to-Bot 消息通、权限 scope 通或参数格式合法，都不能证明 owner 身份正确。

## 影响范围评估（改前必做）

任何改动落地前，先想清楚它波及的**其它平台、其它 CLI、其它会话类型**——本仓库是多 CLI × 多后端 × 多 IM 的横向架构，一处改动很容易踩到共用代码路径。默认「牵一发动全身」，主动排查回归面，别只测自己那条路。

- **跨平台**：改了 macOS 相关逻辑要同时考虑 Linux（daemon 实际跑在 Linux）；涉及路径、shell、进程、PTY、编码的代码尤其要两边都想到
- **跨 CLI**：改某个 CLI 适配器时，确认没动到 `adapters/cli/` 的共用基类/工具（`shared-hints`、`runner-input`、`registry` 等）或 worker 侧共用逻辑，否则可能连带影响其它 20+ 个 CLI。共用改动要在至少一个「别的 CLI」上验证仍可用
- **跨后端 / 跨会话类型**：改动涉及 `PtyBackend` vs `TmuxBackend`、话题会话 vs 群会话 vs adopt/restore、sandbox on vs off、v3 workflow vs 普通会话时，逐一核对受影响的组合
- **改公共层**（`core/`、`config.ts`、`bot-registry.ts`、`im/lark/`）时影响面最大——PR 描述里写清评估结论：动了什么共用路径、哪些平台/CLI/会话类型受影响、各自怎么验证的

## PR 规范

- 标题与 commit message 同格式：`type(scope): 中文描述`
- 描述用**中文说明**：改了什么、为什么、影响面（涉及哪些模块/会话类型）
- 附**实际测试验证**：贴出跑过的命令和关键结果（`pnpm build`、`pnpm test`、相关 e2e），不要只写「应该没问题」；需要 live 验证的先 `pnpm switch:here && pnpm daemon:restart` 在飞书里实测并注明结果
- UI 类改动（飞书卡片 / dashboard / web 终端）附**截图示意**，让 reviewer 不用跑代码就能看到效果
- **不写飞书群内真人名字，也不写机器人协作花名/内部 review 编排**：commit message 与 PR 标题/描述进的是**公开 git 历史**，读者不需要知道群里谁参与、谁审的。① 不出现群成员真名——验证描述用中性客观表述（如「矮视口下成员/机器人行都能滚动可见」，而不是「某某/某某两行成员」）；② 不出现 `@Codex`、`Codex 复审`、`双审`、`首审`、`双审收敛` 这类多 bot 协作花名，验证只陈述**做了什么验证、结果如何**的客观事实，不写「谁审的」。（`Co-authored-by` git 署名 trailer 属正常署名规范，不在此列。）

## Git 提交 & 发版规范

- **日常提交**：正常 `git commit` + `git push`，不会触发发版
- **发版**：打 `v*` tag 并 push 即可，GitHub Action 自动从 tag 提取版本号写入 `package.json` 后发布 npm + 创建 GitHub Release
- **不要**手动修改 `package.json` 的 `version` 字段来发版，CI 会自动处理
- commit message 格式：`type(scope): 中文描述`。`type`（feat/fix/docs/chore 等）和 `scope`（模块名）保留英文，冒号后的描述用中文；同样不带飞书真人名字与机器人协作花名（见上「PR 规范」）
- 发版的 annotated tag message 用中文撰写，CI 会把 tag message 作为 GitHub Release body
- **正式版（latest）必须从 master 出**：CI 校验被打 tag 的 commit 含最新 `origin/master`。非 master 分支灰度使用带后缀的 prerelease tag。

### dist-tag 路由（CI 自动判断，不用手动指定）

| tag 格式 | npm dist-tag | GitHub prerelease | 用途 |
| --- | --- | --- | --- |
| `v1.2.3` | `latest` | 否 | 正式发版，默认安装 |
| `v1.2.3-canary.N` | `canary` | 是 | 内测、灰度验证；`npm i botmux@canary` |
| `v1.2.3-beta.N` | `beta` | 是 | beta 预览 |
| `v1.2.3-rc.N` | `rc` | 是 | 发版候选 |
| 其它带 `-` 后缀 | `next` | 是 | 兜底，不污染 latest |

**canary 不会覆盖 latest**，stable 用户依旧拿 stable。要验证 canary：`npm i -g botmux@canary` 或 `npx botmux@canary`。

```bash
# 日常开发
git add <files> && git commit -m "fix(cli): 修复某某问题" && git push

# 正式发版（仅在用户明确要求时执行）
git tag -a v1.x.x -m "中文 changelog 标题

详细改动说明..."
git push origin v1.x.x

# Canary 发版（基于待发正式版号，递增 .N）
git tag -a v1.x.x-canary.0 -m "canary: 加诊断日志排查截图卡死

详细改动说明..."
git push origin v1.x.x-canary.0
```

## 缇蕾 owner-profile（v1.1「感受」静态层）

缇蕾秘书的「老板简介」由 `~/.botmux/data/owner-profile.json` 加载（**不是 repo 里的 data/**），分静态层 + 动态层注入 LLM prompt:

- 静态层（手维护）: `~/.botmux/data/owner-profile.json` — `owner.{name, open_id, responsibilities.{business, technical}}`
- 动态层（每次 tick 实时抽）: main-bot-digest 的 hot chats top 10 + 今日 cumulative digest (MEMORY_TODAY)

**部署/新机器**: 把 repo 里的 `examples/owner-profile.sample.json` 复制到 `~/.botmux/data/owner-profile.json` 改填本机 owner。缺失或解析失败会走**保守 fallback**（除非 @ 老板或明确等他决策一律 drop）并打 logger.error。

## 添加新 CLI 适配器

1. `src/adapters/cli/` 下创建新文件，实现 `CliAdapter` 接口
2. `src/adapters/cli/types.ts` 的 `CliId` 联合类型中添加新 ID
3. `src/adapters/cli/registry.ts` 添加 import、switch case、export
4. `src/worker.ts` 的 `CLI_DISPLAY_NAMES` 添加显示名
5. `src/im/lark/card-builder.ts` 的 `cliDisplayNames` 添加显示名
6. `src/cli.ts` 的 setup 交互菜单添加选项
7. `README.md`、`README.en.md` 更新 CLI 列表

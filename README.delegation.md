# 多级委派：第一次安装和三级回报

目标：在一个新的工作目录中，把根群的任务逐跳发到中间群、叶群，再把叶群的结果逐跳收回根群。`init` 只安装，不会替机器人接单，不会启动后台服务。

## 准备一次

- Node.js >= 22、Python >= 3.9、Bash；当前运行时使用 POSIX 文件锁，Windows 请用 WSL。
- botmux 已完成 `setup`，执行者和 observer 两个不同的 bot 可用。reviewer 可以与 observer 共用 app，不能替执行者产生结果。
- `lark-cli` 已安装，且你的 profile 具有读取群成员/消息和发送消息的权限，用户登录有效。先运行 `lark-cli auth status --profile <profile> --json --verify`。
- 三个群里都有你、执行者和 observer。可以复用现有群。新建群走 botmux 的建群入口，不直接调 API：

```bash
botmux create-group --bot "$EXECUTOR_APP" --bot "$OBSERVER_APP" --bot "$REVIEWER_APP" --name "委派示例·根" --working-dir "$PWD"
```

把返回的群 ID 保存下来，分别建立中间群、叶群。在三个群中各发一条消息给执行者，建立正常的 botmux 会话；记录三个 session ID。首次运行由这些会话中的执行者分别操作，不能用根会话代写子节点接单。后续 `node` 会回读成员，不把创建参数当入群证明，也不会重新邀请已退出的人。

在根群发送真实任务请求，正文要包括你选择的任务名，例如“请沿三级群处理 demo-task：叶群检查工作目录可写，回报结果”。记录这条请求的 `om_` 消息 ID。**不要使用会话卡 ID 代替请求。**

准备 `actors.json`，填写你自己的 app/profile 视角，不能复制别人的 open_id：

```json
{
  "profile": "my-executor-profile",
  "app_id": "cli_EXECUTOR",
  "owner_open_id": "ou_OWNER_IN_THIS_PROFILE",
  "executor_open_id": "ou_EXECUTOR_IN_THIS_PROFILE",
  "observer_app_id": "cli_OBSERVER",
  "reviewer_app_id": "cli_REVIEWER"
}
```

`botmux bots list` 可查看 app ID、当前视角的 bot open ID。owner ID 来自上述 profile 的 `auth status --verify`。该文件只有身份映射，不需要 app secret 或 token。示例中三个节点使用同一执行者 app；每个节点仍有自己的会话、任务绑定和回执。

## 一条初始化命令

安装含本功能的 botmux 发布包后，在空工作目录中执行：

```bash
botmux delegation init --root "$REQUEST_MID" --task "$TASK" --path "$ROOT_CHAT,$MID_CHAT,$LEAF_CHAT" --actors ./actors.json
```

默认安装到当前目录的 `.botmux-delegation/`。也可以增加 `--home /absolute/path`。缺参数或 actors 字段会明确报错；非空目标不会被覆盖。资源随 botmux 包分发，不依赖原开发者的工作目录。安装结果包括 25 个 P5 脚本、reader 辅助模块、状态目录和 `p5-config.json`。

尚未发布时，在**已合入 master 的源码**里 `pnpm install --frozen-lockfile && pnpm build && pnpm pack`，把生成的 tgz 交给使用者。在新目录本地安装，不改系统全局 botmux：

```bash
npm install --prefix ./tools /absolute/path/to/botmux-0.0.0.tgz
./tools/node_modules/.bin/botmux delegation init --root "$REQUEST_MID" --task "$TASK" --path "$ROOT_CHAT,$MID_CHAT,$LEAF_CHAT" --actors ./actors.json
```

下文 `botmux` 可替换成上述绝对路径。源码分支隔离测试不是部署；实际使用先合入 master，再构建部署。

三个节点当前共用一台机器上的同一份安装目录；在各自会话中设置 `P5_HOME` 为 `init` 打印的绝对路径，或每条命令加 `--home`。不要在三个不同的当前目录里各自初始化孤立的状态。`run` 的目录参数放在入口名之前，例如 `botmux delegation run --home /absolute/path event status ...`。调用链内的 `quoted/send` 使用同一个已安装 botmux，不依赖系统另一个版本。

## 初始化第一个节点

```bash
botmux delegation doctor
botmux delegation node --chat "$ROOT_CHAT"
botmux delegation node --chat "$MID_CHAT"
botmux delegation node --chat "$LEAF_CHAT"
botmux delegation status
```

按根→中间→叶执行。`node` 回读已有群的成员和本机唤醒配置，然后初始化空节点；它不发送任务、不开 cron/instant、不合成 accepted。失败时保留错误，不创建另一组群重试。

登记根任务（示例初始任务版本为 1）：

```bash
botmux delegation run binding intake-root "$ROOT_CHAT" "$REQUEST_MID" "$TASK" 1 "$REQUEST_MID"
```

`intake-root` 真读请求正文和发件人；如果范围说明与确认是两条消息，最后一个参数填写同话题中更早的范围消息 ID。没有合法根请求就停在这里，不补写假 binding。

## 根节点接单，向中间节点派单

以下在根节点执行者自己的会话中操作。先读请求，再发送真实接单正文：

```bash
botmux send --session-id "$ROOT_SESSION" --no-mention "accepted root=$REQUEST_MID task=$TASK task_version=1 delivery_message_id=$REQUEST_MID；开始检查并逐跳派单。"
```

保存返回的实际 `ACCEPT_MID`。`botmux quoted "$ACCEPT_MID" --session-id "$ROOT_SESSION"` 真读正文，从 `createTime` 取得事件时间，转成东八区 `YYYY-MM-DD HH:MM:SS`。然后：

```bash
botmux delegation run event emit "$ROOT_CHAT" "$REQUEST_MID" "$TASK" 1 1 accepted "$ACCEPT_TIME" "$ACCEPT_MID"
```

命令返回 `applied=true` 才是本节点真实接单落账。接着编写 `root-taskbook.md`；`created` 使用**实际建条时间**，不能晚于之后的准备回执：

```text
# demo-task
- node READY kind=worker role=worker created=YYYY-MM-DD HH:MM next=oc_MIDDLE:demo-task
```

把任务名、中间群 ID、时间替换成实际值。发布任务书、完成准备后发送准备回执：

```bash
botmux delegation run taskbook "$ROOT_CHAT" "$PWD/root-taskbook.md"
botmux delegation run marker READY 1 worker done
```

第一条输出 `sha/gen/announce`；第二条只打印 marker，不发送。由根执行者确认准备确实完成后，把 marker **原样**用 `botmux send` 发在根群，记录 `BASIS_MID`。不要手写 Base64。

创建 `basis.json`，填写真实值：

```json
{"kind":"bot_message","ref":"om_BASIS","node":"READY","round":1,"role":"worker","verdict":"done","taskbook_sha":"SHA_FROM_TASKBOOK","taskbook_gen":1}
```

创建 `delivery.txt`，包含真实 root、task、`task_version=1`、工作内容、完成条件与逐级回报路径。不要把根任务删减成一句“开工”。标准派单入口会重新验证任务书、准备依据、版本和父子关系：

```bash
botmux delegation dispatch --from "$ROOT_CHAT" --to "$MID_CHAT" --basis ./basis.json --body ./delivery.txt
```

保留实际 `decision_id` 和 `sent_message_id`。超时或非零时先 `status` 检查已产生的记录，**不要重新 propose**；已创建 decision 可用 `delegation run decision dispatch <父群> <decision_id>` 续办同一条。

## 中间节点接单，再向叶节点派单

中间执行者真读上一步投递，执行：

```bash
botmux delegation run binding bind "$MID_CHAT" "$REQUEST_MID" "$TASK" 1 "$ROOT_DELIVERY_MID"
```

在中间自己的 session 发真实 accepted，正文必须包含本跳 `ROOT_DELIVERY_MID`；按上面的步骤 `event emit`，仍是本节点的版本 `1/1`。然后中间发布自己的任务书（`next` 指叶群）、自己的 READY 回执、自己的 `basis.json`，再：

```bash
botmux delegation dispatch --from "$MID_CHAT" --to "$LEAF_CHAT" --basis ./middle-basis.json --body ./leaf-delivery.txt
```

叶执行者同样先 `binding bind`，再真读/真接单/`event emit`。不要复用根的依据或接单消息。

## 叶结果向上回报一次

叶执行者完成实际工作后，用标准编码器生成本节点第二个事件源：

```bash
botmux delegation source --chat "$LEAF_CHAT" --type result_pending_review --event-version 2
```

它只打印 marker。将真实结果说明、root/task 和该 marker 发在叶群，取得 `RESULT_MID` 和真实消息时间 `RESULT_TIME`：

```bash
botmux delegation run event emit "$LEAF_CHAT" "$REQUEST_MID" "$TASK" 1 2 result_pending_review "$RESULT_TIME" "$RESULT_MID"
botmux delegation run event flush "$LEAF_CHAT"
botmux delegation run event ingest "$MID_CHAT"
botmux delegation run event flush "$MID_CHAT"
botmux delegation run event ingest "$ROOT_CHAT"
botmux delegation status
```

每条命令由对应节点的会话执行，环境 `BOTMUX_SESSION_ID/BOTMUX_LARK_APP_ID` 使用该会话实际值。首次教程是**显式调用入口**，不是自动轮末验收。发送成功只算 `sent_unconfirmed`；父 `ingest` 验证真实消息并落账后才确认。

通过标准：根→中间、中间→叶两次真实投递均有新接单；叶的同一 `RESULT_MID/event_id` 在叶、中间、根的分支状态都为 `pending_review`，每条上行消息可 quoted 下钻。**待审不等于 review PASS，更不等于整个项目完成。**

## 消息已送达但缺少 mention 的旧回执对账

仅用于旧出站缺陷留下的 `sending`：错误中已经记录了真实发送 MID，接收方也已回读该消息并明确确认接收。不要重新发送，也不要手改状态。

原发送节点先备份安装目录，真读接收方确认正文，记录其正文 UTF-8 字节 SHA-256。将原事件完整对象的 canonical SHA-256 与两个真实 MID 交给显式入口：

```bash
botmux delegation run event reconcile-sent "$SOURCE_CHAT" "$EVENT_ID" "$EVENT_SHA256" "$SENT_MID" "$RECEIVER_CONFIRM_MID" "$CONFIRM_BODY_SHA256"
```

入口只认原失败发送对应的消息、发送者、父群与完整正文，以及原接收方的指定确认；不自动把任意自然语言当回执。通过后留下 `receipt_reconciliation` 与 `.sent` 记录，原错误保存在审计字段，原事件和原消息不变。相同参数重复执行不写业务状态、不重复外发。

对账只恢复 `sent`，**不等于父节点已经落账**。随后由原父节点执行 `event ingest`，才能取得 `parent_landed`。未对账的普通无 mention 消息仍走原拒绝路径。

## 停用、复用与边界

`init` 默认 `delegation_auto.enabled=false`、`version_migration.enabled=false`、`mode=dry-run`；不会修改共享 bots.json、服务、cron 或 instant。初次任务的显式派单/回报可运行；版本迁移和自动入口另行配置、按相应命令取得真实证据。

运行目录保留 state、outbox、taskbook、journal 和 installation.json，不要删目录“修复”失败。自动回调若另行启用，可用 `botmux delegation run auto disable` 关闭本安装的自动入口；它不抹历史、不撤销迁移。

测试目录里的模拟 transport 只验证安装包的调用链。它不会联网，产生的 `om_fixture...` 不是真实飞书消息，不能作为上面真实三级验收的证明。

开发者可从源码构建 tgz 后执行 `node scripts/test-delegation-package.mjs /absolute/path/botmux.tgz /absolute/path/new-report.json`：它新建空目录，真正 npm 安装该包，再通过安装后的 CLI 完成上述两次下发、两次结果上报；传输由明确标记的本地夹具替代。报告同时保留命令、退出码、目录、包 SHA 和 `live_lark_verified=false`。脚本不创建飞书群、不触发真实会话、不部署服务。

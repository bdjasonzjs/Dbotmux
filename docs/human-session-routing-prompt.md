# 人类会话路由提示发布闸门

目标：仅在人类会话能力真实可用且入口与指定文案一致后，把固定路由原文加入首轮和后续轮次。此功能默认关闭；本文不代表线上已启用。

## 开关含义

`~/.botmux/config.json` 的 `humanSessionRoutingPrompt` 必须同时满足：

```json
{
  "humanSessionRoutingPrompt": {
    "enabled": true,
    "dependencyReady": true,
    "skillEntry": "人类会话",
    "capabilityEvidence": "<可追溯的发布或真测证据>"
  }
}
```

- 缺失、类型错误或 `enabled !== true`：关闭。
- `enabled=true` 但依赖未就绪：关闭。
- `skillEntry` 不是文案指定的 `人类会话`：关闭并先上报差异，不改指定文案。
- `capabilityEvidence` 缺失/空白：关闭。
- 环境变量 `BOTMUX_HUMAN_SESSION_ROUTING_PROMPT_ENABLED` 是部署侧紧急关闭闸门；合法值为 `true/1/yes/on` 或 `false/0/no/off`，其它值按关闭处理。`false` 可立即关闭；`true` 只确认已经开启的配置，不能开启缺失/关闭的配置，也不能绕过三个依赖条件。

## 启用前核对

1. 人类会话实施叶已提供最终细则版本、可调用的 `人类会话` 入口及可追溯能力证据。
2. 两个方向都创建 `汇报·<具体短标题>` 群。
3. 先判断“直接在当前群回复”豁免，再决定开群。
4. 已有人类会话群里出现新问题时另开群。
5. 隔离 build/test 验证首轮、后续轮次和依赖误开失败情形；上线仍走既有发布流程。

当前依赖工作副本只存在未注册的核心模块，没有可调用技能入口，因此本次不得设置上述开启条件。

## 一键关闭

```bash
botmux config disable-human-session-routing
```

该命令只把 `enabled` 置为 `false`，保留依赖证据用于审计；配置显式关闭优先于环境变量的开启值，后续 prompt 构造即恢复旧行为，不修改消息或会话数据。也可在部署环境使用紧急关闭闸门：

```bash
BOTMUX_HUMAN_SESSION_ROUTING_PROMPT_ENABLED=false
```

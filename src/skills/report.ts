/** One public report entry, backed by the existing room and reply transport. */
export const REPORT_SKILL = `---
name: botmux-report
description: 向用户提问、答复或汇报时使用；每次独立创建汇报群，用户回复自动回原群并圈原 bot。用户明确要求本群回复，或 bot 间沟通，用 botmux send。create-group 只创建工作子群。
---

# botmux-report — 汇报

在原业务会话调用一次，命令自动建汇报群、发正文并回传原群链接。不要自己用 create-group 或 send 拼装汇报；来源身份由运行环境提供。

## 一次调用

准备以下 JSON，通过 \`botmux human-session --input <文件|->\` 发送（CLI，不是另一项技能）：

\`\`\`json
{
  "operation": "report",
  "direction": "assistant_answer",
  "requestId": "report-example-1",
  "title": "导出功能进展",
  "body": "你问导出功能进展：代码和本地测试已完成，尚未部署，线上效果还不能确认。"
}
\`\`\`

title 为 2–30 字，不带“汇报·”。body 一次一件事，带必要背景；可以是提问、答复或进展，不省略重要风险和未知。requestId 每次新汇报取新值（字母、数字、下划线、连字符，最多 80 字符）；同一笔重试保持编号和正文不变。

读取真实返回的 \`result.state\`、\`result.roomId\` 和 \`result.presented.messageId\`。COMPLETED 仅指汇报已送达，不表示用户已回复或业务完成。不要手工重复发正文或链接。

## 用户回复

原话连同这次汇报背景，会以用户身份回原群并真正圈原 bot；用户身份明确不可用才使用唯一配置的回退 bot。按普通消息处理，不需要 claim_event、consume_event 或关闭汇报。要继续答复，再调用一次本技能，创建新的汇报群；旧群的新回复仍回原来源。

## 失败

如实说明失败阶段。结果未知时，用原编号、原正文再次调用 report 核对原发送意图，不换编号盲重发；未知建群结果不会自动创建第二个群。未登记旧群不会自动接入，历史失败不会自动补发。
`;

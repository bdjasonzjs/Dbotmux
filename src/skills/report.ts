/** The canonical report skill. The existing authenticated API owns all IO. */
export const REPORT_SKILL = `---
name: botmux-report
description: 向用户汇报进展或结果、回答问题、请求用户判断时使用。调用已有汇报能力，自动建汇报群、关联来源并把用户回复回传原会话；不用于创建工作子群或 bot 间协作。用户明确要求本群回复时改用 botmux send。
---

# botmux-report — 汇报

在原业务会话调用本技能。群创建、邀请、来源绑定、正文展示、原群链接和回复回源均由命令处理；不要用 create-group、普通 send 或直接飞书 API 拼装。运行环境自动提供原群、原 session 和原 bot，不手填身份参数。

唯一底层入口：\`botmux human-session --input <JSON文件|->\`。它是 CLI，不是另一项技能。每次返回 \`{ok:true,result:...}\`；下文字段从 result 读取。

## 准备正文

一次一件事。答复或进展/结果汇报用 \`assistant_answer\`；需要用户选择方案用 \`human_decision\`。请求编号 requestId 自取唯一的字母、数字、下划线或连字符（最多 80 字符），同一事项全过程保持不变。

以下是答复草稿的完整结构；把示例内容换成真实事项，expiresAt 用当前毫秒时间加一小时（最长 24 小时）。这是操作有效期，不用找用户确认时间。

\`\`\`json
{
  "direction": "assistant_answer",
  "requestId": "report-example-1",
  "shortTitle": "导出功能进展",
  "background": "用户要求增加导出功能，本次说明已完成范围。",
  "answers": [{
    "question": "导出功能进展如何？",
    "conclusion": "代码和本地测试已完成，线上尚未验证。",
    "basis": "本地测试通过；尚未部署。",
    "limitations": "目前不能宣称线上可用。"
  }],
  "criticalFacts": [],
  "references": [],
  "expiresAt": 2000000000000
}
\`\`\`

shortTitle 为 2–30 字的具体标题，不带“汇报·”前缀。criticalFacts 如非空，每项为 \`{id,text,explanation}\`；references 每项为 \`{id,explanation}\`。数组可空，但不得为了省字段删掉重要事实。

选择方案时，草稿改为 \`{requestId,shortTitle,background,whyNow,decisions,criticalFacts,references,expiresAt}\`，不带 direction 或 answers。decisions 只含一个 \`{question,options}\`；options 为 2–12 个真实选项，每项有非空的 \`key,label,meaning,difference,consequence,cost,risk\`。仅在确实需要选择时用这个方向，不把普通答复改成选择题。

## 调用顺序

所有命令都带同一个 requestId 和 direction。JSON 文件或 stdin 都可；例如：

\`\`\`bash
botmux human-session --input - <<'JSON'
{"operation":"read_rules","requestId":"report-example-1","direction":"assistant_answer"}
JSON
\`\`\`

1. \`read_rules\`：完整阅读返回的 rules.text。
2. \`confirm_read\`：附加 \`token=result.receiptToken\`、\`hash=result.rules.sha256\`，值来自上一步真实返回。
3. \`freeze_facts\`：附加 \`draft\`（上述完整草稿）。
4. \`check\`：附加同一份 \`draft\`。现有服务自动检查正文，不需要另找 reviewer 或让用户批准。
5. 阅读 check 返回的 understanding，确认没有曲解正文后，调用 \`approve_understanding\`，附加真实 \`reportHash\`。这是作者核对文本，不是替用户作决定。
6. \`present\`：不加其它字段。能力自动创建并登记汇报群、发送正文和原群链接。查看返回的 roomId、presented.messageId、state；不再手工创建群或重复发正文/链接。

每一步读取上一步结果再继续，不猜 token/hash，也不提交 sessionId、originCapability 或检查器报告。改正文后重新 check；重要事实改变时使用新的事项编号。

## 回复与失败

用户回复会自动带着原汇报上下文、请求和事件 ID 回到原业务会话，并真正 mention 原 bot。发送身份由现有配置决定：用户身份优先，明确不可用才使用唯一配置的回退 bot；调用者不选择其它身份。

收到回源事件后，\`claim_event\` 附加 eventId。若已 CONSUMED，不重复执行业务；领取成功后处理原话，再用 \`consume_event\` 附加 eventId、领取返回的 token 和业务 receipt。不要只发“收到”就当业务已处理。

命令非零时说明实际失败阶段。NOT_ENABLED/ORIGIN_UNPROVEN 不要改用普通建群冒充汇报成功；结果不确定时保留原 requestId，通过 status/reconcile 核实，不换编号盲重发。已有未登记汇报群不会因安装本技能而自动接入，旧失败消息也不会自动补发。
`;

/**
 * 子任务投递的真 executor (2026-05-30, Phase 3 IO 层)。
 *
 * 投递身份 = **缇蕾直发** (蔻黛克斯/邹劲松 拍板)，不走 send-as-jason：
 *   这是系统 observer 上报，不是邹劲松本人下令，缇蕾身份更可审计、不混淆"是谁说的"。
 *
 * child_to_parent (子群 → 父群)：@主bot(克劳德)，中性文案 —— 只说有子任务状态变化、给
 *   taskId/commandId + query 指引，不塞长总结、不替主 bot 决策。主 bot 自己 `botmux subtask-query` 拉详情。
 * parent_to_child (主bot finish/supplement → 子群)：@子任务执行 bot，带内容。
 *
 * at-least-once (蔻黛克斯硬约束2)：uuid=cmd.cmdId 稳定 → lark 1h 幂等 send，
 *   "sent 回写前崩溃重投" 不会重复刷群；commandId 进文案，Phase 4 ack 按 commandId 去重。
 *
 * deliver 失败**返回 {ok:false}**、不抛 —— 让 dispatcher 走 claim/退避/重试。
 */
import { logger } from '../utils/logger.js';
import { sendMessage } from '../im/lark/client.js';
import { resolveBotIdent } from '../core/main-bot-playbook.js';
import type { DispatchExecutors } from './outbox-dispatcher.js';
import type { OutboxCommand, SubTask } from './subtask-store.js';

const CONTENT_MAX = 400;
/** 清洗**不可信内容** (payload 来自子群消息/LLM/主bot 下发)：
 *  中和 < > 防 `<at user_id=...>` 等富文本注入 (否则会在群里误 @ 人/bot，引入自引用/通知噪声)，
 *  并清控制字符。这是投递安全边界 (蔻黛克斯 review blocker)。 */
function safeText(s: unknown, n: number): string {
  const str = typeof s === 'string' ? s : (s == null ? '' : String(s));
  return str
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    .replace(/[<>]/g, ' ')   // 关键: 断掉 <at>/标签注入
    .slice(0, n);
}

/** 子群 → 父群上报文案：**只给 taskId/commandId + query 指引**，绝不塞 LLM/子群总结
 *  (review blocker：不可信内容不进父群、不替主 bot 决策)。@主bot 是我们自己拼的可信标签。 */
function childToParentText(cmd: OutboxCommand, task: SubTask, mainOpenId: string): string {
  const label = cmd.commandType === 'report_help' ? '需要协助' : '已完成（待确认）';
  // 接线 (review 边界1): 卡片给**精确可执行**命令，且用 commandId（ack 绑 child_to_parent command，
  // taskId 只能看快照不能可靠 ack 当前上报）。主 bot 直接照着跑。
  return [
    `<at user_id="${mainOpenId}">克劳德</at> 🛰️ 子任务状态变化：${label}`,
    `【taskId】${task.taskId}`,
    `【commandId】${cmd.cmdId}`,
    `→ 先 \`botmux subtask-query --command-id ${cmd.cmdId}\` 查详情+证据(并 ack 本上报)，`,
    `  读到 task.version 后据此 \`subtask-finish\` 或 \`subtask-supplement --expected-version <v>\`。`,
  ].join('\n');
}

/** 主bot finish/supplement → 子群文案 (@ 执行 bot)。payload.content 走 safeText 清洗。 */
function parentToChildText(cmd: OutboxCommand, task: SubTask): string {
  const ats = task.bots
    .filter(b => b.role !== 'observer')
    .map(b => `<at user_id="${b.openId}">${b.name}</at>`)
    .join(' ');
  if (cmd.commandType === 'finish') {
    const note = cmd.payload.content ? `\n【说明】${safeText(cmd.payload.content, CONTENT_MAX)}` : '';
    return `${ats} ✅ 主bot 已结束本子任务（taskId=${task.taskId}）。${note}`;
  }
  return `${ats} 📨 主bot 补充输入（taskId=${task.taskId}）：\n${safeText(cmd.payload.content ?? '', CONTENT_MAX)}`;
}

export function makeDispatchExecutors(): DispatchExecutors {
  const tilly = resolveBotIdent('tilly');
  return {
    async deliver(cmd: OutboxCommand, task: SubTask) {
      try {
        let text: string;
        if (cmd.direction === 'child_to_parent') {
          const claude = resolveBotIdent('claude'); // 懒解析: 缺 xref 不至于拖垮 daemon 构造
          text = childToParentText(cmd, task, claude.openId);
        } else {
          text = parentToChildText(cmd, task);
        }
        // uuid=cmd.cmdId 稳定 → lark 1h 幂等 send (at-least-once 去重)
        const messageId = await sendMessage(tilly.larkAppId, cmd.targetChatId, text, 'text', cmd.cmdId);
        return { ok: true, messageId };
      } catch (err: any) {
        logger.warn(`[outbox-dispatcher-exec] deliver cmd ${cmd.cmdId} failed: ${err?.message ?? err}`);
        return { ok: false, error: err?.message ?? String(err) }; // 不抛, 让 dispatcher 退避重试
      }
    },
  };
}

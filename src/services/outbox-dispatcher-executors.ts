/**
 * 子任务投递的真 executor (v3 重做 2026-05-31, 见 task-context「🔴 v3 设计纠偏」节)。
 *
 * 投递身份 = **coco 触发急急如律令 base relay** (松松强制设计，纠正 Phase 3 的「缇蕾直发」)：
 *   deliver 不再用缇蕾 sendMessage 直发，而是 sendAsOwner —— 写 base 记录 → 飞书自动化以
 *   owner(松松) 身份发出 `急急如律令：【目标bot】正文` → 命中 botname 的 daemon 当被 @ 一样唤起。
 *   这是「内存共享式通信」里 coco(dispatcher 跑在 coco daemon) 作为急急如律令唯一触发器的物理通道。
 *   bot 自己 @ 自己会被 self-mention 过滤；唯有以 owner 身份发才能唤醒目标 bot (含主 bot)。
 *
 * child_to_parent (子群求助/完成 → 父群)：急急如律令唤**主 bot**，给 taskId/commandId + query 指引，
 *   不塞长总结、不替主 bot 决策 (主 bot 自己 query 拉详情)。
 * parent_to_child (主bot finish/supplement → 子群)：急急如律令唤**子群执行 bot**，带内容。
 *
 * 可靠性 (保留 Phase 3 底座，蔻黛克斯 review)：deliver 失败**返 {ok:false} 不抛** → dispatcher 走
 *   claim/退避/重试。base relay 是异步的，sendAsOwner 阻塞轮询「已发送」(≤35s < lease 60s) 才返回
 *   (待定1 决策)；超时/取消 → 失败重试。重复 summon 幂等安全 —— summon 只是「去看 store」的唤醒信号，
 *   bot 醒来读到同一状态、不会重复执行 (内存共享式通信天然容忍重复唤醒)。
 */
import { logger } from '../utils/logger.js';
import { sendAsOwner } from './base-relay.js';
import type { DispatchExecutors } from './outbox-dispatcher.js';
import type { OutboxCommand, SubTask } from './subtask-store.js';

/** 急急如律令口令前缀 —— **必须**与 event-dispatcher.parseUrgentSummon 的解析前缀一致。
 *  内联而非 import event-dispatcher，避免投递层拖入 IM 路由的重依赖 (也便于单测隔离)。 */
const URGENT_SUMMON_TAG = '急急如律令';
const CONTENT_MAX = 400;

/** 清洗**不可信内容** (payload 来自子群消息/LLM/主bot 下发)：控制字符(含换行)→空格，
 *  让 summon 标题保持单行 (base 记录标题更稳)，并截断。急急如律令是纯文本、无富文本注入面，
 *  不必再中和 `<at>`；但正文里的换行/控制字符仍要清掉。 */
export function safeText(s: unknown, n: number): string {
  const str = typeof s === 'string' ? s : (s == null ? '' : String(s));
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\x00-\x1F\x7F]/g, ' ').slice(0, n);
}

/** 急急如律令名单 = 子群执行 bot (非 observer)。observer(缇蕾) 不唤 —— 它是触发者不是执行者。 */
function executorNames(task: SubTask): string[] {
  return task.bots.filter(b => b.role !== 'observer').map(b => b.name);
}
/** 主 bot 名 (child→parent 唤它)。取 role==='main'，缺省回退「克劳德」。 */
function mainBotName(task: SubTask): string {
  return task.bots.find(b => b.role === 'main')?.name ?? '克劳德';
}

/** 拼 `急急如律令：【名单】正文` (名单 / 分隔)。正文已 safeText。 */
function urgentSummon(names: string[], body: string): string {
  return `${URGENT_SUMMON_TAG}：【${names.join('/')}】${body}`;
}

/** 子群 → 父群上报文案 (急急如律令唤主 bot)：**只给 taskId/commandId + query 指引**，
 *  绝不塞 LLM/子群总结 (不可信内容不进父群、不替主 bot 决策)。 */
export function childToParentSummon(cmd: OutboxCommand, task: SubTask): string {
  const label = cmd.commandType === 'report_help' ? '需要协助' : '已完成（待确认）';
  const body = [
    `🛰️ 子任务状态变化：${label}。taskId=${task.taskId} commandId=${cmd.cmdId}。`,
    `请执行 \`botmux subtask-query --command-id ${cmd.cmdId}\` 查详情+证据并 ack，`,
    `读到 task.version 后据此 subtask-finish 或 subtask-supplement --expected-version <v>。`,
  ].join(' ');
  return urgentSummon([mainBotName(task)], body);
}

/** 主bot finish/supplement → 子群文案 (急急如律令唤执行 bot)。payload.content 走 safeText。 */
export function parentToChildSummon(cmd: OutboxCommand, task: SubTask): string {
  const names = executorNames(task);
  if (cmd.commandType === 'kickoff') {
    const acc = task.acceptance ? ` 验收：${safeText(task.acceptance, 200)}` : '';
    return urgentSummon(names, `📋 子任务启动：${safeText(task.goal, 240)}。${acc} 请开始干活；卡住/缺信息用 \`botmux subtask-askforhelp --task-id ${task.taskId} --summary "卡在哪"\` 向主 bot 求助，别硬扛别编。`);
  }
  if (cmd.commandType === 'finish') {
    const note = cmd.payload.content ? ` 说明：${safeText(cmd.payload.content, CONTENT_MAX)}` : '';
    return urgentSummon(names, `✅ 主bot 已结束本子任务（taskId=${task.taskId}）。${note}`);
  }
  return urgentSummon(names, `📨 主bot 补充输入（taskId=${task.taskId}）：${safeText(cmd.payload.content ?? '', CONTENT_MAX)}`);
}

export function makeDispatchExecutors(): DispatchExecutors {
  return {
    async deliver(cmd: OutboxCommand, task: SubTask) {
      const text = cmd.direction === 'child_to_parent'
        ? childToParentSummon(cmd, task)
        : parentToChildSummon(cmd, task);
      // 以 owner 身份发急急如律令 base relay，阻塞轮询「已发送」(待定1)。失败返 {ok:false} 不抛。
      const res = await sendAsOwner({ targetChatId: cmd.targetChatId, text });
      if (res.ok) {
        logger.info(`[outbox-dispatcher-exec] summon sent cmd ${cmd.cmdId} (${cmd.commandType}) → ${cmd.targetChatId.slice(0, 12)} record=${res.recordId?.slice(0, 12) ?? '?'}`);
        return { ok: true, messageId: res.recordId };  // base relay 无真 messageId，用 recordId 追溯 (v3 锚点是 commandId)
      }
      logger.warn(`[outbox-dispatcher-exec] summon failed cmd ${cmd.cmdId}: ${res.error}`);
      return { ok: false, error: res.error };
    },
  };
}

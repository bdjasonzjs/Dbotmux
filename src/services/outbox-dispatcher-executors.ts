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
 *   claim/退避/重试。base relay 是异步的，sendAsOwner 可先短等新群 group-id 字段生效，再阻塞轮询「已发送」
 *   (待定1 决策)；超时/取消 → 失败重试。重复 summon 幂等安全 —— summon 只是「去看 store」的唤醒信号，
 *   bot 醒来读到同一状态、不会重复执行 (内存共享式通信天然容忍重复唤醒)。
 */
import { logger } from '../utils/logger.js';
import { DEFAULT_GROUP_NOT_FOUND_RETRY_TIMEOUT_MS, sendAsOwner } from './base-relay.js';
import { SUBTASK_COLLAB_NORMS_ONELINE } from './subtask-norms.js';
import type { DispatchExecutors } from './outbox-dispatcher.js';
import type { CommandTargetRole, OutboxCommand, SubTask } from './subtask-store.js';

/** 急急如律令口令前缀 —— **必须**与 event-dispatcher.parseUrgentSummon 的解析前缀一致。
 *  内联而非 import event-dispatcher，避免投递层拖入 IM 路由的重依赖 (也便于单测隔离)。 */
const URGENT_SUMMON_TAG = '急急如律令';
const CONTENT_MAX = 400;

/** 所有**下发到子群的指令**（parent→child：kickoff / request_review / nudge / finish / supplement）
 *  末尾统一附加的硬规则（2026-06-04 邹劲松）：交还主群审查的文档必须写为飞书文档。
 *  急急如律令是单行纯文本（= base 记录标题），故用单行后缀拼接、不引入换行。
 *  child→parent（子群→父群上报）是上报、不是下发指令，不加。 */
const HANDBACK_DOC_RULE_SUFFIX = ' 另：所有交还主群审查的文档，都必须写为飞书文档（写成飞书 docx 发链接，不要塞聊天正文）。';

/** 清洗**不可信内容** (payload 来自子群消息/LLM/主bot 下发)：控制字符(含换行)→空格，
 *  让 summon 标题保持单行 (base 记录标题更稳)，并截断。急急如律令是纯文本、无富文本注入面，
 *  不必再中和 `<at>`；但正文里的换行/控制字符仍要清掉。 */
export function safeText(s: unknown, n: number): string {
  const str = typeof s === 'string' ? s : (s == null ? '' : String(s));
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\x00-\x1F\x7F]/g, ' ').slice(0, n);
}

/** 急急如律令名单 = 子群执行 bot (非 observer)。observer(缇蕾) 不唤 —— 它是触发者不是执行者。
 *  = legacy/'all' 的目标 (finish / 缺省 targetRole 的旧 supplement)。 */
function executorNames(task: SubTask): string[] {
  return task.bots.filter(b => b.role !== 'observer').map(b => b.name);
}
/** 主 bot 名 (child→parent 唤它)。取 role==='main'，缺省回退「克劳德」。 */
function mainBotName(task: SubTask): string {
  return task.bots.find(b => b.role === 'main')?.name ?? '克劳德';
}

/** 优化 #1/#3 (蔻黛克斯 #1-blocker3)：按角色解析急急如律令名单，**绝不返回空名单**。
 *  - 'main'：role==='main'，空 → 回退非 observer (自定义 bots/无 main 的任务仍能被唤)。
 *  - 'collab'：role==='collab'，空 → 回退非 observer (防御；requestReview service 已先 409 守无 reviewer)。
 *  - 'all'/缺省：非 observer 全体 (legacy 兼容)。 */
function resolveTargets(task: SubTask, role: CommandTargetRole | undefined): string[] {
  const nonObserver = executorNames(task);
  if (role === 'main') {
    const m = task.bots.filter(b => b.role === 'main').map(b => b.name);
    return m.length ? m : nonObserver;
  }
  if (role === 'collab') {
    const r = task.bots.filter(b => b.role === 'collab').map(b => b.name);
    return r.length ? r : nonObserver;
  }
  return nonObserver; // 'all' | undefined → legacy
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

/** parent→child / 子群内唤醒文案 (急急如律令)。按 commandType + targetRole 选**名单**和**文案**
 *  (优化 #1 角色分工 + #3 停滞唤醒)。payload 内容走 safeText、整体保持单行 (= base relay 记录标题)。 */
export function parentToChildSummon(cmd: OutboxCommand, task: SubTask): string {
  // 所有下发到子群的指令末尾统一附加「交还主群的文档必须写为飞书文档」(2026-06-04 邹劲松)。
  return parentToChildSummonBody(cmd, task) + HANDBACK_DOC_RULE_SUFFIX;
}

function parentToChildSummonBody(cmd: OutboxCommand, task: SubTask): string {
  if (cmd.commandType === 'kickoff') {
    // B1: kickoff 只唤执行者(main)，reviewer 不在此被唤起 (等执行者产出后 request_review 再唤)。
    const acc = task.acceptance ? ` 验收：${safeText(task.acceptance, 200)}` : '';
    return urgentSummon(resolveTargets(task, 'main'),
      `📋 子任务启动：${safeText(task.goal, 240)}。${acc} 你是主推进者，方案/代码/文档由你产出、你驱动任务；产出第一份可 review 物后用 \`botmux subtask-request-review --task-id ${task.taskId} --summary "<可打开的链接/绝对路径>"\` 唤起 reviewer。卡住用 \`botmux subtask-askforhelp --task-id ${task.taskId} --summary "卡在哪"\`，别硬扛别编。${SUBTASK_COLLAB_NORMS_ONELINE}`);
  }
  if (cmd.commandType === 'request_review') {
    // 优化 #1：只唤 reviewer，明确只 review/challenge、不抢执行。
    return urgentSummon(resolveTargets(task, 'collab'),
      `🔍 执行者已产出可 review 的交付物，请 review/challenge：${safeText(cmd.payload.summary ?? cmd.payload.content ?? '', CONTENT_MAX)}。你只 review/challenge，**不产主交付物、不直接实现**；发现问题挑出来交执行者改。`);
  }
  if (cmd.commandType === 'nudge') {
    // 优化 #3：停滞自动唤醒——只唤执行者(main)，内容就一句 (松松指定)。
    return urgentSummon(resolveTargets(task, 'main'), '任务搞定没有？');
  }
  if (cmd.commandType === 'finish') {
    const note = cmd.payload.content ? ` 说明：${safeText(cmd.payload.content, CONTENT_MAX)}` : '';
    return urgentSummon(resolveTargets(task, 'all'), `✅ 主bot 已结束本子任务（taskId=${task.taskId}）。${note}`);
  }
  // supplement：targetRole 缺省 → 'all' (legacy 兼容，旧 pending 仍唤 main+collab)；新命令显式带 'main'。
  const role = cmd.payload.targetRole ?? 'all';
  return urgentSummon(resolveTargets(task, role), `📨 主bot 补充输入（taskId=${task.taskId}）：${safeText(cmd.payload.content ?? '', CONTENT_MAX)}`);
}

export function makeDispatchExecutors(): DispatchExecutors {
  return {
    async deliver(cmd: OutboxCommand, task: SubTask) {
      const text = cmd.direction === 'child_to_parent'
        ? childToParentSummon(cmd, task)
        : parentToChildSummon(cmd, task);
      // 以 owner 身份发急急如律令 base relay，阻塞轮询「已发送」(待定1)。失败返 {ok:false} 不抛。
      // 幂等 (2026-06-10 修重复刷屏)：若本命令上次已写过 base 记录 (relayRecordId)，复用它**只重轮询**、
      // 不再 upsert；首发拿到的 recordId 即使 poll 超时也带回 (relayRecordId)，由 dispatcher 落库供重试复用。
      const res = await sendAsOwner({
        targetChatId: cmd.targetChatId,
        text,
        groupNotFoundRetryTimeoutMs: cmd.commandType === 'kickoff' ? DEFAULT_GROUP_NOT_FOUND_RETRY_TIMEOUT_MS : 0,
        existingRecordId: cmd.relayRecordId ?? undefined,
      });
      if (res.ok) {
        logger.info(`[outbox-dispatcher-exec] summon sent cmd ${cmd.cmdId} (${cmd.commandType}) → ${cmd.targetChatId.slice(0, 12)} record=${res.recordId?.slice(0, 12) ?? '?'}`);
        return { ok: true, messageId: res.recordId, relayRecordId: res.recordId };  // base relay 无真 messageId，用 recordId 追溯 (v3 锚点是 commandId)
      }
      logger.warn(`[outbox-dispatcher-exec] summon failed cmd ${cmd.cmdId}: ${res.error}`);
      return { ok: false, error: res.error, relayRecordId: res.recordId };  // 带回 recordId：首发已建记录、poll 超时，下轮复用别重发
    },
  };
}

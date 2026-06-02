/**
 * 子群任务 kickoff (2026-05-29, 松松设计的标准流程 P1).
 *
 * Why 缇蕾 发而不是 claude 自己发:
 *   bot 不回复自己的 @mention (daemon 忽略 self-mention)。所以 claude 建完群
 *   后不能自己 @ 自己唤起分身。改由**缇蕾身份**发 kickoff, @ claude 分身 +
 *   妹妹分身, 才能把他们俩在子群里唤起来干活。
 *   (技术上 claude daemon 直接用缇蕾的 lark client 发, 跟 tilly-publisher
 *    同一个 cross-app send 模式, 不需要 coco daemon 介入。)
 *
 * Why kickoff 要详实:
 *   子群里 claude/妹妹/缇蕾 都是**分身, 零主话题上下文**。所有背景必须塞进
 *   kickoff (或 task-context 文档), 否则分身不知道在干嘛。
 *
 * 分工 (松松定的标准):
 *   - claude 分身: 技术方案 + 工程实现
 *   - 妹妹(寇黛克斯)分身: review, 且对 claude 严格
 *   - 缇蕾: 盯群 (P2 watch loop), 卡死/完成升级 claude 主体
 */
import { sendMessage } from '../im/lark/client.js';
import { resolveBotIdent } from '../core/main-bot-playbook.js';
import { logger } from '../utils/logger.js';
import { SUBTASK_COLLAB_NORMS } from './subtask-norms.js';

export type SubgroupUrgency = 'urgent' | 'normal' | 'low';

export interface KickoffSpec {
  /** 任务一句话目标 */
  purpose: string;
  taskType: 'prd' | 'bug' | 'misc';
  urgency: SubgroupUrgency;
  /** 背景资料: task-context 文档路径 / PRD 链接 / ticket 号 等 */
  refs?: string[];
  /** 验收标准 (什么算 done), 可选但强烈建议填 */
  acceptance?: string;
}

function clean(s: string, n: number): string {
  // eslint-disable-next-line no-control-regex
  return (s ?? '').replace(/[\x00-\x1F\x7F]/g, ' ').slice(0, n);
}

const URGENCY_LABEL: Record<SubgroupUrgency, string> = {
  urgent: '🔴 紧急',
  normal: '🟡 普通',
  low: '⚪ 低优',
};

/** 纯函数: 渲染 kickoff 文本 (含 @ claude 分身 + @ 妹妹分身)。
 *  缇蕾不 @ 自己 (会被忽略)。 */
export function buildKickoffText(spec: KickoffSpec, opts: {
  claudeOpenId: string;
  sisterOpenId: string;
}): string {
  const refsBlock = spec.refs && spec.refs.length > 0
    ? spec.refs.map(r => `  - ${clean(r, 200)}`).join('\n')
    : '  (无额外资料, 以上面任务描述为准)';
  const acceptanceBlock = spec.acceptance
    ? clean(spec.acceptance, 300)
    : '(未明确, 执行中如不清晰找缇蕾确认)';

  return [
    `<at user_id="${opts.claudeOpenId}">克劳德</at> <at user_id="${opts.sisterOpenId}">寇黛克斯</at>`,
    ``,
    `📦 子群任务 kickoff · ${URGENCY_LABEL[spec.urgency]}`,
    ``,
    `【任务】${clean(spec.purpose, 300)}`,
    `【类型】${spec.taskType}`,
    `【背景资料】`,
    refsBlock,
    `【验收标准】${acceptanceBlock}`,
    ``,
    `【分工】(松松定的标准)`,
    `- 克劳德(你): 技术方案 + 工程实现。先出方案、对齐再动手, 不闷头写。`,
    `- 寇黛克斯(妹妹): review。对克劳德**严格一点**, 方案和代码都挑, 别放水。`,
    `- 缇蕾(我): 盯这个群的进展, 卡死/完成/需松松决策时升级给克劳德主体。`,
    ``,
    `【约定】`,
    `- 你俩在这群里**没有主话题上下文**, 所有背景以上面 + 背景资料为准, 不要凭群名臆测。`,
    `- 阶段性进展直接在群里说, 我会定时扫。`,
    `- 真卡到需要松松拍板的, 说清楚卡在哪 + 需要什么, 我升级。`,
    // 优化 #2：协作 norms (旧 v1 watcher 链路也固化)
    ...SUBTASK_COLLAB_NORMS.map(n => `- ${n}`),
  ].join('\n');
}

/** 用缇蕾身份往子群发 kickoff, 唤起 claude + 妹妹分身。
 *  返回 message_id (失败抛, 调用方决定要不要 fail spawn)。 */
export async function sendSubgroupKickoff(chatId: string, spec: KickoffSpec): Promise<string> {
  const tilly = resolveBotIdent('tilly');
  const claude = resolveBotIdent('claude');
  const sister = resolveBotIdent('codex');   // 'codex' key = 寇黛克斯(妹妹)
  const text = buildKickoffText(spec, {
    claudeOpenId: claude.openId,
    sisterOpenId: sister.openId,
  });
  const msgId = await sendMessage(tilly.larkAppId, chatId, text, 'text');
  logger.info(`[subgroup-kickoff] 缇蕾 sent kickoff to ${chatId.slice(0, 12)} (urgency=${spec.urgency}, type=${spec.taskType}) msg=${msgId}`);
  return msgId;
}

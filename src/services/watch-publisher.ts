/**
 * 给任意群挂 observer · 一期：汇报投递层（per-目标群 digest）。
 *
 * 每个目标群一条聚合 digest（设计 v3.1 §四③）：把发到同一目标群的多个被盯群的 open
 * incident 拼成一条，发到该目标群。
 *
 * 防刷屏（三道）：
 *   1) **内容没变不重发**：digest 内容签名 = open incident 集合 + 状态 + 归一化要点；
 *      跟上次发出的签名一样 → skip（治 digest 自身每 tick 重发，review carry-back）；
 *   2) **目标群日预算**：每个目标群每天最多发几条，耗尽 → 留 inbox、不再发（不静默，logger 标明丢弃）；
 *   3) incident 级去重 + 显式 close 已在 watch-inbox-store 保证。
 *
 * 投递成功后把该 digest 覆盖到的 incident 标 delivery=sent（at-least-once：发失败不记签名 →
 * 下轮重试）。决策逻辑在此、可单测；真实发送由 executors 注入（默认缇蕾身份发目标群）。
 */
import { logger } from '../utils/logger.js';
import { listOpen, updateDelivery, type WatchIncident } from './watch-inbox-store.js';
import {
  getDigestState, listKnownTargets, budgetRemaining, recordSent,
} from './watch-digest-store.js';

export interface PublisherExecutors {
  /** 发一条 digest 到目标群，返 messageId；失败返 null（下轮重试）。 */
  send(targetChatId: string, text: string): Promise<string | null>;
}

/** 把一个目标群名下的 open incident 拼成 digest：返签名（变化检测用）+ 文本。纯函数。 */
export function buildTargetDigest(incidents: WatchIncident[]): { signature: string; text: string } {
  // 稳定排序：按 incidentId，签名才稳定（不受存储顺序影响）。
  const sorted = [...incidents].sort((a, b) => a.incidentId.localeCompare(b.incidentId));
  // 签名只看「身份 + 状态 + 归一化要点」，不看每 tick 抖动的自由文本，避免措辞抖动触发重发。
  const signature = JSON.stringify(sorted.map(it => [it.incidentId, it.status, normalizeForSig(it.summary)]));
  if (sorted.length === 0) {
    return { signature, text: '✅ 盯群汇报：之前的待办都已处理/关闭，当前没有未处理项。' };
  }
  const lines = sorted.map((it, i) =>
    `${i + 1}. [${it.watchedChatId.slice(0, 12)}] ${it.summary}${it.evidence ? `\n   证据：${it.evidence}` : ''}`);
  const text = [
    `🔭 盯群汇报（${sorted.length} 项待关注）`,
    ...lines,
    `\n（处理完某项后 \`botmux watch close <incidentId>\` 关掉它就不再汇报；用 \`botmux watch incidents --target <本群>\` 看详情）`,
  ].join('\n');
  return { signature, text };
}

function normalizeForSig(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\s\x00-\x1F\x7F]+/g, '').replace(/[。，、,.!！?？;；:：]/g, '').toLowerCase().slice(0, 80);
}

export interface DigestTickResult { targetsChecked: number; sent: number; skippedUnchanged: number; droppedBudget: number; failed: number; }

/**
 * digest tick：对每个「有 open incident 的目标群」+「之前发过 digest 的目标群」（后者处理 all-clear）：
 *   - 算当前 digest 签名；与上次发出的签名相同 → skip（没变不重发）；
 *   - 预算耗尽 → 丢弃（留 inbox、logger 标明，不静默）；
 *   - 否则发送；成功 → 记签名/消耗预算 + 把覆盖到的 incident 标 delivery=sent。
 */
export async function runDigestTick(
  now: Date,
  exec: PublisherExecutors,
  opts: { maxPerDay?: number } = {},
): Promise<DigestTickResult> {
  const res: DigestTickResult = { targetsChecked: 0, sent: 0, skippedUnchanged: 0, droppedBudget: 0, failed: 0 };

  // open digest_item incident 按目标群分组
  const open = listOpen().filter(it => it.kind === 'digest_item');
  const byTarget = new Map<string, WatchIncident[]>();
  for (const it of open) {
    if (!byTarget.has(it.targetChatId)) byTarget.set(it.targetChatId, []);
    byTarget.get(it.targetChatId)!.push(it);
  }
  // 并上「之前发过 digest、现在可能已清空」的目标群（处理 all-clear）
  const targets = new Set<string>([...byTarget.keys(), ...listKnownTargets()]);

  for (const targetChatId of targets) {
    res.targetsChecked += 1;
    const incidents = byTarget.get(targetChatId) ?? [];
    const { signature, text } = buildTargetDigest(incidents);
    const prev = getDigestState(targetChatId);

    // 1) 没变不重发
    if (prev && prev.lastSignature === signature) { res.skippedUnchanged += 1; continue; }
    // all-clear 且从没发过非空 → 不发空 digest
    if (incidents.length === 0 && (!prev || prev.lastSignature === '' || prev.lastSignature === JSON.stringify([]))) {
      res.skippedUnchanged += 1; continue;
    }

    // 2) 预算
    if (budgetRemaining(targetChatId, now, opts.maxPerDay) <= 0) {
      logger.warn(`[watch-publisher] 目标群 ${targetChatId.slice(0, 12)} 当日 digest 预算耗尽 → 丢弃本次（${incidents.length} 项留 inbox，不发）`);
      res.droppedBudget += 1; continue;
    }

    // 3) 发送
    let messageId: string | null = null;
    try {
      messageId = await exec.send(targetChatId, text);
    } catch (err) {
      logger.warn(`[watch-publisher] send to ${targetChatId.slice(0, 12)} failed: ${err}`);
      res.failed += 1; continue;
    }
    if (messageId == null) { res.failed += 1; continue; } // 发失败不记签名 → 下轮重试

    recordSent({ targetChatId, signature, messageId, now });
    // 把本条 digest 覆盖到的 incident 标 delivery=sent（at-least-once 满足）
    for (const it of incidents) {
      updateDelivery(it.incidentId, { messageId, deliveryStatus: 'sent', lastDeliveredAt: now.toISOString() });
    }
    res.sent += 1;
    logger.info(`[watch-publisher] digest → ${targetChatId.slice(0, 12)} (${incidents.length} 项, msg ${messageId})`);
  }
  return res;
}

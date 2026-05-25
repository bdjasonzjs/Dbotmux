/**
 * P3 commit #4 — tilly-publisher: 把当日 cumulative TillyDigest 渲染成
 * 主话题汇总卡，每 15min 编辑同一张卡（不刷屏）。
 *
 * dedup id: `tilly_digest:<YYYY-MM-DD>` — 跨日自动新卡（旧卡静止）。
 *
 * 卡片结构（4 section）：
 *   🐶 缇蕾今日扫读（N items · tick=K）
 *   ────
 *   📝 待办 (N)
 *   - [high] 回复 PRD 评论 (群 X) [→]
 *   ...
 *   ✅ 进展 (M)
 *   ...
 *   🚧 卡点 (K)
 *   ...
 *   💡 值得记 (P)
 *   ...
 */
import { getMainTopicChatId } from './main-topic-config.js';
import * as rootInbox from './root-inbox-store.js';
import { sendOrUpdateCard, closeAndRenderClosed } from './root-inbox-card-renderer.js';
import { logger } from '../utils/logger.js';
import type { CurrentDigestFile } from './tilly-digest-store.js';
import { totalCount } from './tilly-digest-store.js';

const TILLY_SUBCHAT_PLACEHOLDER = 'tilly-scout';   // not a real chat; tilly_digest is a daemon channel

export interface PublishTillyOpts {
  /** larkAppId to send-as. Defaults to Claude bot — caller usually has it. */
  larkAppId: string;
}

/** Render a TillyDigest into Lark v2 markdown card content. */
export function renderTillyCardContent(d: CurrentDigestFile): string {
  const total = totalCount(d);
  const headerLines = [
    `**🐶 缇蕾今日扫读 · ${d.dateId} (${total} items, ${d.tickCount} ticks)**`,
    `\n_最新 tick: ${d.lastTickAt.slice(11, 19)} UTC_\n`,
  ];

  const formatItem = (it: { summary: string; sourceChatName: string; sourceMessageId: string; priority?: string }): string => {
    const prio = it.priority ? `[${it.priority}] ` : '';
    const sub = it.sourceChatName ? ` · *${it.sourceChatName}*` : '';
    return `- ${prio}${it.summary}${sub}`;
  };

  const sec = (title: string, items: any[]): string[] => {
    if (items.length === 0) return [];
    return [`**${title} (${items.length})**`, ...items.map(formatItem), ''];
  };

  const body = [
    ...sec('📝 待办', d.todos),
    ...sec('✅ 进展', d.progress),
    ...sec('🚧 卡点', d.blockers),
    ...sec('💡 值得记', d.noteworthy),
  ];
  if (body.length === 0) body.push('_今日缇蕾还没看到任何值得汇报的_');

  return [...headerLines, ...body].join('\n');
}

/** Publish (insert or update) the current day's TillyDigest card to mainTopic.
 *  Idempotent within a day (same dateId → updates same card). */
export async function publishTillyDigest(
  digest: CurrentDigestFile,
  opts: PublishTillyOpts,
): Promise<{ rootCardMessageId: string | null; inserted: boolean }> {
  const id = `tilly_digest:${digest.dateId}`;
  // P3-rev1 v0.2 (妹妹补): allowReopen=false — daily digest 语义是
  // "今日 dismiss 后不再打扰"。如果松松手动关闭今日扫读卡，下个 tick
  // 不应该 reopen 一张新 #2 卡（会变成"撤销关闭"，反产品意图）。
  // 跨日自然新卡（dateId 不同），不依赖 reopen 机制。
  const { item, inserted } = rootInbox.upsertOpen({
    id,
    kind: 'tilly_digest',
    subChatId: TILLY_SUBCHAT_PLACEHOLDER,
    subChatName: `缇蕾扫读 ${digest.dateId}`,
    summary: `今日 ${totalCount(digest)} items / ${digest.tickCount} ticks`,
    // allowReopen defaults to false
  });

  const mainTopic = getMainTopicChatId();
  if (!mainTopic) {
    logger.info('[tilly-publisher] mainTopic not configured — card not sent (digest stored only)');
    return { rootCardMessageId: item.rootCardMessageId, inserted };
  }

  // P3-rev1 #5 (妹妹 v0.2): pass tilly card markdown explicitly via
  // RenderOpts.customMarkdown, NOT by overwriting item.summary. store's
  // summary stays a short label so dashboard/listOpen don't get bloated.
  const cardMarkdown = renderTillyCardContent(digest);
  const msgId = await sendOrUpdateCard(opts.larkAppId, mainTopic, item, { customMarkdown: cardMarkdown });
  return { rootCardMessageId: msgId, inserted };
}

const TILLY_ALERT_ID = 'tilly_alert';

/** P0-2 (2026-05-25 妹妹): tilly tick 连续失败 >= 阈值时主话题发 alert
 *  卡。dedup id 固定（不带 date），所以多次失败 update 同一张卡（count++）。
 *  成功一次后 caller 调 dismissTillyAlert 关闭卡（已恢复）。 */
export async function publishTillyAlert(
  opts: PublishTillyOpts & { consecutiveFails: number; lastError: string },
): Promise<{ rootCardMessageId: string | null; inserted: boolean }> {
  const { item, inserted } = rootInbox.upsertOpen({
    id: TILLY_ALERT_ID,
    kind: 'tilly_alert',
    subChatId: TILLY_SUBCHAT_PLACEHOLDER,
    subChatName: '缇蕾健康检查',
    summary: `连续 ${opts.consecutiveFails} 次 tick 失败 · 最近错误: ${opts.lastError.slice(0, 200)}`,
    allowReopen: true,  // alert 是健康信号，恢复后又坏了必须能 reopen
  });

  const mainTopic = getMainTopicChatId();
  if (!mainTopic) {
    logger.info('[tilly-publisher] alert mainTopic not configured — alert stored only');
    return { rootCardMessageId: item.rootCardMessageId, inserted };
  }
  const msgId = await sendOrUpdateCard(opts.larkAppId, mainTopic, item);
  return { rootCardMessageId: msgId, inserted };
}

/** P0-2: tilly tick 成功一次后 close alert 卡（如果存在），让健康卡显
 *  示「已恢复」状态。idempotent — 卡不存在/已关闭都 no-op。 */
export async function dismissTillyAlert(opts: PublishTillyOpts): Promise<void> {
  const existing = rootInbox.lookup(TILLY_ALERT_ID);
  if (!existing || existing.status === 'closed') return;
  await closeAndRenderClosed(TILLY_ALERT_ID, opts.larkAppId);
}

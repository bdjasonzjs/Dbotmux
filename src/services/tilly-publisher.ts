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
import { sendMessage } from '../im/lark/client.js';
import { logger } from '../utils/logger.js';
import type { CurrentDigestFile } from './tilly-digest-store.js';
import { totalCount } from './tilly-digest-store.js';
import type { TillyDigest, TillyDigestItem } from './tilly-llm-analyzer.js';
import {
  enqueueTillyDigestHigh,
  markTillyHighNotified,
  listUnnotifiedTillyHigh,
  type ScoutTillyHighItem,
} from './main-bot-digest-store.js';

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

  // P1-5 (2026-05-25 妹妹): 每条 item 末尾加 [→](applink) 一键跳回原消息。
  // sourceAppLink 由 tilly-llm-analyzer enrich 阶段从 raw lark 消息字段填，
  // LLM 不参与链接拼接（防幻觉）。link 缺失 (lark-cli 偶发返回空) 时退化
  // 为不带链接，不阻塞产出。
  const formatItem = (it: { summary: string; sourceChatName: string; sourceMessageId: string; priority?: string; sourceAppLink?: string }): string => {
    const prio = it.priority ? `[${it.priority}] ` : '';
    const sub = it.sourceChatName ? ` · *${it.sourceChatName}*` : '';
    const jump = it.sourceAppLink ? ` [→](${it.sourceAppLink})` : '';
    return `- ${prio}${it.summary}${sub}${jump}`;
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

/** @deprecated 2026-05-25 Phase A v2 commit 2 follow-up (妹妹 blocker):
 *  之前 publishTillyDigest 每 15min update 主话题大卡 + 写
 *  RootInbox `kind:'tilly_digest'` open item。妹妹 v2 #3 / commit 2 review:
 *  - 主话题大卡完全停（松松实拍 UI 不上浮看不到）
 *  - **RootInbox 也不能写** — 这把 cumulative digest 当 actionable open
 *    item 展示在顶栏面板，违反 "RootInbox=action queue / tilly cumulative=
 *    dashboard 追溯" 边界
 *
 *  cumulative digest 的真源已在 `mergeNewDigest()` 写的
 *  `tilly-digest-current.json` 里（dashboard `/api/tilly-digest` 直接读，
 *  commit 4 加路由）。本函数完全 no-op 保留只为不破坏 caller import；
 *  daemon (commit 3) 也将不再调它。
 */
export async function publishTillyDigest(
  _digest: CurrentDigestFile,
  _opts: PublishTillyOpts,
): Promise<{ rootCardMessageId: string | null; inserted: boolean }> {
  return { rootCardMessageId: null, inserted: false };
}

/** 2026-05-25 Phase A v2 commit 2: 缇蕾本次 tick 出现的 high-prio item
 *  (high todo / 任何 blocker) → push 到 scout-inbox。dedup by sourceMessageId
 *  跨 pending+processed (dismissed 永久 sink)。
 *
 *  策略：blocker > high todo。同条消息既 blocker 又 high todo 时优先
 *  作 blocker 入 inbox，让后续 todo 命中 dedup 不重复入。返回新插入的
 *  item 列表 — caller 用来决定是否发 notification + markNotified。
 */
export function pushHighPriorityToScoutInbox(d: TillyDigest): ScoutTillyHighItem[] {
  const newlyInserted: ScoutTillyHighItem[] = [];
  // Step 1: blockers 先入 (优先级最高)
  for (const it of d.blockers) {
    const r = enqueueTillyDigestHigh({
      category: 'blocker',
      payload: extractPayload(it),
    });
    if (r.inserted) newlyInserted.push(r.item);
  }
  // Step 2: 仅 high-prio todos (priority='high') 入 — med/low 不进 inbox 也不通知
  for (const it of d.todos) {
    if (it.priority !== 'high') continue;
    const r = enqueueTillyDigestHigh({
      category: 'todo',
      payload: extractPayload(it),
    });
    if (r.inserted) newlyInserted.push(r.item);
  }
  return newlyInserted;
}

/** Helper: TillyDigestItem → ScoutTillyHighItem.payload */
function extractPayload(it: TillyDigestItem): ScoutTillyHighItem['payload'] {
  return {
    summary: it.summary,
    sourceChatId: it.sourceChatId,
    sourceChatName: it.sourceChatName,
    sourceMessageId: it.sourceMessageId,
    sourceAppLink: it.sourceAppLink,
    priority: it.priority,
  };
}

const TILLY_ALERT_ID = 'tilly_alert';

/** 2026-05-25 (松松实拍): 缇蕾 update 同一张卡 → Lark UI 不上浮，
 *  松松在 timeline 最新位置看不到卡（卡卡在第一次 send 的时间点）。+
 *  克劳德分身没被 @ 也不知道扫读更新，问"小宝启动没"会答"没有"。
 *
 *  方案 B：本次 tick 有 high-prio 新增（新 high todo 或新 blocker）时
 *  发一条独立 text 消息到主话题，@克劳德 bot + 带卡的 applink。
 *
 *  节流：5min 内只发 1 条（同 daemon 进程的 module-level last-sent ts）。 */
const NOTIFY_THROTTLE_MS = 5 * 60 * 1000;
let lastNotifyAt = 0;

/** 2026-05-25 Phase A v2 commit 2: 通知 @松松 + @克劳德，**绑定 inbox
 *  insert 结果**（妹妹 v2 review #6）。
 *
 *  逻辑：
 *  - caller 传入本次 tick 新增的 ScoutTillyHighItem 列表 + 之前
 *    throttle/失败遗留的 unnotified item（从 listUnnotifiedTillyHigh 拿）
 *  - 合并去重后判断有没有 items 需要通知
 *  - throttle 命中 → 不发，items.notifiedAt 不更新（下次 tick 自然再
 *    试，避免 throttle 误吞重点）
 *  - 发送成功 → markTillyHighNotified 标 notifiedAt 防重复
 *  - 发送失败 → 不标，下次 tick 重试
 */
export async function notifyClaudeAboutInboxItems(
  newlyInserted: ScoutTillyHighItem[],
  opts: PublishTillyOpts & { claudeOpenId: string },
): Promise<boolean> {
  // 合并：本次新插入 + 历史遗留 (throttle/失败未通知的 pending items)
  const carryover = listUnnotifiedTillyHigh().filter(
    it => !newlyInserted.some(n => n.id === it.id),
  );
  const all = [...newlyInserted, ...carryover];
  if (all.length === 0) return false;

  const now = Date.now();
  if (now - lastNotifyAt < NOTIFY_THROTTLE_MS) {
    logger.info(`[tilly-publisher] notify throttled (${all.length} items pending, last sent ${Math.floor((now - lastNotifyAt) / 1000)}s ago, throttle=${NOTIFY_THROTTLE_MS / 1000}s) — items remain unnotified for next tick`);
    return false;
  }
  const mainTopic = getMainTopicChatId();
  if (!mainTopic) return false;

  const blockerCount = all.filter(i => i.category === 'blocker').length;
  const todoCount = all.filter(i => i.category === 'todo').length;
  const total = all.length;

  // v2.1 commit 2 (2026-05-26 松松/妹妹): 不再 @ 松松 (只 @ 克劳德分身)
  // + 文案去业务化。
  // - 旧版: "@松松 @克劳德 🐶 缇蕾扫到 X blocker:\n- [blocker] <summary>" → 自己
  //   制造业务语义 ("有 N blocker 需要松松处理")，被下一轮缇蕾扫到时
  //   又被 LLM 当成业务消息生成 meta blocker (self-loop)。
  // - 新版: 中性 stat 描述 + dashboard 路由，**不包含 LLM 自由文本
  //   summary**，避免下一轮缇蕾把通知里的 high-prio summary 字符串再
  //   归类成新业务卡点。
  //   "@克劳德 🐶 缇蕾新增 N 条高优先级扫读项 (X blocker + Y todo)，
  //    已进 ScoutInbox / 协作面板。"
  // 主 bot 自己决定要不要找松松；这里不替主 bot 拍板"重要程度"。
  const parts: string[] = [];
  if (blockerCount > 0) parts.push(`${blockerCount} blocker`);
  if (todoCount > 0) parts.push(`${todoCount} high-prio todo`);
  const breakdown = parts.length > 0 ? ` (${parts.join(' + ')})` : '';
  const text = `<at user_id="${opts.claudeOpenId}"></at> 🐶 缇蕾新增 ${total} 条高优先级扫读项${breakdown}，已进 ScoutInbox / 协作面板「🐶 缇蕾扫读」tab。`;

  try {
    const msgId = await sendMessage(opts.larkAppId, mainTopic, text, 'text');
    lastNotifyAt = now;
    // 标 inbox items 已通知 — 防下次 tick 重发同一批
    for (const it of all) markTillyHighNotified(it.id);
    logger.info(`[tilly-publisher] notify sent (msg=${msgId}, ${all.length} items${breakdown}) to mainTopic ${mainTopic}`);
    return true;
  } catch (err) {
    logger.warn(`[tilly-publisher] notify failed: ${err} — items stay unnotified for next tick`);
    return false;
  }
}

/** @deprecated Phase A v2 (2026-05-25): 用 notifyClaudeAboutInboxItems
 *  替代。这个旧 API 直接看 TillyDigest 算 high-prio count，没绑定 inbox
 *  insert 结果，throttle 时 item 会被永久跳过（妹妹 review #6 防误吞）。
 *  v2.1 commit 2: 旧签名里的 ownerOpenId 也已删，新链路完全不 @ 松松。
 */
export async function notifyClaudeIfImportant(
  _newTick: TillyDigest,
  _opts: PublishTillyOpts & { claudeOpenId: string; ownerOpenId?: string; cardMessageId?: string | null },
): Promise<boolean> {
  logger.warn('[tilly-publisher] notifyClaudeIfImportant is deprecated — use pushHighPriorityToScoutInbox + notifyClaudeAboutInboxItems');
  return false;
}

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
 *  示「已恢复」状态。idempotent — 卡不存在/已关闭都 no-op。
 *
 *  2026-05-25 妹妹 blocker fix: 不能用 lookup(baseId) — 因为 alert 是
 *  allowReopen=true 的 singleton，第二轮 fail 后会创建 `tilly_alert#2`
 *  generation；如果只看 baseId 会拿到已 closed 的 generation 1 然后
 *  no-op，让 #2 常驻 open。改用 lookupOpenByBaseId 找当前 open 那张
 *  generation 来 close。 */
export async function dismissTillyAlert(opts: PublishTillyOpts): Promise<void> {
  const openAlert = rootInbox.lookupOpenByBaseId(TILLY_ALERT_ID);
  if (!openAlert) return;
  await closeAndRenderClosed(openAlert.id, opts.larkAppId);
}

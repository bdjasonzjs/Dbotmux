/**
 * Render the main-bot mode "chat context card" — the markdown welcome card
 * dispatched into a chat right after its ChatContext is created.
 *
 * Two audiences read this card:
 *   - **Humans** (松松 + collaborators): sanity-check what the bot inferred
 *     about the chat — wrong purpose / wrong parent → just tell the bot
 *     and correct the ChatContext file.
 *   - **Bots** (when spawning sessions in this chat): their L3 system
 *     prompt also gets a copy of the ChatContext (see P1 onSessionSpawn),
 *     but seeing the card in-channel reinforces that they're "expected"
 *     to know the context.
 *
 * Rendered via [[md-card.buildMarkdownCard]] so it goes through the same
 * markdown-it pipeline as every other botmux card (consistent chrome,
 * GFM tables work, etc).
 */
import { read, type ChatContext } from '../../services/chat-context-store.js';
import { buildMarkdownCard } from './md-card.js';
import { sendMessage } from './client.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import { getBot } from '../../bot-registry.js';

/** Build the dashboard URL with a chat fragment so clicking opens directly
 *  to that chat's topology node. The fragment shape (#/topology?chat=...)
 *  is what the P4 dashboard topology tab will parse. */
export function buildDashboardChatUrl(chatId: string): string {
  const host = config.dashboard.externalHost;
  const port = config.dashboard.port;
  return `http://${host}:${port}/#/topology?chat=${encodeURIComponent(chatId)}`;
}

/** Render the ChatContext as markdown body (no card wrapping). Exposed
 *  separately for tests and for callers that want to embed the body in a
 *  different card chrome. */
export function renderContextCardMarkdown(ctx: ChatContext): string {
  const lines: string[] = [];

  lines.push(`🛠 **${ctx.purpose}**`);
  lines.push('');

  if (ctx.inheritedFrom?.parentChatId) {
    lines.push(`- **派生自**：\`${ctx.inheritedFrom.parentChatId}\``);
  } else {
    lines.push('- **派生自**：(无父群)');
  }

  lines.push(`- **出生来源**：\`${ctx.originType}\``);

  if (ctx.relatedRefs.length > 0) {
    lines.push(`- **关联链接**：${ctx.relatedRefs.map(r => `[ref](${r})`).join(' · ')}`);
  }

  if (ctx.activeTodoRefs.length > 0) {
    lines.push(`- **关联任务**：${ctx.activeTodoRefs.join(' / ')}`);
  } else {
    lines.push('- **关联任务**：(无)');
  }

  if (ctx.participants.length > 0) {
    const participants = ctx.participants
      .map(p => `${p.role}(\`${p.openId.slice(0, 12)}…\`)`)
      .join(' · ');
    lines.push(`- **关键参与者**：${participants}`);
  } else {
    lines.push('- **关键参与者**：(待补)');
  }

  if (ctx.rules.length > 0) {
    lines.push(`- **红线提醒**：${ctx.rules.join(' / ')}`);
  }

  if (ctx.inheritedFrom?.parentDigest) {
    lines.push('');
    lines.push('> 📋 **父群最近 24h 关键讨论摘要**');
    lines.push('>');
    for (const line of ctx.inheritedFrom.parentDigest.split('\n')) {
      lines.push(line.trim() ? `> ${line}` : '>');
    }
  }

  lines.push('');
  lines.push(`📊 [**Dashboard 拓扑节点**](${buildDashboardChatUrl(ctx.chatId)}) · 点击查看该群在 main-bot 拓扑中的位置`);
  lines.push('');
  lines.push(`<font color='grey'>· chat-context · written at ${ctx.updatedAt} ·</font>`);

  return lines.join('\n');
}

/** Render the card to a Lark interactive card JSON string (ready for
 *  sendMessage with msgType='interactive'). */
export function renderContextCard(ctx: ChatContext): string {
  return buildMarkdownCard(renderContextCardMarkdown(ctx));
}

/**
 * Send the chat-context card to the given chat **and pin it** so the
 * dashboard link stays in the chat header for easy access. Best-effort:
 *
 *   - No ChatContext for this chat → log warn, return null
 *   - injectionPolicy != 'eager' → log info, return null (manual /
 *     on_first_mention paths will dispatch elsewhere)
 *   - send fails (network / Lark error) → log error, return null
 *   - pin fails → log warn, still return the messageId (card is sent;
 *     pin is a nice-to-have)
 *
 * Returns the message_id on success, null on any skip/send-failure.
 */
export async function sendContextCard(larkAppId: string, chatId: string): Promise<string | null> {
  const ctx = read(chatId);
  if (!ctx) {
    logger.warn(`[chat-context-card] no ChatContext for chat ${chatId}, skipping card send`);
    return null;
  }
  if (ctx.injectionPolicy !== 'eager') {
    logger.info(
      `[chat-context-card] chat ${chatId} injectionPolicy=${ctx.injectionPolicy} (not eager), skipping auto-send`
    );
    return null;
  }
  let messageId: string;
  try {
    const cardJson = renderContextCard(ctx);
    messageId = await sendMessage(larkAppId, chatId, cardJson, 'interactive');
    logger.info(`[chat-context-card] sent context card ${messageId} to chat ${chatId}`);
  } catch (err) {
    logger.error(`[chat-context-card] failed to send card to chat ${chatId}: ${err}`);
    return null;
  }

  // Best-effort pin so the dashboard link is always visible in the chat
  // header. Pin failure shouldn't surface as a card-send failure.
  try {
    await pinMessage(larkAppId, messageId);
    logger.info(`[chat-context-card] pinned context card ${messageId} in chat ${chatId}`);
  } catch (err) {
    logger.warn(`[chat-context-card] pin failed for ${messageId} (card still sent): ${err}`);
  }

  return messageId;
}

/** Pin a message in its chat via Lark im.v1.pins.create. Throws on failure
 *  (caller is responsible for best-effort handling). */
async function pinMessage(larkAppId: string, messageId: string): Promise<void> {
  // Use the per-bot Lark Client directly so we don't ship a new client
  // helper for this single call. The pin API is straightforward enough.
  const c = getBot(larkAppId).client as any;
  const res = await c.im.v1.pin.create({
    data: { message_id: messageId },
  });
  if (res.code !== 0) {
    throw new Error(`pin failed: ${res.msg} (code: ${res.code})`);
  }
}

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
  lines.push(`<font color='grey'>· chat-context · written at ${ctx.updatedAt} ·</font>`);

  return lines.join('\n');
}

/** Render the card to a Lark interactive card JSON string (ready for
 *  sendMessage with msgType='interactive'). */
export function renderContextCard(ctx: ChatContext): string {
  return buildMarkdownCard(renderContextCardMarkdown(ctx));
}

/**
 * Send the chat-context card to the given chat. Best-effort:
 *
 *   - No ChatContext for this chat → log warn, return null
 *   - injectionPolicy != 'eager' → log info, return null (manual /
 *     on_first_mention paths will dispatch elsewhere)
 *   - send fails (network / Lark error) → log error, return null (does NOT
 *     throw, so callers like onChatCreated can keep going)
 *
 * Returns the message_id on success, null on any skip/failure.
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
  try {
    const cardJson = renderContextCard(ctx);
    const messageId = await sendMessage(larkAppId, chatId, cardJson, 'interactive');
    logger.info(`[chat-context-card] sent context card ${messageId} to chat ${chatId}`);
    return messageId;
  } catch (err) {
    logger.error(`[chat-context-card] failed to send card to chat ${chatId}: ${err}`);
    return null;
  }
}

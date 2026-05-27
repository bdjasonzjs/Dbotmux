/**
 * Phase B.2 (2026-05-27): scout-inbox-router 的真 executor 实现.
 *
 * B.1 把决策 + quota 抽成 pure router; 这里把 router 接到真 lark / spawnSubTask.
 *
 * - pingJasonExecutor: 把一组 high-prio item 渲染成一条精简文本, 发到主话题
 *   @松松. 复用 tilly-publisher 已有的「中性 stat 描述, 不带 LLM summary」
 *   惯例避免 self-loop。
 * - spawnHandlerExecutor: 调 createGroupWithBots 开三 bot 分身 chat 接手该
 *   item. purpose = item.payload.summary。parentChatId = mainTopic。
 *   ChatContext.relatedRefs 把 sourceChatId / sourceMessageId / sourceAppLink
 *   带过去, 分身 chat 一开始就看得到「这是为了 follow-up 哪条消息」。
 *
 * 跨 process 安全 gate (mainTopic 不在这里 spawn — 由 router 上层路径决定,
 * 这里只创建分身 chat 不会写回 mainTopic)。
 */
import { logger } from '../utils/logger.js';
import { sendMessage } from '../im/lark/client.js';
import { getMainTopicChatId } from './main-topic-config.js';
import { createGroupWithBots } from './group-creator.js';
import { resolveBotIdent } from '../core/main-bot-playbook.js';
import type { ScoutTillyHighItem } from './main-bot-digest-store.js';
import type { RouterExecutors } from './scout-inbox-router.js';

/** 松松 user open_id (跨 app 一致那个; 这是 claude app 视角)。
 *  和 CLAUDE.md / tilly-llm-analyzer.SONGSONG_OPEN_ID 同源, 改要一起改. */
const JASON_OPEN_ID = 'ou_974b9321334628537abee157413b33b6';

function clean(s: string, n: number): string {
  // eslint-disable-next-line no-control-regex
  return (s ?? '').replace(/[\x00-\x1F\x7F<>]/g, ' ').slice(0, n);
}

export function makeProductionExecutors(opts: { larkAppId: string }): RouterExecutors {
  return {
    async pingJason(items: ScoutTillyHighItem[]): Promise<void> {
      const mainTopic = getMainTopicChatId();
      if (!mainTopic) {
        throw new Error('mainTopicChatId not configured — cannot path A ping');
      }
      const blockerCount = items.filter(i => i.category === 'blocker').length;
      const todoCount = items.filter(i => i.category === 'todo').length;
      // 中性 stat 描述 + 列每条简要 (chat + summary 截 100) — 用户可以一眼扫
      const breakdown: string[] = [];
      if (blockerCount > 0) breakdown.push(`${blockerCount} blocker`);
      if (todoCount > 0) breakdown.push(`${todoCount} high-prio todo`);
      const lines: string[] = [
        `<at user_id="${JASON_OPEN_ID}"></at> 🤖 克劳德 scout-router: ${items.length} 条 high-prio 待你决策 (${breakdown.join(' + ')})`,
      ];
      for (const it of items.slice(0, 8)) {       // cap 8 行防 spam
        const tag = it.category === 'blocker' ? '🔴' : '📋';
        const chat = clean(it.payload.sourceChatName ?? '', 24);
        const summary = clean(it.payload.summary ?? '', 100);
        lines.push(`${tag} ${chat}: ${summary}`);
      }
      if (items.length > 8) lines.push(`...另 ${items.length - 8} 条进 ScoutInbox 面板`);
      lines.push(`/dashboard 看完整列表; 回「跟」让我接手 / 「放着」标 dismiss`);
      await sendMessage(opts.larkAppId, mainTopic, lines.join('\n'), 'text');
      logger.info(`[scout-router-exec] pingJason sent: ${items.length} items to mainTopic`);
    },

    async spawnHandler(item: ScoutTillyHighItem): Promise<string | null> {
      const mainTopic = getMainTopicChatId();
      if (!mainTopic) {
        logger.error('[scout-router-exec] spawnHandler: mainTopicChatId not configured');
        return null;
      }
      const claudeApp = resolveBotIdent('claude').larkAppId;
      const codexApp = resolveBotIdent('codex').larkAppId;
      const tillyApp = resolveBotIdent('tilly').larkAppId;
      const summary = clean(item.payload.summary, 80);
      const refs: string[] = [];
      if (item.payload.sourceMessageId) refs.push(`source-msg: ${item.payload.sourceMessageId}`);
      if (item.payload.sourceChatName) refs.push(`source-chat: ${clean(item.payload.sourceChatName, 30)}`);
      if (item.payload.sourceAppLink) refs.push(`applink: ${item.payload.sourceAppLink}`);
      try {
        const result = await createGroupWithBots({
          creatorLarkAppId: claudeApp,
          larkAppIds: [claudeApp, codexApp, tillyApp],
          name: `auto: ${summary}`.slice(0, 60),
          sourceChatId: mainTopic,          // parent = main topic
          purpose: `[scout-router auto-spawn] ${summary}`,
          chatContext: {
            taskType: 'misc',
            relatedRefs: refs,
            participants: [
              { openId: resolveBotIdent('claude').openId, role: 'main bot' },
              { openId: resolveBotIdent('codex').openId, role: 'reviewer/sister' },
              { openId: resolveBotIdent('tilly').openId, role: 'scout' },
            ],
          },
        });
        logger.info(`[scout-router-exec] spawnHandler ok: item=${item.id} → chat=${result.chatId}`);
        return result.chatId;
      } catch (err: any) {
        logger.error(`[scout-router-exec] spawnHandler failed for item ${item.id}: ${err?.message ?? err}`);
        return null;
      }
    },
  };
}

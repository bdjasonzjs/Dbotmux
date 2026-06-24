/**
 * 盯群汇报投递的真 executor：缇蕾身份把 digest 发到目标群。
 *
 * 投递身份 = 缇蕾（coco）——她本来就是 observer，旧 group-monitor 的 wakeClaude 也是缇蕾身份发的，
 * 一脉相承。read-only：只发汇报目标群，绝不在被盯群发言。
 */
import { logger } from '../utils/logger.js';
import { sendMessage } from '../im/lark/client.js';
import { resolveBotIdent } from '../core/main-bot-playbook.js';
import type { PublisherExecutors } from './watch-publisher.js';

export function makePublisherExecutors(): PublisherExecutors {
  const tilly = resolveBotIdent('tilly');
  return {
    async send(targetChatId: string, text: string): Promise<string | null> {
      try {
        return await sendMessage(tilly.larkAppId, targetChatId, text, 'text');
      } catch (err: any) {
        logger.warn(`[watch-publisher-exec] send to ${targetChatId.slice(0, 12)} failed: ${err?.message ?? err}`);
        return null;
      }
    },
  };
}

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listObservedBots } from './observed-bots-store.js';

/** Resolve the clone's open_id in the sender app's view for outbound @mentions.
 *  Priority:
 *  1. bot-openids-${senderAppId}.json cross-ref learned from receiver events.
 *  2. observed-bots per sender/chat from /introduce.
 *  Never fall back to the clone's self-reported open_id. */
export function resolveSenderScopedCloneOpenId(
  dataDir: string,
  senderAppId: string,
  chatId: string,
  displayName: string | undefined,
): string | undefined {
  const name = displayName?.trim();
  if (!name) return undefined;
  const target = name.toLowerCase();

  try {
    const fp = join(dataDir, `bot-openids-${senderAppId}.json`);
    if (existsSync(fp)) {
      const data: Record<string, string> = JSON.parse(readFileSync(fp, 'utf-8'));
      for (const [botName, openId] of Object.entries(data)) {
        if (botName.trim().toLowerCase() === target && typeof openId === 'string' && openId.trim()) {
          return openId;
        }
      }
    }
  } catch { /* corrupt/missing cross-ref → fallback */ }

  try {
    return listObservedBots(dataDir, senderAppId, chatId, Infinity)
      .find(b => b.name.trim().toLowerCase() === target)?.openId;
  } catch {
    return undefined;
  }
}

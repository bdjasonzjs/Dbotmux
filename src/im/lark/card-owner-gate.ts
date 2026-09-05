/**
 * Card owner-only gate (owner decision 2026-09-05 18:27 / 18:28).
 *
 * The model picker (entry button + every button inside it) and 「显示输出」
 * may only be operated by the bot's OWNER — not by "any verifiable human"
 * (the v1 rule). The owner of a bot is whoever bots.json names in that bot's
 * `allowedUsers`. A card callback always arrives on the bot whose card was
 * clicked, so the comparison is app-scoped and exact:
 *
 *   - `ou_` entries (resolved at daemon start into `resolvedAllowedUsers`)
 *     match the callback's Lark-verified `operator.open_id` of the SAME app;
 *   - `on_` entries (tenant-stable union ids) match the operator's verified
 *     union id (`operator.union_id`, or the contact API fallback).
 *
 * Deterministic and synchronous: no network on the click path (the 2.5 s card
 * ACK budget), no cache — every callback re-reads the live registry state,
 * nothing carried by the card is trusted.
 *
 * Fail-closed: no allowlist configured, a bot that is not registered, a
 * missing / malformed id, or no match → "not the owner". (This deliberately
 * does NOT fall through to "open bot ⇒ everyone", unlike `canOperate`.)
 */
import { getBot } from '../../bot-registry.js';

export interface CardOperatorIds { openId?: string | null; unionId?: string | null }

/** True only when the operator is one of this bot's configured owners. */
export function isCardOwnerOperator(larkAppId: string | undefined | null, operator: CardOperatorIds): boolean {
  if (!larkAppId) return false;
  let bot: ReturnType<typeof getBot>;
  try { bot = getBot(larkAppId); } catch { return false; }
  const configured = (bot.config.allowedUsers ?? []).map(v => v.trim()).filter(Boolean);
  if (configured.length === 0) return false; // fail closed — an unowned bot has no owner
  const openId = operator.openId?.trim();
  const unionId = operator.unionId?.trim();
  if (unionId && unionId.startsWith('on_') && configured.includes(unionId)) return true;
  if (openId && openId.startsWith('ou_') && (bot.resolvedAllowedUsers ?? []).includes(openId)) return true;
  return false;
}

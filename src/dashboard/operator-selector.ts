// src/dashboard/operator-selector.ts
//
// Helper for the "Create new group" flow: when the dashboard auto-invites the
// operator into the freshly-created chat, the operator's `open_id` and the
// creator bot must come from the SAME Lark app — Feishu open_ids are app-
// scoped, so using bot A as creator with bot B's open_id of the user lands the
// user in `invalid_user_id_list` and the chat ends up with only bots in it.
//
// This module isolates the selection logic so it's unit-testable independent
// of the rest of dashboard.ts (which is a pm2 entry script, awkward to test).
//
// Selection rule: from the aggregator's session cache, pick the most-recent
// non-closed session whose `larkAppId` corresponds to a currently-online
// daemon. Both the operator's `open_id` and the creator daemon are derived
// from that single session so the scope matches.

export interface SelectorSession {
  ownerOpenId?: string;
  larkAppId?: string;
  status?: string;
  lastMessageAt?: number;
}

export interface OperatorPick {
  openId: string;
  larkAppId: string;
}

/**
 * Return the most-recent active session whose owner can be auto-invited
 * (sessions whose larkAppId points at a daemon that's currently online).
 * Closed sessions and sessions without ownerOpenId/larkAppId are skipped.
 */
export function pickOperatorForCreate(
  sessions: Iterable<SelectorSession>,
  isOnline: (larkAppId: string) => boolean,
): OperatorPick | null {
  let best: { openId: string; larkAppId: string; lastMessageAt: number } | null = null;
  for (const s of sessions) {
    if (s.status === 'closed') continue;
    if (!s.ownerOpenId || !s.larkAppId) continue;
    if (!isOnline(s.larkAppId)) continue;
    const ts = s.lastMessageAt ?? 0;
    if (!best || ts > best.lastMessageAt) {
      best = { openId: s.ownerOpenId, larkAppId: s.larkAppId, lastMessageAt: ts };
    }
  }
  return best ? { openId: best.openId, larkAppId: best.larkAppId } : null;
}

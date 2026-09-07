/**
 * Server-side pending confirmations for the card model switch (S3 r4 P1-1).
 *
 * A confirmation card is only ever a *reference* to an offer the daemon made:
 * the offer carries what was offered (model / effort / entry semantics), to
 * whom, for which session, and a unique `offerId` that is also the card's
 * `menu_id`. Confirming requires the exact `offerId`, so an older identical
 * card can never consume a newer offer (ABA), and an offer becomes usable only
 * after its card was actually delivered (`creating` → `delivered`); a failed
 * delivery deletes it under a same-instance CAS. Consumption is one-shot.
 *
 * Bounded: one active offer per (bot, session) — a new offer supersedes the
 * previous one — plus a global cap with oldest-first eviction, an expiry
 * sweep on every insert, and explicit per-session cleanup on close.
 */
import { randomBytes } from 'node:crypto';

export type ModelConfirmSource = 'curated' | 'custom';
export type OfferState = 'creating' | 'delivered';

export interface PendingModelOffer {
  offerId: string;
  larkAppId: string;
  sessionId: string;
  model?: string;
  effort?: string;
  source: ModelConfirmSource;
  operatorOpenId: string;
  state: OfferState;
  createdAt: number;
}

export const PENDING_CONFIRM_TTL_MS = 10 * 60 * 1000;
export const PENDING_CONFIRM_MAX = 256;

const byOfferId = new Map<string, PendingModelOffer>();
const activeBySession = new Map<string, string>(); // session key → offerId
const sessionKey = (larkAppId: string, sessionId: string) => `${larkAppId}::${sessionId}`;

function remove(offerId: string): void {
  const o = byOfferId.get(offerId);
  if (!o) return;
  byOfferId.delete(offerId);
  const k = sessionKey(o.larkAppId, o.sessionId);
  if (activeBySession.get(k) === offerId) activeBySession.delete(k);
}

function sweep(now: number): void {
  for (const o of byOfferId.values()) {
    if (now - o.createdAt > PENDING_CONFIRM_TTL_MS) remove(o.offerId);
  }
}

/** Global cap: evict oldest first (Map preserves insertion order). */
function enforceCap(): void {
  while (byOfferId.size > PENDING_CONFIRM_MAX) {
    const oldest = byOfferId.keys().next().value;
    if (oldest === undefined) break;
    remove(oldest);
  }
}

/** Create a `creating` offer; supersedes the session's previous offer. */
export function createOffer(
  input: Omit<PendingModelOffer, 'offerId' | 'state' | 'createdAt'>,
  now: number = Date.now(),
): PendingModelOffer {
  sweep(now);
  const k = sessionKey(input.larkAppId, input.sessionId);
  const prev = activeBySession.get(k);
  if (prev) remove(prev);
  const offer: PendingModelOffer = { ...input, offerId: randomBytes(8).toString('hex'), state: 'creating', createdAt: now };
  byOfferId.set(offer.offerId, offer);
  activeBySession.set(k, offer.offerId);
  enforceCap();
  return offer;
}

/** CAS: mark THIS offer instance delivered (no-op if superseded / gone). */
export function markOfferDelivered(offerId: string): boolean {
  const o = byOfferId.get(offerId);
  if (!o || o.state !== 'creating') return false;
  o.state = 'delivered';
  return true;
}

/** CAS: drop THIS offer instance (e.g. delivery failed); never touches a newer one. */
export function discardOffer(offerId: string): boolean {
  if (!byOfferId.has(offerId)) return false;
  remove(offerId);
  return true;
}

export interface ConsumeInput {
  offerId: string | undefined;
  larkAppId: string;
  sessionId: string;
  operatorOpenId: string;
  model: string | undefined;
  effort: string | undefined;
}

/**
 * One-shot consumption: the offer must exist, be `delivered`, not expired,
 * belong to this (bot, session, operator) and name exactly this model/effort.
 * Anything else leaves the store untouched and returns undefined.
 */
export function consumeOffer(input: ConsumeInput, now: number = Date.now()): PendingModelOffer | undefined {
  if (!input.offerId) return undefined;
  const o = byOfferId.get(input.offerId);
  if (!o) return undefined;
  if (now - o.createdAt > PENDING_CONFIRM_TTL_MS) { remove(o.offerId); return undefined; }
  if (o.state !== 'delivered') return undefined;
  if (o.larkAppId !== input.larkAppId || o.sessionId !== input.sessionId) return undefined;
  if (o.operatorOpenId !== input.operatorOpenId) return undefined;
  if (o.model !== input.model || o.effort !== input.effort) return undefined;
  remove(o.offerId);
  return o;
}

/** Session closed → nothing of it may remain confirmable. */
export function clearOffersForSession(larkAppId: string, sessionId: string): number {
  const k = sessionKey(larkAppId, sessionId);
  let n = 0;
  for (const o of [...byOfferId.values()]) {
    if (o.larkAppId === larkAppId && o.sessionId === sessionId) { remove(o.offerId); n++; }
  }
  activeBySession.delete(k);
  return n;
}

export function __testOnly_offerStats(): { total: number; sessions: number } {
  return { total: byOfferId.size, sessions: activeBySession.size };
}
export function __testOnly_resetOffers(): void { byOfferId.clear(); activeBySession.clear(); }

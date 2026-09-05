/**
 * Bounded server-side confirmation offers (S3 r4 P1-1 / P2-1).
 * Run:  pnpm vitest run test/model-switch-offers.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createOffer, markOfferDelivered, discardOffer, consumeOffer, clearOffersForSession,
  PENDING_CONFIRM_MAX, PENDING_CONFIRM_TTL_MS, __testOnly_offerStats, __testOnly_resetOffers,
} from '../src/core/model-switch-offers.js';

const base = (over: Record<string, unknown> = {}) => ({ larkAppId: 'app', sessionId: 's1', model: 'm', source: 'custom' as const, operatorOpenId: 'ou_1', ...over });
const consume = (offerId: string | undefined, over: Record<string, unknown> = {}, now?: number) =>
  consumeOffer({ offerId, larkAppId: 'app', sessionId: 's1', operatorOpenId: 'ou_1', model: 'm', effort: undefined, ...over } as any, now);

beforeEach(() => __testOnly_resetOffers());

describe('lifecycle', () => {
  it('creating → delivered → consumed once', () => {
    const o = createOffer(base());
    expect(consume(o.offerId)).toBeUndefined();            // not delivered yet
    expect(markOfferDelivered(o.offerId)).toBe(true);
    expect(consume(o.offerId)?.offerId).toBe(o.offerId);
    expect(consume(o.offerId)).toBeUndefined();            // one-shot
    expect(__testOnly_offerStats()).toEqual({ total: 0, sessions: 0 });
  });
  it('a new offer for the same session supersedes the old; CAS on the old instance is a no-op', () => {
    const a = createOffer(base());
    const b = createOffer(base());
    expect(markOfferDelivered(a.offerId)).toBe(false);     // superseded → cannot come back
    expect(discardOffer(a.offerId)).toBe(false);
    expect(markOfferDelivered(b.offerId)).toBe(true);
    expect(consume(a.offerId)).toBeUndefined();
    expect(consume(b.offerId)?.offerId).toBe(b.offerId);
  });
  it('discard on delivery failure removes exactly that instance', () => {
    const a = createOffer(base());
    expect(discardOffer(a.offerId)).toBe(true);
    expect(__testOnly_offerStats().total).toBe(0);
    const b = createOffer(base());
    expect(discardOffer(a.offerId)).toBe(false);
    expect(__testOnly_offerStats().total).toBe(1);
    expect(markOfferDelivered(b.offerId)).toBe(true);
  });
  it('exact-match consumption: wrong session / bot / operator / model / effort all refuse without consuming', () => {
    const o = createOffer(base({ effort: 'high' }));
    markOfferDelivered(o.offerId);
    for (const over of [{ sessionId: 's2' }, { larkAppId: 'app2' }, { operatorOpenId: 'ou_2' }, { model: 'other' }, { effort: 'low' }, { effort: undefined }]) {
      expect(consume(o.offerId, over)).toBeUndefined();
    }
    expect(consume(o.offerId, { effort: 'high' })?.offerId).toBe(o.offerId);
  });
});

describe('bounded recycling (P2-1)', () => {
  it('expired offers are dropped on consume and swept on insert', () => {
    const o = createOffer(base(), 1000);
    markOfferDelivered(o.offerId);
    expect(consume(o.offerId, {}, 1000 + PENDING_CONFIRM_TTL_MS + 1)).toBeUndefined();
    expect(__testOnly_offerStats().total).toBe(0);
    createOffer(base({ sessionId: 'old' }), 1000);
    createOffer(base({ sessionId: 'new' }), 1000 + PENDING_CONFIRM_TTL_MS + 1);
    expect(__testOnly_offerStats()).toEqual({ total: 1, sessions: 1 });
  });
  it('global cap evicts oldest first', () => {
    for (let i = 0; i < PENDING_CONFIRM_MAX + 10; i++) createOffer(base({ sessionId: `s${i}` }), 1000 + i);
    expect(__testOnly_offerStats().total).toBe(PENDING_CONFIRM_MAX);
    expect(__testOnly_offerStats().sessions).toBe(PENDING_CONFIRM_MAX);
  });
  it('one active offer per session keeps the store from growing with repeated menus', () => {
    for (let i = 0; i < 50; i++) createOffer(base());
    expect(__testOnly_offerStats()).toEqual({ total: 1, sessions: 1 });
  });
  it('closing a session clears its offers and nothing else', () => {
    const a = createOffer(base({ sessionId: 'a' })); markOfferDelivered(a.offerId);
    const b = createOffer(base({ sessionId: 'b' })); markOfferDelivered(b.offerId);
    expect(clearOffersForSession('app', 'a')).toBe(1);
    expect(consume(a.offerId, { sessionId: 'a' })).toBeUndefined();
    expect(consume(b.offerId, { sessionId: 'b' })?.offerId).toBe(b.offerId);
  });
});

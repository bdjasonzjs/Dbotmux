/**
 * Unit tests for dashboard's operator-selection logic for the "Create new group"
 * auto-invite flow. Critical because Lark `open_id` is app-scoped — picking the
 * wrong creator daemon for a given user open_id will silently fail the invite.
 */
import { describe, it, expect } from 'vitest';
import { pickOperatorForCreate, type SelectorSession } from '../src/dashboard/operator-selector.js';

const onlineSet = (...ids: string[]) => (id: string) => ids.includes(id);

describe('pickOperatorForCreate', () => {
  it('returns null when there are no candidates', () => {
    expect(pickOperatorForCreate([], onlineSet())).toBeNull();
  });

  it('picks the most-recent active session whose daemon is online', () => {
    const sessions: SelectorSession[] = [
      { ownerOpenId: 'ou_old', larkAppId: 'cli_a', status: 'idle', lastMessageAt: 100 },
      { ownerOpenId: 'ou_new', larkAppId: 'cli_a', status: 'working', lastMessageAt: 500 },
      { ownerOpenId: 'ou_mid', larkAppId: 'cli_a', status: 'idle', lastMessageAt: 300 },
    ];
    const pick = pickOperatorForCreate(sessions, onlineSet('cli_a'));
    expect(pick).toEqual({ openId: 'ou_new', larkAppId: 'cli_a' });
  });

  it('skips closed sessions', () => {
    const sessions: SelectorSession[] = [
      { ownerOpenId: 'ou_alive',  larkAppId: 'cli_a', status: 'idle',   lastMessageAt: 100 },
      { ownerOpenId: 'ou_closed', larkAppId: 'cli_a', status: 'closed', lastMessageAt: 999 },
    ];
    const pick = pickOperatorForCreate(sessions, onlineSet('cli_a'));
    expect(pick?.openId).toBe('ou_alive');
  });

  it('skips sessions whose daemon is offline', () => {
    const sessions: SelectorSession[] = [
      { ownerOpenId: 'ou_offline', larkAppId: 'cli_offline', status: 'idle', lastMessageAt: 999 },
      { ownerOpenId: 'ou_online',  larkAppId: 'cli_online',  status: 'idle', lastMessageAt: 100 },
    ];
    const pick = pickOperatorForCreate(sessions, onlineSet('cli_online'));
    expect(pick).toEqual({ openId: 'ou_online', larkAppId: 'cli_online' });
  });

  it('skips sessions missing ownerOpenId or larkAppId', () => {
    const sessions: SelectorSession[] = [
      {                          larkAppId: 'cli_a', status: 'idle', lastMessageAt: 999 },
      { ownerOpenId: 'ou_a',                         status: 'idle', lastMessageAt: 999 },
      { ownerOpenId: 'ou_real',  larkAppId: 'cli_a', status: 'idle', lastMessageAt: 100 },
    ];
    const pick = pickOperatorForCreate(sessions, onlineSet('cli_a'));
    expect(pick?.openId).toBe('ou_real');
  });

  it('returns null when the most-recent session is offline-bound — no fallback', () => {
    // Important: we deliberately do NOT silently fall back to a different
    // bot's session, because mixing app-scopes is exactly the bug.
    const sessions: SelectorSession[] = [
      { ownerOpenId: 'ou_offline', larkAppId: 'cli_offline', status: 'idle', lastMessageAt: 100 },
    ];
    expect(pickOperatorForCreate(sessions, onlineSet('cli_other'))).toBeNull();
  });

  it('cross-bot: prefers any online-bound session even if a more recent offline-bound session exists', () => {
    // The selector picks the most-recent ONLINE-BOUND one. If bot A is online
    // with an older session and bot B is offline with a newer session, bot A
    // wins — both because that's the only invitable scope and because we
    // never split open_id from creator daemon.
    const sessions: SelectorSession[] = [
      { ownerOpenId: 'ou_b_recent', larkAppId: 'cli_b_offline', status: 'idle', lastMessageAt: 999 },
      { ownerOpenId: 'ou_a_old',    larkAppId: 'cli_a_online',  status: 'idle', lastMessageAt: 100 },
    ];
    const pick = pickOperatorForCreate(sessions, onlineSet('cli_a_online'));
    expect(pick).toEqual({ openId: 'ou_a_old', larkAppId: 'cli_a_online' });
  });
});

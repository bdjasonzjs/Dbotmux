import { describe, expect, it, vi } from 'vitest';
import { sendAskHumanReply, AskHumanUserUnavailable, askHumanUserIdentityRefused } from '../src/core/ask-human-reply.js';

describe('human reply sender selection', () => {
  it('recognizes explicit send refusals, without confusing a member-read permission with send permission', () => {
    expect(askHumanUserIdentityRefused({ code: 230027 }, 'send')).toBe(true);
    expect(askHumanUserIdentityRefused({ type: 'authentication' }, 'read')).toBe(true);
    expect(askHumanUserIdentityRefused({ type: 'authorization' }, 'send')).toBe(true);
    expect(askHumanUserIdentityRefused({ type: 'authorization' }, 'read')).toBe(false);
    expect(askHumanUserIdentityRefused({ type: 'rate_limit' }, 'send')).toBe(false);
    expect(askHumanUserIdentityRefused({ code: 230027 })).toBe(false);
  });
  it('sends as the human and does not use the fallback when user identity works', async () => {
    const user = vi.fn(async () => 'om_user'), fallback = vi.fn(async () => 'om_bot');
    expect(await sendAskHumanReply({ userOpenId: 'ou_human' }, { user, fallback, fallbackAppId: 'cli_fallback' }))
      .toEqual({ messageId: 'om_user', sender: { type: 'user', id: 'ou_human' } });
    expect(user).toHaveBeenCalledTimes(1); expect(fallback).not.toHaveBeenCalled();
  });
  it('uses only the designated bot after a definite user-identity rejection', async () => {
    const user = vi.fn(async () => { throw new AskHumanUserUnavailable('external group rejected'); });
    const fallback = vi.fn(async () => 'om_bot');
    expect(await sendAskHumanReply({ userOpenId: 'ou_human' }, { user, fallback, fallbackAppId: 'cli_fallback' }))
      .toEqual({ messageId: 'om_bot', sender: { type: 'bot', id: 'cli_fallback' } });
    expect(user).toHaveBeenCalledTimes(1); expect(fallback).toHaveBeenCalledTimes(1);
  });
  it.each(['timeout after provider acceptance', 'rate limited', 'invalid mention'])('does not switch sender for %s', async message => {
    const fallback = vi.fn(async () => 'om_bot');
    await expect(sendAskHumanReply({ userOpenId: 'ou_human' }, {
      user: async () => { throw Error(message); }, fallback, fallbackAppId: 'cli_fallback',
    })).rejects.toThrow(message);
    expect(fallback).not.toHaveBeenCalled();
  });
});

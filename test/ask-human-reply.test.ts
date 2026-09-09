import { describe, expect, it, vi } from 'vitest';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendAskHumanReply, AskHumanUserUnavailable, askHumanUserIdentityRefused,
  askHumanReplyMention, sendAskHumanViaProfile } from '../src/core/ask-human-reply.js';

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
  it.each(['success', 'refused', 'uncertain', 'read-failed'])('runs the actual child CLI boundary in PM2 environment: %s', async mode => {
    const dir = mkdtempSync(join(tmpdir(), 'human-reply-cli-'));
    const log = join(dir, 'calls.jsonl');
    copyFileSync(new URL('./fixtures/ask-human-lark-cli.cjs', import.meta.url), join(dir, 'lark-cli'));
    chmodSync(join(dir, 'lark-cli'), 0o700);
    vi.stubEnv('PATH', `${dir}:${process.env.PATH}`);
    vi.stubEnv('NODE_CHANNEL_FD', '3');
    vi.stubEnv('NODE_CHANNEL_SERIALIZATION_MODE', 'json');
    vi.stubEnv('ASK_HUMAN_TEST_LOG', log);
    vi.stubEnv('ASK_HUMAN_TEST_MODE', mode);
    try {
      const send = async (profile: string, identity: 'user' | 'bot') => {
        const id = await askHumanReplyMention(profile, identity, 'oc_source', 'cli_source');
        return sendAskHumanViaProfile(profile, identity, 'oc_source', `<at user_id="${id}"></at> original reply`, 'same-uuid', undefined,
          { appId: 'cli_source', sessionId: 'source-session', chatId: 'oc_source' });
      };
      const result = sendAskHumanReply({ userOpenId: 'ou_human' }, {
        user: () => send('user-profile', 'user'), fallback: () => send('only-fallback', 'bot'), fallbackAppId: 'cli_fallback',
      });
      if (mode === 'read-failed') await expect(result).rejects.toMatchObject({ code: 'REPLY_NOT_SENT' });
      else if (mode === 'uncertain') await expect(result).rejects.toMatchObject({ code: 'REPLY_TRANSPORT_UNCERTAIN' });
      else expect(await result).toEqual(mode === 'success'
        ? { messageId: 'om_user', sender: { type: 'user', id: 'ou_human' } }
        : { messageId: 'om_bot', sender: { type: 'bot', id: 'cli_fallback' } });
      const calls: string[][] = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(calls).toHaveLength(mode === 'read-failed' ? 1 : mode === 'refused' ? 4 : 2);
      if (mode !== 'read-failed') expect(calls[1]).toContain('<at user_id="ou_source_from_user"></at> original reply');
      if (mode === 'refused') {
        expect(calls[3]).toContain('only-fallback');
        expect(calls[3]).toContain('<at user_id="ou_source_from_bot"></at> original reply');
      }
    } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  });
});

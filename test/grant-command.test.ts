/**
 * grant-command：parseGrantTarget 纯函数 + tryHandleGrantCommand 端到端（@bot /grant @user）。
 * Run: pnpm vitest run test/grant-command.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

// 拦截发卡/回执，避免真实 Lark API 调用。
const replyMock = vi.fn(async () => 'om_reply');
vi.mock('../src/im/lark/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/im/lark/client.js')>();
  return { ...actual, replyMessage: (...a: any[]) => replyMock(...a) };
});

import { parseGrantTarget, tryHandleGrantCommand } from '../src/im/lark/grant-command.js';
import { registerBot, getBot } from '../src/bot-registry.js';
import * as pending from '../src/im/lark/grant-pending.js';

describe('parseGrantTarget', () => {
  it('extracts first non-bot human mention', () => {
    const msg = { mentions: [
      { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Claude' },
      { key: '@_user_2', id: { open_id: 'ou_g' }, name: '张三' },
    ] };
    expect(parseGrantTarget(msg, 'ou_bot')).toEqual({ openId: 'ou_g', name: '张三' });
  });

  it('returns undefined when only the bot itself is mentioned', () => {
    expect(parseGrantTarget({ mentions: [{ id: { open_id: 'ou_bot' }, name: 'Claude' }] }, 'ou_bot')).toBeUndefined();
  });

  it('returns undefined when no mentions', () => {
    expect(parseGrantTarget({ mentions: [] }, 'ou_bot')).toBeUndefined();
    expect(parseGrantTarget({}, 'ou_bot')).toBeUndefined();
  });

  it('falls back to open_id as name when name missing', () => {
    expect(parseGrantTarget({ mentions: [{ id: { open_id: 'ou_x' } }] }, 'ou_bot')).toEqual({ openId: 'ou_x', name: 'ou_x' });
  });
});

describe('tryHandleGrantCommand (@bot /grant @user)', () => {
  function grantMessage() {
    return {
      message_id: 'om_x', chat_id: 'oc_1',
      content: JSON.stringify({ text: '@_user_1 /grant @_user_2' }),
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Claude' },
        { key: '@_user_2', id: { open_id: 'ou_z' }, name: '张三' },
      ],
    };
  }

  beforeEach(() => {
    replyMock.mockClear();
    pending._resetForTest();
    const bot = registerBot({ larkAppId: 'b1', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['ou_owner'] });
    bot.botOpenId = 'ou_bot';
    bot.resolvedAllowedUsers = ['ou_owner'];
  });
  afterEach(() => vi.restoreAllMocks());

  it('owner: leading @bot is stripped, command matches → pops interactive card + opens pending', async () => {
    const handled = await tryHandleGrantCommand('b1', grantMessage(), 'ou_owner');
    expect(handled).toBe(true);
    // last reply is the interactive card (msgType 'interactive')
    expect(replyMock).toHaveBeenCalled();
    const [, , content, msgType] = replyMock.mock.calls.at(-1)!;
    expect(msgType).toBe('interactive');
    expect(content).toContain('grant_chat');           // card carries grant actions
    expect(pending.checkNonce('b1', 'oc_1', 'ou_z', JSON.parse(content).elements.find((e: any)=>e.tag==='action').actions[0].value.nonce)).toBe(true);
  });

  it('non-owner: replies owner_only, no card', async () => {
    const handled = await tryHandleGrantCommand('b1', grantMessage(), 'ou_intruder');
    expect(handled).toBe(true);
    const [, , content, msgType] = replyMock.mock.calls.at(-1)!;
    expect(msgType ?? 'text').not.toBe('interactive');  // text reply, not a card
    expect(content).toContain('owner');                 // owner_only message text
  });

  it('unrelated message is not intercepted', async () => {
    const msg = { message_id: 'om_y', chat_id: 'oc_1', content: JSON.stringify({ text: '@_user_1 帮我看下代码' }), mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Claude' }] };
    expect(await tryHandleGrantCommand('b1', msg, 'ou_owner')).toBe(false);
  });
});

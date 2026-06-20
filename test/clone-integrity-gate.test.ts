import { describe, expect, it, vi } from 'vitest';
import { CLONE_CORE_SCOPES } from '../src/services/clone-auth-link.js';
import { runCloneIntegrityGate } from '../src/services/clone-integrity-gate.js';

const target = {
  taskId: 'st_1',
  subgroupChatId: 'oc_sub',
  senderAppId: 'app_ceo',
  appId: 'app_clone',
  appSecret: 'sec',
  displayName: '克劳德（初号机）',
  sourceDescription: 'source desc',
  cloneMentionOpenId: 'ou_clone_as_seen_by_ceo',
  senderSelfOpenId: 'ou_ceo_self',
};

describe('runCloneIntegrityGate', () => {
  it('treats unverifiable scope as unknown and blocks delivery', async () => {
    const report = await runCloneIntegrityGate(target, {
      listScopes: async () => ({ ok: false, error: 'network', message: 'timeout' }),
      fetchBotInfo: async () => ({ avatarUrl: 'https://x/a.png' }),
      sendPost: async () => 'om_1',
      ackSeen: () => true,
      sleepMs: async () => {},
      confirmUrgent: async () => ({ item: 'urgent_summon', status: 'pass' }),
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find(c => c.item === 'scope')).toMatchObject({ status: 'unknown' });
  });

  it('sends structured double-mention direct probe and requires ack', async () => {
    let sent = '';
    const report = await runCloneIntegrityGate(target, {
      listScopes: async () => ({ ok: true, granted: [...CLONE_CORE_SCOPES] }),
      fetchBotInfo: async () => ({ avatarUrl: 'https://x/a.png' }),
      sendPost: async (content) => { sent = content; return 'om_1'; },
      ackSeen: (_taskId, _appId, wakeId) => wakeId.startsWith('direct-fixed'),
      sleepMs: async () => {},
      nowId: () => 'fixed',
      confirmUrgent: async () => ({ item: 'urgent_summon', status: 'pass' }),
    });
    expect(report.ok).toBe(true);
    const parsed = JSON.parse(sent);
    expect(parsed.zh_cn.content[0]).toEqual([
      { tag: 'at', user_id: 'ou_ceo_self', user_name: 'sender' },
      { tag: 'text', text: ' ' },
      { tag: 'at', user_id: 'ou_clone_as_seen_by_ceo', user_name: '克劳德（初号机）' },
      { tag: 'text', text: ' [[direct-ack:st_1:direct-fixed]]' },
    ]);
  });

  it('marks missing sender-scoped clone open_id as unknown instead of guessing', async () => {
    const report = await runCloneIntegrityGate({ ...target, cloneMentionOpenId: undefined }, {
      listScopes: async () => ({ ok: true, granted: [...CLONE_CORE_SCOPES] }),
      fetchBotInfo: async () => ({ avatarUrl: 'https://x/a.png' }),
      sleepMs: async () => {},
      confirmUrgent: async () => ({ item: 'urgent_summon', status: 'pass' }),
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find(c => c.item === 'direct_mention')).toMatchObject({ status: 'unknown' });
  });

  it('marks missing trusted description as blocked', async () => {
    const report = await runCloneIntegrityGate({ ...target, sourceDescription: undefined }, {
      listScopes: async () => ({ ok: true, granted: [...CLONE_CORE_SCOPES] }),
      fetchBotInfo: async () => ({ avatarUrl: 'https://x/a.png' }),
      sendPost: async () => 'om_1',
      ackSeen: () => true,
      sleepMs: async () => {},
      confirmUrgent: async () => ({ item: 'urgent_summon', status: 'pass' }),
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find(c => c.item === 'description')).toMatchObject({ status: 'blocked' });
  });
});

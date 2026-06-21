import { describe, expect, it } from 'vitest';
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

function grantStatus(scopes: readonly string[]) {
  const byName = new Map(scopes.map(scopeName => [scopeName, { scopeName, grantStatus: 1 }]));
  return {
    ok: true as const,
    scopes: [...byName.values()],
    byName,
  };
}

const grantPass = async () => grantStatus(CLONE_CORE_SCOPES);

describe('runCloneIntegrityGate', () => {
  it('treats unverifiable scope as unknown and blocks delivery', async () => {
    const report = await runCloneIntegrityGate(target, {
      listScopeGrantStatuses: async () => ({ ok: false, error: 'network', message: 'timeout' }),
      fetchBotInfo: async () => ({ avatarUrl: 'https://x/a.png', description: 'clone desc' }),
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
      listScopeGrantStatuses: grantPass,
      fetchBotInfo: async () => ({ avatarUrl: 'https://x/a.png', description: 'clone desc' }),
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
      listScopeGrantStatuses: grantPass,
      fetchBotInfo: async () => ({ avatarUrl: 'https://x/a.png', description: 'clone desc' }),
      sleepMs: async () => {},
      confirmUrgent: async () => ({ item: 'urgent_summon', status: 'pass' }),
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find(c => c.item === 'direct_mention')).toMatchObject({ status: 'unknown' });
  });

  it('repairs direct mention with a candidate only when the clone acks that real probe', async () => {
    const sent: string[] = [];
    const report = await runCloneIntegrityGate({
      ...target,
      cloneMentionOpenId: undefined,
      cloneMentionCandidates: [{ openId: 'cli_clone_app', source: 'clone_app_id_probe' }],
    }, {
      listScopeGrantStatuses: grantPass,
      fetchBotInfo: async () => ({ avatarUrl: 'https://x/a.png', description: 'clone desc' }),
      sendPost: async (content) => { sent.push(content); return 'om_1'; },
      ackSeen: (_taskId, _appId, wakeId) => wakeId.startsWith('direct-fixed'),
      sleepMs: async () => {},
      nowId: () => 'fixed',
      confirmUrgent: async () => ({ item: 'urgent_summon', status: 'pass' }),
    });
    expect(report.ok).toBe(true);
    expect(report.checks.find(c => c.item === 'direct_mention')).toMatchObject({
      status: 'repaired',
      detail: 'ack via clone_app_id_probe',
    });
    expect(JSON.parse(sent[0]!).zh_cn.content[0][2]).toEqual({
      tag: 'at',
      user_id: 'cli_clone_app',
      user_name: '克劳德（初号机）',
    });
  });

  it('treats ready real open_id as a probe candidate even when a sender-scoped cross-ref is present', async () => {
    const sent: string[] = [];
    const report = await runCloneIntegrityGate({
      ...target,
      cloneMentionCandidates: [{ openId: 'ou_real_clone', source: 'ready_real_open_id_probe' }],
    }, {
      listScopeGrantStatuses: grantPass,
      fetchBotInfo: async () => ({ avatarUrl: 'https://x/a.png', description: 'clone desc' }),
      sendPost: async (content) => { sent.push(content); return 'om_1'; },
      ackSeen: (_taskId, _appId, wakeId) => wakeId === 'direct-real',
      sleepMs: async () => {},
      nowId: (() => {
        const ids = ['stale', 'real'];
        return () => ids.shift() ?? 'extra';
      })(),
      confirmUrgent: async () => ({ item: 'urgent_summon', status: 'pass' }),
    });
    expect(report.ok).toBe(true);
    expect(report.checks.find(c => c.item === 'direct_mention')).toMatchObject({
      status: 'repaired',
      detail: 'ack via ready_real_open_id_probe',
    });
    expect(JSON.parse(sent[0]!).zh_cn.content[0][2].user_id).toBe('ou_clone_as_seen_by_ceo');
    expect(JSON.parse(sent[1]!).zh_cn.content[0][2].user_id).toBe('ou_real_clone');
  });

  it('passes scope when application/v6/scopes grant_status=1 proves clone core scopes', async () => {
    const report = await runCloneIntegrityGate(target, {
      listScopeGrantStatuses: grantPass,
      fetchBotInfo: async () => ({ avatarUrl: 'https://x/a.png', description: 'clone desc' }),
      sendPost: async () => 'om_1',
      ackSeen: () => true,
      sleepMs: async () => {},
      confirmUrgent: async () => ({ item: 'urgent_summon', status: 'pass' }),
    });
    expect(report.ok).toBe(true);
    expect(report.checks.find(c => c.item === 'scope')).toMatchObject({
      status: 'pass',
      detail: expect.stringContaining('source=application/v6/scopes grantedStatus=1'),
    });
  });

  it('blocks scope when im:message.group_msg grant_status is not 1', async () => {
    const scopes = CLONE_CORE_SCOPES.filter(s => s !== 'im:message.group_msg');
    const byName = new Map(grantStatus(scopes).scopes.map(scope => [scope.scopeName, scope]));
    byName.set('im:message.group_msg', { scopeName: 'im:message.group_msg', grantStatus: 2 });
    const report = await runCloneIntegrityGate(target, {
      listScopeGrantStatuses: async () => ({ ok: true, scopes: [...byName.values()], byName }),
      fetchBotInfo: async () => ({ avatarUrl: 'https://x/a.png', description: 'clone desc' }),
      sendPost: async () => 'om_1',
      ackSeen: () => true,
      sleepMs: async () => {},
      confirmUrgent: async () => ({ item: 'urgent_summon', status: 'pass' }),
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find(c => c.item === 'scope')).toMatchObject({
      status: 'blocked',
      detail: expect.stringContaining('im:message.group_msg:grant_status=2'),
    });
    expect(report.checks.find(c => c.item === 'scope')?.detail).toContain('publish a new app version');
  });

  it('keeps scope unknown when application/v6 scopes grant-status check is inconclusive', async () => {
    const report = await runCloneIntegrityGate(target, {
      listScopeGrantStatuses: async () => ({ ok: false, error: 'unknown', message: 'application/v6 scopes failed' }),
      fetchBotInfo: async () => ({ avatarUrl: 'https://x/a.png', description: 'clone desc' }),
      sendPost: async () => 'om_1',
      ackSeen: () => true,
      sleepMs: async () => {},
      confirmUrgent: async () => ({ item: 'urgent_summon', status: 'pass' }),
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find(c => c.item === 'scope')).toMatchObject({
      status: 'unknown',
      detail: expect.stringContaining('application/v6/scopes grant_status check failed'),
    });
  });

  it('marks missing trusted description as blocked', async () => {
    const report = await runCloneIntegrityGate({ ...target, sourceDescription: undefined }, {
      listScopeGrantStatuses: grantPass,
      fetchBotInfo: async () => ({ avatarUrl: 'https://x/a.png', description: 'clone desc' }),
      sendPost: async () => 'om_1',
      ackSeen: () => true,
      sleepMs: async () => {},
      confirmUrgent: async () => ({ item: 'urgent_summon', status: 'pass' }),
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find(c => c.item === 'description')).toMatchObject({ status: 'blocked' });
  });

  it('blocks when clone app description cannot be read or is empty', async () => {
    const report = await runCloneIntegrityGate(target, {
      listScopeGrantStatuses: grantPass,
      fetchBotInfo: async () => ({ avatarUrl: 'https://x/a.png', description: '' }),
      sendPost: async () => 'om_1',
      ackSeen: () => true,
      sleepMs: async () => {},
      confirmUrgent: async () => ({ item: 'urgent_summon', status: 'pass' }),
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find(c => c.item === 'description')).toMatchObject({ status: 'blocked' });
  });
});

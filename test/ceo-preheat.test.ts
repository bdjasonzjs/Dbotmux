import { describe, it, expect } from 'vitest';
import {
  buildPreheatSummon,
  preheatConfirmOnline,
  PREHEAT_MAX_ATTEMPTS,
  PREHEAT_ATTEMPT_WINDOW_MS,
  PREHEAT_POLL_INTERVAL_MS,
  type PreheatDeps,
  type PreheatTarget,
} from '../src/services/ceo-preheat.js';

const TARGET: PreheatTarget = {
  taskId: 'st_x',
  subgroupChatId: 'oc_sub',
  appId: 'cli_clone',
  displayName: '蔻黛克斯（初号机）',
};

function baseDeps(over: Partial<PreheatDeps> = {}): { d: PreheatDeps; sent: string[] } {
  const sent: string[] = [];
  const d: PreheatDeps = {
    relayDeliveryReady: () => ({ ok: true }),
    sendOwnerSummon: async (_chat, text) => { sent.push(text); return { ok: true }; },
    sleep: async () => { /* no real delay in tests */ },
    genWakeId: () => 'wake1',
    ackSeen: () => false,
    ...over,
  };
  return { d, sent };
}

describe('buildPreheatSummon', () => {
  it('点名 displayName、嵌 wake-ack 令牌、attempt+nonce 进文案', () => {
    const s = buildPreheatSummon('蔻黛克斯（初号机）', 'st_x', 'wake1', 2, 'ab12');
    expect(s).toContain('急急如律令：【蔻黛克斯（初号机）】');
    expect(s).toContain('[[wake-ack:st_x:wake1]]');
    expect(s).toContain('预热#2·ab12');
  });
});

describe('preheatConfirmOnline', () => {
  const pollsPerAttempt = Math.ceil(PREHEAT_ATTEMPT_WINDOW_MS / PREHEAT_POLL_INTERVAL_MS);

  it('回执已出 → ok，attempts=1，只发一次', async () => {
    const { d, sent } = baseDeps({ ackSeen: () => true });
    const res = await preheatConfirmOnline(d, TARGET);
    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(1);
    expect(sent.length).toBe(1);
  });

  it('始终无回执 → 耗尽 MAX_ATTEMPTS、ok=false、每次都是新内容（含递增 attempt + 各异 nonce）', async () => {
    const { d, sent } = baseDeps({ ackSeen: () => false });
    const res = await preheatConfirmOnline(d, TARGET);
    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(PREHEAT_MAX_ATTEMPTS);
    expect(sent.length).toBe(PREHEAT_MAX_ATTEMPTS);
    // 每条都不同（attempt nonce 防 Base/飞书按同内容 dedup）
    expect(new Set(sent).size).toBe(PREHEAT_MAX_ATTEMPTS);
    // 但 wakeId 全程稳定（绑同一次预热）
    for (const t of sent) expect(t).toContain('[[wake-ack:st_x:wake1]]');
  });

  it('第 2 attempt 才出回执 → ok、attempts=2', async () => {
    let polls = 0;
    // 第 1 attempt 共轮询 pollsPerAttempt 次（皆 false），第 2 attempt 第 1 次轮询变 true。
    const { d } = baseDeps({ ackSeen: () => { polls += 1; return polls >= pollsPerAttempt + 1; } });
    const res = await preheatConfirmOnline(d, TARGET);
    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(2);
  });

  it('Base relay 慢回执在单 attempt 长窗口内到达 → 不误判 blocked', async () => {
    let polls = 0;
    const { d } = baseDeps({
      sendOwnerSummon: async () => ({ ok: true, recordId: 'rec_1' }),
      ackSeen: () => { polls += 1; return polls >= Math.floor(pollsPerAttempt / 2); },
    });
    const res = await preheatConfirmOnline(d, TARGET);
    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(1);
    expect(res.recordIds).toEqual(['rec_1']);
  });

  it('send 失败也不抛、继续按窗口轮询回执（poll 超时不当失败）', async () => {
    const { d } = baseDeps({ sendOwnerSummon: async () => ({ ok: false, error: 'upsert failed' }), ackSeen: () => true });
    const res = await preheatConfirmOnline(d, TARGET);
    expect(res.ok).toBe(true); // 回执才是成功信号，send 失败不阻断
  });

  it('Base automation delivery shape 未验证时 fail-closed，不用 Base record/可见卡片代替 clone ack', async () => {
    const { d, sent } = baseDeps({
      relayDeliveryReady: () => ({ ok: false, error: 'automation still sends interactive card' }),
    });
    const res = await preheatConfirmOnline(d, TARGET);
    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(0);
    expect(res.error).toContain('interactive card');
    expect(sent).toEqual([]);
  });
});

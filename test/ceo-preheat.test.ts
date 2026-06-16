import { describe, it, expect } from 'vitest';
import {
  buildPreheatSummon,
  preheatConfirmOnline,
  PREHEAT_MAX_ATTEMPTS,
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
    // 第 1 attempt 共轮询 10 次（皆 false），第 2 attempt 第 1 次轮询（第 11 次）变 true。
    const { d } = baseDeps({ ackSeen: () => { polls += 1; return polls >= 11; } });
    const res = await preheatConfirmOnline(d, TARGET);
    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(2);
  });

  it('send 失败也不抛、继续按窗口轮询回执（poll 超时不当失败）', async () => {
    const { d } = baseDeps({ sendOwnerSummon: async () => ({ ok: false, error: 'upsert failed' }), ackSeen: () => true });
    const res = await preheatConfirmOnline(d, TARGET);
    expect(res.ok).toBe(true); // 回执才是成功信号，send 失败不阻断
  });
});

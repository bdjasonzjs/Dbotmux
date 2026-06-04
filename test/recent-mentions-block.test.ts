/**
 * Tests for buildRecentMentionsBlock —「被圈时间感知」prompt 块 (2026-06-04 邹劲松要求,
 * 含蔻黛克斯 review Finding 1 的权威判定回归)。
 *
 * 覆盖：
 *  - text self mention → 记录 + 注入块
 *  - 仅 other bot mention → 不记录、不注入
 *  - 权威 selfMentionedThisTurn=true 即使 message.mentions 为空（模拟 post inline at）→ 记录 + 注入
 *  - selfMentionedThisTurn=false 覆盖 text self mention → 不注入
 *  - 缺 chatId / selfOpenId → 不注入
 *  - 最新在前
 *
 * Run:  pnpm vitest run test/recent-mentions-block.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { LarkMention } from '../src/types.js';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

const SELF = 'ou_self';
const OTHER = 'ou_other';
const APP = 'app_test';
const CHAT = 'oc_test';

async function fresh() {
  vi.resetModules();
  const sm = await import('../src/core/session-manager.js');
  const store = await import('../src/services/mention-history-store.js');
  return { sm, store };
}

const selfMention: LarkMention[] = [{ key: '@_1', name: 'Self', openId: SELF }];
const otherMention: LarkMention[] = [{ key: '@_1', name: 'Other', openId: OTHER }];

describe('buildRecentMentionsBlock', () => {
  let prevDataDir: string | undefined;

  beforeEach(() => {
    prevDataDir = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = mkdtempSync(join(tmpdir(), 'botmux-rm-block-'));
  });

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
    else process.env.SESSION_DATA_DIR = prevDataDir;
  });

  it('text self mention → records and injects block', async () => {
    const { sm, store } = await fresh();
    const out = sm.buildRecentMentionsBlock(APP, CHAT, SELF, selfMention, 1000);
    expect(out).toContain('<recent_mentions');
    expect(store.getRecentMentions(APP, CHAT)).toEqual([1000]);
  });

  it('only other-bot mention → no block, no record', async () => {
    const { sm, store } = await fresh();
    const out = sm.buildRecentMentionsBlock(APP, CHAT, SELF, otherMention, 1000);
    expect(out).toBe('');
    expect(store.getRecentMentions(APP, CHAT)).toEqual([]);
  });

  it('authoritative selfMentionedThisTurn=true with empty mentions (post inline at) → records and injects', async () => {
    const { sm, store } = await fresh();
    const out = sm.buildRecentMentionsBlock(APP, CHAT, SELF, [], 1000, true);
    expect(out).toContain('<recent_mentions');
    expect(store.getRecentMentions(APP, CHAT)).toEqual([1000]);
  });

  it('selfMentionedThisTurn=false overrides a text self mention → no block', async () => {
    const { sm, store } = await fresh();
    const out = sm.buildRecentMentionsBlock(APP, CHAT, SELF, selfMention, 1000, false);
    expect(out).toBe('');
    expect(store.getRecentMentions(APP, CHAT)).toEqual([]);
  });

  it('missing chatId or selfOpenId → no block', async () => {
    const { sm } = await fresh();
    expect(sm.buildRecentMentionsBlock(APP, undefined, SELF, selfMention, 1000, true)).toBe('');
    expect(sm.buildRecentMentionsBlock(APP, CHAT, undefined, selfMention, 1000, true)).toBe('');
  });

  // Finding 2 回归：延迟 repo 路径最终也调 buildNewTopicPrompt(..., selfMentionedThisTurn)。
  // 这里直接验证 builder 把权威参数(=true)+空 mentions(模拟 post inline at) 注入了块。
  it('buildNewTopicPrompt injects block when selfMentionedThisTurn=true with empty mentions', async () => {
    const { sm } = await fresh();
    const out = sm.buildNewTopicPrompt(
      'hi', 'sess_1', 'claude-code', undefined,
      undefined, // attachments
      [],        // mentions empty (post inline at 场景)
      undefined, // availableBots
      undefined, // followUps
      { name: 'Self', openId: SELF }, // botIdentity → selfOpenId
      undefined, // locale
      undefined, // sender
      CHAT,      // chatId
      APP,       // larkAppId
      undefined, // ambientContextBlock
      true,      // selfMentionedThisTurn (权威)
    );
    expect(out).toContain('<recent_mentions');
  });

  it('buildNewTopicPrompt omits block when selfMentionedThisTurn=false', async () => {
    const { sm } = await fresh();
    const out = sm.buildNewTopicPrompt(
      'hi', 'sess_1', 'claude-code', undefined,
      undefined, selfMention, undefined, undefined,
      { name: 'Self', openId: SELF }, undefined, undefined,
      CHAT, APP, undefined,
      false, // 权威 false 覆盖 text self mention
    );
    expect(out).not.toContain('<recent_mentions');
  });

  it('lists newest first', async () => {
    const { sm } = await fresh();
    sm.buildRecentMentionsBlock(APP, CHAT, SELF, selfMention, 1000, true);
    sm.buildRecentMentionsBlock(APP, CHAT, SELF, selfMention, 5000, true);
    const out = sm.buildRecentMentionsBlock(APP, CHAT, SELF, selfMention, 3000, true);
    const fmt = (ms: number) => new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const idx5000 = out.indexOf(fmt(5000));
    const idx3000 = out.indexOf(fmt(3000));
    const idx1000 = out.indexOf(fmt(1000));
    expect(idx5000).toBeGreaterThan(-1);
    expect(idx5000).toBeLessThan(idx3000); // 5000 newest → appears first
    expect(idx3000).toBeLessThan(idx1000);
  });
});

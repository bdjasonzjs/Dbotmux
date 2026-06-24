/**
 * 一期地基 · chat-policy-store 单测。
 * Run: pnpm vitest run test/chat-policy-store.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: { get session() { return { dataDir: tempDir }; } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

async function freshImport() {
  vi.resetModules();
  return await import('../src/services/chat-policy-store.js');
}

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'chat-policy-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('chat-policy-store', () => {
  it('setPolicy/getPolicy round trip + 局部 patch 保留其他字段', async () => {
    const s = await freshImport();
    s.setPolicy('oc_a', {
      scoutMode: 'mute',
      reportTargetChatId: 'oc_target',
      driveOn: true,
      driveGoal: '目标',
      driveMentionOpenId: 'ou_ceo',
      driveUntil: 1782362400000,
      driveMaxPerDay: 20,
    });
    let p = s.getPolicy('oc_a')!;
    expect(p.scoutMode).toBe('mute');
    expect(p.reportTargetChatId).toBe('oc_target');
    expect(p.driveOn).toBe(true);
    expect(s.getDriveConfig('oc_a')).toMatchObject({
      enabled: true,
      goal: '目标',
      mentionOpenId: 'ou_ceo',
      until: 1782362400000,
      maxPerDay: 20,
    });
    // 局部 patch 只改 scout，其余不动
    s.setPolicy('oc_a', { scoutMode: 'watch' });
    p = s.getPolicy('oc_a')!;
    expect(p.scoutMode).toBe('watch');
    expect(p.reportTargetChatId).toBe('oc_target'); // 保留
    expect(p.driveOn).toBe(true);                   // 保留
  });

  it('新建群默认 driveOn=false / report=off / scout=watch', async () => {
    const s = await freshImport();
    s.setPolicy('oc_new', { driveGoal: 'x' });
    const p = s.getPolicy('oc_new')!;
    expect(p.driveOn).toBe(false);
    expect(p.reportTargetChatId).toBe(null);
    expect(p.scoutMode).toBe('watch');
  });

  it('主话题默认静音（无任何配置时也在 muted 名单）', async () => {
    const s = await freshImport();
    expect(s.getScoutMutedChatIds()).toContain(s.MAIN_TOPIC_CHAT_ID);
    expect(s.isScoutMuted(s.MAIN_TOPIC_CHAT_ID)).toBe(true);
  });

  it('主话题只配置推动时仍默认 scout=mute', async () => {
    const s = await freshImport();
    s.setPolicy(s.MAIN_TOPIC_CHAT_ID, { driveOn: true, driveGoal: '推进 CEO' });
    expect(s.getPolicy(s.MAIN_TOPIC_CHAT_ID)!.scoutMode).toBe('mute');
    expect(s.getScoutMutedChatIds()).toContain(s.MAIN_TOPIC_CHAT_ID);
  });

  it('显式 scout=mute 的群进 muted 名单；普通 watch 群不在', async () => {
    const s = await freshImport();
    s.setPolicy('oc_noise', { scoutMode: 'mute' });
    s.setPolicy('oc_normal', { scoutMode: 'watch' });
    const muted = s.getScoutMutedChatIds();
    expect(muted).toContain('oc_noise');
    expect(muted).not.toContain('oc_normal');
  });

  it('主话题显式设 watch 可覆盖默认静音', async () => {
    const s = await freshImport();
    s.setPolicy(s.MAIN_TOPIC_CHAT_ID, { scoutMode: 'watch' });
    expect(s.getScoutMutedChatIds()).not.toContain(s.MAIN_TOPIC_CHAT_ID);
  });

  it('fail-closed：配置文件损坏 → 只返回兜底静音名单（主话题仍被排除）', async () => {
    const s = await freshImport();
    // 先写一条合法策略放出主话题
    s.setPolicy(s.MAIN_TOPIC_CHAT_ID, { scoutMode: 'watch' });
    expect(s.getScoutMutedChatIds()).not.toContain(s.MAIN_TOPIC_CHAT_ID);
    // 损坏配置文件
    writeFileSync(join(tempDir, 'chat-policies.json'), '{ this is not json', 'utf-8');
    const muted = s.getScoutMutedChatIds();
    expect(muted).toEqual([...s.DEFAULT_MUTED_CHAT_IDS]); // 不信任损坏配置里的 watch override
    expect(muted).toContain(s.MAIN_TOPIC_CHAT_ID);
  });

  it('removePolicy / getReportTarget / isDriveOn', async () => {
    const s = await freshImport();
    s.setPolicy('oc_a', { reportTargetChatId: 'oc_t', driveOn: true });
    expect(s.getReportTarget('oc_a')).toBe('oc_t');
    expect(s.isDriveOn('oc_a')).toBe(true);
    expect(s.removePolicy('oc_a')).toBe(true);
    expect(s.getPolicy('oc_a')).toBe(null);
    expect(s.getReportTarget('oc_a')).toBe(null);
    expect(s.isDriveOn('oc_a')).toBe(false);
    expect(s.removePolicy('oc_a')).toBe(false); // 再删不存在
  });
});

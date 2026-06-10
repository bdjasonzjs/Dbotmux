/**
 * Unit tests for chat-mode-store: get default / set chat / set work / 持久化 / 容错。
 * Run: pnpm vitest run test/chat-mode-store.test.ts
 *
 * Strategy: 同 chat-context-store.test —— config.session.dataDir 指向 per-test 临时目录。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: { get session() { return { dataDir: tempDir }; } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

async function freshImport() {
  vi.resetModules();
  return await import('../src/services/chat-mode-store.js');
}

describe('chat-mode-store', () => {
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'chat-mode-store-test-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('缺文件 → 默认 work', async () => {
    const s = await freshImport();
    expect(s.getChatMode('oc_x')).toBe('work');
  });

  it('缺 chatId（undefined / 空串）→ work，绝不当闲聊群', async () => {
    const s = await freshImport();
    expect(s.getChatMode(undefined)).toBe('work');
    expect(s.getChatMode('')).toBe('work');
  });

  it('setChatMode chat → getChatMode 返回 chat，并落盘', async () => {
    const s = await freshImport();
    s.setChatMode('oc_chat', 'chat');
    expect(s.getChatMode('oc_chat')).toBe('chat');
    expect(existsSync(join(tempDir, 'chat-modes', 'oc_chat.json'))).toBe(true);
  });

  it('chat → work 切回', async () => {
    const s = await freshImport();
    s.setChatMode('oc_y', 'chat');
    expect(s.getChatMode('oc_y')).toBe('chat');
    s.setChatMode('oc_y', 'work');
    expect(s.getChatMode('oc_y')).toBe('work');
  });

  it('两个群互不影响', async () => {
    const s = await freshImport();
    s.setChatMode('oc_a', 'chat');
    expect(s.getChatMode('oc_a')).toBe('chat');
    expect(s.getChatMode('oc_b')).toBe('work');
  });

  it('损坏的文件 → 容错默认 work（不抛）', async () => {
    const s = await freshImport();
    mkdirSync(join(tempDir, 'chat-modes'), { recursive: true });
    writeFileSync(join(tempDir, 'chat-modes', 'oc_bad.json'), 'not json{', 'utf-8');
    expect(s.getChatMode('oc_bad')).toBe('work');
  });
});

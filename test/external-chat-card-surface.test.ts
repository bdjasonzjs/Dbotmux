/**
 * 外部群（Lark chat.get `external: true`）里的会话卡不渲染任何操作按钮：
 * 显示输出 / 打开终端 / 获取操作链接 / 关闭会话（以及同排的导出/刷新/本地 CLI/
 * 重启/断开 和快捷键排）全部省略；内部群 / p2p 保持原样。
 *
 * Run:  pnpm vitest run test/external-chat-card-surface.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({ config: {} }),
  getAllBots: () => [],
}));
vi.mock('../src/config.js', () => ({
  config: { dashboard: {}, web: {}, daemon: {} },
}));
vi.mock('../src/services/session-store.js', () => ({
  updateSession: vi.fn(),
}));
vi.mock('../src/im/lark/client.js', () => ({
  getChatMode: vi.fn(async () => 'group'),
}));

import { buildSessionCard, buildStreamingCard } from '../src/im/lark/card-builder.js';
import { globalConfigPath } from '../src/global-config.js';
import * as sessionStore from '../src/services/session-store.js';
import * as larkClient from '../src/im/lark/client.js';
import { setChatExternal, getCachedChatExternal, _resetChatExternalCacheForTests } from '../src/im/lark/chat-external-cache.js';
import { isExternalChatSession } from '../src/core/external-chat.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'botmux-external-card-'));
  vi.stubEnv('HOME', home);
  mkdirSync(dirname(globalConfigPath()), { recursive: true });
  vi.mocked(sessionStore.updateSession).mockClear();
  _resetChatExternalCacheForTests();
  vi.mocked(larkClient.getChatMode).mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const parse = (json: string) => JSON.parse(json);
const allButtons = (card: any): any[] =>
  card.elements.filter((e: any) => e.tag === 'action').flatMap((e: any) => e.actions);
const labels = (card: any): string[] => allButtons(card).map((b: any) => b.text.content);

const SID = 'sess-ext';
const ROOT = 'om_root_ext';
const URL = 'https://example.com/terminal';
const TITLE = '外部群任务';

describe('buildSessionCard · externalChat', () => {
  it('internal (default): keeps 打开终端 / 获取操作链接 / 关闭会话', () => {
    const card = parse(buildSessionCard(SID, ROOT, URL, TITLE, 'claude-code'));
    const l = labels(card);
    expect(l.some(x => x.includes('终端'))).toBe(true);
    expect(l.some(x => x.includes('获取操作链接'))).toBe(true);
    expect(l.some(x => x.includes('关闭会话'))).toBe(true);
  });

  it('external: header kept, zero buttons', () => {
    const card = parse(buildSessionCard(
      SID, ROOT, URL, TITLE, 'claude-code', undefined, false, undefined, true, undefined,
      /* externalChat */ true,
    ));
    expect(card.header.title.content).toContain(TITLE);
    expect(card.elements.filter((e: any) => e.tag === 'action')).toHaveLength(0);
    expect(JSON.stringify(card)).not.toContain(URL);
  });
});

describe('buildStreamingCard · externalChat', () => {
  const CONTENT = '$ pnpm test\nAll passed';

  it('internal (default) hidden mode: exactly the four group buttons', () => {
    const card = parse(buildStreamingCard(SID, ROOT, URL, TITLE, CONTENT, 'working', 'claude-code', 'hidden'));
    const l = labels(card);
    expect(l.some(x => x.includes('显示输出'))).toBe(true);
    expect(l.some(x => x.includes('终端'))).toBe(true);
    expect(l.some(x => x.includes('获取操作链接'))).toBe(true);
    expect(l.some(x => x.includes('关闭会话'))).toBe(true);
  });

  it('external hidden mode: header + body only, no action rows at all', () => {
    const card = parse(buildStreamingCard(
      SID, ROOT, URL, TITLE, CONTENT, 'working', 'claude-code', 'hidden',
      'nonce', undefined, false, false, undefined, undefined, undefined, true, undefined, undefined, undefined,
      /* externalChat */ true,
    ));
    expect(card.header.title.content).toContain(TITLE);
    expect(card.elements.filter((e: any) => e.tag === 'action')).toHaveLength(0);
    expect(allButtons(card)).toHaveLength(0);
    expect(JSON.stringify(card)).not.toContain(URL);
  });

  it('external screenshot mode: no toggle/export/refresh and no quick-key rows', () => {
    const card = parse(buildStreamingCard(
      SID, ROOT, URL, TITLE, CONTENT, 'working', 'claude-code', 'screenshot',
      'nonce', 'img_key_1', false, false, undefined, undefined, undefined, false, undefined, undefined, undefined,
      true,
    ));
    expect(card.elements.filter((e: any) => e.tag === 'action')).toHaveLength(0);
    // Body (screenshot) still renders.
    expect(JSON.stringify(card)).toContain('img_key_1');
  });

  it('external adopt session: no 接管 / 断开 either', () => {
    const card = parse(buildStreamingCard(
      SID, ROOT, URL, TITLE, CONTENT, 'working', 'claude-code', 'hidden',
      'nonce', undefined, /* adoptMode */ true, /* showTakeover */ true, undefined, undefined, undefined, false, undefined, undefined, undefined,
      true,
    ));
    expect(allButtons(card)).toHaveLength(0);
  });

  it('external: the explicit opt-in group-visible writable link is left alone', () => {
    const card = parse(buildStreamingCard(
      SID, ROOT, URL, TITLE, CONTENT, 'working', 'claude-code', 'hidden',
      'nonce', undefined, false, false, undefined, undefined, 'https://example.com/write?t=x', false, undefined, undefined, undefined,
      true,
    ));
    expect(allButtons(card)).toHaveLength(0);
    expect(JSON.stringify(card)).toContain('https://example.com/write?t=x');
  });
});

describe('isExternalChatSession', () => {
  const mk = (over: Partial<{ chatType: 'group' | 'p2p'; externalChat: boolean | undefined }> = {}) => ({
    larkAppId: 'cli_app',
    chatId: 'oc_chat',
    chatType: over.chatType ?? 'group',
    session: { sessionId: 's1', chatId: 'oc_chat', chatType: over.chatType ?? 'group', externalChat: over.externalChat } as any,
  });

  it('p2p is never external (even with the chat cached as external)', async () => {
    setChatExternal('cli_app', 'oc_chat', true);
    const ds = mk({ chatType: 'p2p' });
    expect(isExternalChatSession(ds)).toBe(false);
    expect(ds.session.externalChat).toBeUndefined();
    await new Promise(r => setTimeout(r, 0));
    expect(larkClient.getChatMode).not.toHaveBeenCalled();
  });

  it('persisted session.externalChat wins over the cache', () => {
    setChatExternal('cli_app', 'oc_chat', false);
    expect(isExternalChatSession(mk({ externalChat: true }))).toBe(true);
    expect(sessionStore.updateSession).not.toHaveBeenCalled();
  });

  it('cache hit → returned and written back onto the session record', async () => {
    setChatExternal('cli_app', 'oc_chat', true);
    const ds = mk();
    expect(isExternalChatSession(ds)).toBe(true);
    expect(ds.session.externalChat).toBe(true);
    expect(sessionStore.updateSession).toHaveBeenCalledWith(ds.session);
    await new Promise(r => setTimeout(r, 0));
    expect(larkClient.getChatMode).not.toHaveBeenCalled();
  });

  it('cache hit false → internal, still persisted so restarts do not re-query', () => {
    setChatExternal('cli_app', 'oc_chat', false);
    const ds = mk();
    expect(isExternalChatSession(ds)).toBe(false);
    expect(ds.session.externalChat).toBe(false);
    expect(sessionStore.updateSession).toHaveBeenCalledTimes(1);
  });

  it('unknown → renders internal now and kicks ONE throttled background refresh', async () => {
    const ds = mk();
    ds.chatId = 'oc_unknown_' + Math.random().toString(36).slice(2);
    ds.session.chatId = ds.chatId;
    expect(getCachedChatExternal('cli_app', ds.chatId)).toBeUndefined();
    expect(isExternalChatSession(ds)).toBe(false);
    expect(isExternalChatSession(ds)).toBe(false);
    expect(ds.session.externalChat).toBeUndefined();
    expect(sessionStore.updateSession).not.toHaveBeenCalled();
    await new Promise(r => setTimeout(r, 0));
    expect(larkClient.getChatMode).toHaveBeenCalledTimes(1);
    expect(larkClient.getChatMode).toHaveBeenCalledWith('cli_app', ds.chatId, { forceRefresh: true });
  });
});

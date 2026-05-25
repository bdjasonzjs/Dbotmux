/**
 * P3 commit #2 — tilly-scout tests.
 *
 * Run:  pnpm vitest run test/tilly-scout.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: { get session() { return { dataDir: tempDir }; } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

async function freshImports() {
  vi.resetModules();
  return {
    scout: await import('../src/services/tilly-scout.js'),
    store: await import('../src/services/tilly-message-store.js'),
  };
}

/** Spawn a fake lark-cli at a temp path that returns the given JSON to stdout. */
function makeFakeLarkCli(responseJson: object): string {
  const fp = join(tempDir, 'fake-lark-cli.sh');
  const body = `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(responseJson)}\nEOF\n`;
  writeFileSync(fp, body, 'utf-8');
  chmodSync(fp, 0o755);
  return fp;
}

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'tilly-scout-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('tilly-scout (P3 commit #2)', () => {
  it('fetches messages and returns normalized shape', async () => {
    const fake = makeFakeLarkCli({
      ok: true,
      data: {
        messages: [
          {
            message_id: 'om_a', chat_id: 'oc_x', chat_name: 'X', chat_type: 'group',
            msg_type: 'text', content: 'hello',
            sender: { id: 'ou_user', sender_type: 'user' },
            create_time: '2026-05-24 23:00',
          },
        ],
        total: 1, has_more: false,
      },
    });
    const { scout } = await freshImports();
    const r = await scout.fetchRecentMessages({
      start: new Date('2026-05-24T22:45:00Z'),
      end: new Date('2026-05-24T23:00:00Z'),
      larkCliPath: fake,
    });
    expect(r).toHaveLength(1);
    expect(r[0].messageId).toBe('om_a');
    expect(r[0].chatId).toBe('oc_x');
    expect(r[0].senderType).toBe('user');
    expect(r[0].content).toBe('hello');
  });

  it('dedups already-scanned messages', async () => {
    const fake = makeFakeLarkCli({
      ok: true,
      data: {
        messages: [
          { message_id: 'om_seen', chat_id: 'oc_x', chat_name: 'X', chat_type: 'group', msg_type: 'text', content: 'old', sender: { id: 'u1', sender_type: 'user' }, create_time: '' },
          { message_id: 'om_new',  chat_id: 'oc_x', chat_name: 'X', chat_type: 'group', msg_type: 'text', content: 'new', sender: { id: 'u1', sender_type: 'user' }, create_time: '' },
        ],
        total: 2,
      },
    });
    const { scout, store } = await freshImports();
    store.markScanned(['om_seen']);
    const r = await scout.fetchRecentMessages({
      start: new Date(0), end: new Date(), larkCliPath: fake,
    });
    expect(r.map(m => m.messageId)).toEqual(['om_new']);
  });

  it('excludeChatIds filters out unwanted chats', async () => {
    const fake = makeFakeLarkCli({
      ok: true,
      data: {
        messages: [
          { message_id: 'om_keep', chat_id: 'oc_keep', chat_name: 'K', chat_type: 'group', msg_type: 'text', content: 'a', sender: { id: 'u1', sender_type: 'user' }, create_time: '' },
          { message_id: 'om_drop', chat_id: 'oc_drop', chat_name: 'D', chat_type: 'group', msg_type: 'text', content: 'b', sender: { id: 'u1', sender_type: 'user' }, create_time: '' },
        ],
      },
    });
    const { scout } = await freshImports();
    const r = await scout.fetchRecentMessages({
      start: new Date(0), end: new Date(),
      excludeChatIds: ['oc_drop'],
      larkCliPath: fake,
    });
    expect(r.map(m => m.messageId)).toEqual(['om_keep']);
  });

  describe('P0-1 privacy filter (2026-05-25)', () => {
    const mkMsg = (id: string, chatType: 'group' | 'p2p', chatId: string) => ({
      message_id: id, chat_id: chatId, chat_name: 'X', chat_type: chatType,
      msg_type: 'text', content: 'x',
      sender: { id: 'u1', sender_type: 'user' }, create_time: '',
    });

    it('default: drops p2p, keeps group', async () => {
      const fake = makeFakeLarkCli({ ok: true, data: { messages: [
        mkMsg('om_g', 'group', 'oc_g'),
        mkMsg('om_p', 'p2p', 'oc_p'),
      ] } });
      const { scout } = await freshImports();
      const r = await scout.fetchRecentMessages({ start: new Date(0), end: new Date(), larkCliPath: fake });
      expect(r.map(m => m.messageId)).toEqual(['om_g']);
    });

    it('includeP2P=true: keeps both group and p2p', async () => {
      const fake = makeFakeLarkCli({ ok: true, data: { messages: [
        mkMsg('om_g', 'group', 'oc_g'),
        mkMsg('om_p', 'p2p', 'oc_p'),
      ] } });
      const { scout } = await freshImports();
      const r = await scout.fetchRecentMessages({
        start: new Date(0), end: new Date(), larkCliPath: fake, includeP2P: true,
      });
      expect(r.map(m => m.messageId).sort()).toEqual(['om_g', 'om_p']);
    });

    it('allowlist mode: only matched chatIds kept (groups), allowlist p2p ALSO kept (override gate)', async () => {
      // 2026-05-25 妹妹 non-blocker 1: allowlist 命中 = 显式同意 → 包含 p2p
      const fake = makeFakeLarkCli({ ok: true, data: { messages: [
        mkMsg('om_allow_g', 'group', 'oc_allow_g'),
        mkMsg('om_allow_p', 'p2p', 'oc_allow_p'),
        mkMsg('om_other_g', 'group', 'oc_other_g'),
        mkMsg('om_other_p', 'p2p', 'oc_other_p'),
      ] } });
      const { scout } = await freshImports();
      const r = await scout.fetchRecentMessages({
        start: new Date(0), end: new Date(), larkCliPath: fake,
        allowlistChatIds: ['oc_allow_g', 'oc_allow_p'],
        // includeP2P 不设；allowlist 命中的 p2p 仍应通过
      });
      expect(r.map(m => m.messageId).sort()).toEqual(['om_allow_g', 'om_allow_p']);
    });
  });

  describe('v2.1 bot-sender 双维 allowlist (2026-05-26 松松/妹妹 P0)', () => {
    const mkMsg = (id: string, chatId: string, senderId: string, senderType: 'user' | 'app' | 'bot') => ({
      message_id: id, chat_id: chatId, chat_name: 'X', chat_type: 'group',
      msg_type: 'text', content: 'x',
      sender: { id: senderId, sender_type: senderType }, create_time: '',
    });

    it('default: 所有 bot/app sender drop, 人类消息保留', async () => {
      const fake = makeFakeLarkCli({ ok: true, data: { messages: [
        mkMsg('om_human', 'oc_x', 'ou_user1', 'user'),
        mkMsg('om_bot_app', 'oc_x', 'cli_a9771799e8bb5bc3', 'app'),
        mkMsg('om_bot_typed', 'oc_x', 'cli_other', 'bot'),
      ] } });
      const { scout } = await freshImports();
      const r = await scout.fetchRecentMessages({ start: new Date(0), end: new Date(), larkCliPath: fake });
      expect(r.map(m => m.messageId)).toEqual(['om_human']);
    });

    it('断 self-reference loop: 缇蕾 + 克劳德 + 任何 bot 在主话题发的 notify text 都不再进 LLM input', async () => {
      const fake = makeFakeLarkCli({ ok: true, data: { messages: [
        mkMsg('om_user', 'oc_flumy', 'ou_jason', 'user'),
        // 缇蕾自己发的 notify "Flumy 小分队有 N 个 blocker"
        mkMsg('om_tilly_loop', 'oc_flumy', 'cli_aa9aab67157d5cb2', 'app'),
        // 克劳德主 bot 回应"不要再汇报"
        mkMsg('om_claude_meta', 'oc_flumy', 'cli_a9771799e8bb5bc3', 'app'),
      ] } });
      const { scout } = await freshImports();
      const r = await scout.fetchRecentMessages({ start: new Date(0), end: new Date(), larkCliPath: fake });
      // Only 人类消息进 fresh
      expect(r.map(m => m.messageId)).toEqual(['om_user']);
    });

    it('双维 allowlist: chatId:senderId 精确组合放行', async () => {
      const fake = makeFakeLarkCli({ ok: true, data: { messages: [
        mkMsg('om_strict_match', 'oc_target', 'cli_progress_bot', 'app'),
        mkMsg('om_strict_miss_chat', 'oc_other', 'cli_progress_bot', 'app'),
        mkMsg('om_strict_miss_sender', 'oc_target', 'cli_other', 'app'),
      ] } });
      const { scout } = await freshImports();
      const r = await scout.fetchRecentMessages({
        start: new Date(0), end: new Date(), larkCliPath: fake,
        includeBotSenders: ['oc_target:cli_progress_bot'],
      });
      expect(r.map(m => m.messageId)).toEqual(['om_strict_match']);
    });

    it('双维 allowlist: chatId:* 该 chat 所有 bot 放行', async () => {
      const fake = makeFakeLarkCli({ ok: true, data: { messages: [
        mkMsg('om_progress_bot', 'oc_subgroup', 'cli_a', 'app'),
        mkMsg('om_other_bot', 'oc_subgroup', 'cli_b', 'app'),
        mkMsg('om_diff_chat', 'oc_other', 'cli_a', 'app'),  // 同 bot 但不同 chat
      ] } });
      const { scout } = await freshImports();
      const r = await scout.fetchRecentMessages({
        start: new Date(0), end: new Date(), larkCliPath: fake,
        includeBotSenders: ['oc_subgroup:*'],
      });
      expect(r.map(m => m.messageId).sort()).toEqual(['om_other_bot', 'om_progress_bot']);
    });

    it('双维 allowlist: *:senderId 该 bot 跨所有 chat 放行', async () => {
      const fake = makeFakeLarkCli({ ok: true, data: { messages: [
        mkMsg('om_a_in_x', 'oc_x', 'cli_global', 'app'),
        mkMsg('om_a_in_y', 'oc_y', 'cli_global', 'app'),
        mkMsg('om_b', 'oc_x', 'cli_blocked', 'app'),
      ] } });
      const { scout } = await freshImports();
      const r = await scout.fetchRecentMessages({
        start: new Date(0), end: new Date(), larkCliPath: fake,
        includeBotSenders: ['*:cli_global'],
      });
      expect(r.map(m => m.messageId).sort()).toEqual(['om_a_in_x', 'om_a_in_y']);
    });

    it('debug only: includeAllBotSenders=true 全放行 (daemon 默认不开)', async () => {
      const fake = makeFakeLarkCli({ ok: true, data: { messages: [
        mkMsg('om_human', 'oc', 'ou_user', 'user'),
        mkMsg('om_any_bot', 'oc', 'cli_anything', 'app'),
      ] } });
      const { scout } = await freshImports();
      const r = await scout.fetchRecentMessages({
        start: new Date(0), end: new Date(), larkCliPath: fake,
        includeAllBotSenders: true,
      });
      expect(r.map(m => m.messageId).sort()).toEqual(['om_any_bot', 'om_human']);
    });
  });

  it('handles empty messages array', async () => {
    const fake = makeFakeLarkCli({ ok: true, data: { messages: [], total: 0 } });
    const { scout } = await freshImports();
    const r = await scout.fetchRecentMessages({ start: new Date(0), end: new Date(), larkCliPath: fake });
    expect(r).toEqual([]);
  });

  it('throws on lark-cli exec failure (non-zero exit)', async () => {
    const fake = join(tempDir, 'failing.sh');
    writeFileSync(fake, '#!/bin/sh\necho "boom" >&2\nexit 1\n', 'utf-8');
    chmodSync(fake, 0o755);
    const { scout } = await freshImports();
    await expect(scout.fetchRecentMessages({
      start: new Date(0), end: new Date(), larkCliPath: fake,
    })).rejects.toThrow(/lark-cli exec failed/);
  });

  it('groupByChat sorts per-chat messages chronologically', async () => {
    const { scout } = await freshImports();
    const msgs = [
      { messageId: 'om_b', chatId: 'oc_1', chatName: '', chatType: '', senderId: '', senderType: '', msgType: '', content: '', createTime: '2026-05-24 23:10' },
      { messageId: 'om_a', chatId: 'oc_1', chatName: '', chatType: '', senderId: '', senderType: '', msgType: '', content: '', createTime: '2026-05-24 23:05' },
      { messageId: 'om_c', chatId: 'oc_2', chatName: '', chatType: '', senderId: '', senderType: '', msgType: '', content: '', createTime: '2026-05-24 23:00' },
    ];
    const grouped = scout.groupByChat(msgs);
    expect(grouped.get('oc_1')?.map(m => m.messageId)).toEqual(['om_a', 'om_b']);
    expect(grouped.get('oc_2')?.map(m => m.messageId)).toEqual(['om_c']);
  });
});

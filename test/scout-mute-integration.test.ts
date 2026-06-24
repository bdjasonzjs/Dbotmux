/**
 * 一期验收 · 扫读静音接入（chat-policy → tilly-scout）集成测试。
 *
 * 证 v3.1 §七 两条验收：
 *   - 配置缺失/损坏时主话题仍被排除（fail-closed）；
 *   - 某群设 scout=mute 后，其消息不进 fresh（→ 不进 analyzeMessages /
 *     pushHighPriorityToScoutInbox）。
 *
 * 复刻 daemon tick 的接线：excludeChatIds = getScoutMutedChatIds()。
 * Run: pnpm vitest run test/scout-mute-integration.test.ts
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
    policy: await import('../src/services/chat-policy-store.js'),
  };
}

function makeFakeLarkCli(responseJson: object): string {
  const fp = join(tempDir, 'fake-lark-cli.sh');
  const body = `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(responseJson)}\nEOF\n`;
  writeFileSync(fp, body, 'utf-8');
  chmodSync(fp, 0o755);
  return fp;
}

const mkMsg = (id: string, chatId: string) => ({
  message_id: id, chat_id: chatId, chat_name: chatId, chat_type: 'group',
  msg_type: 'text', content: 'x', sender: { id: 'ou_user', sender_type: 'user' }, create_time: '',
});

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'scout-mute-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('扫读静音接入（chat-policy → tilly-scout）', () => {
  it('某群设 mute + 主话题默认静音 → 都不进 fresh，普通群留下', async () => {
    const { scout, policy } = await freshImports();
    policy.setPolicy('oc_noise', { scoutMode: 'mute' });
    const fake = makeFakeLarkCli({
      ok: true,
      data: { messages: [
        mkMsg('om_main', policy.MAIN_TOPIC_CHAT_ID), // 主话题默认静音
        mkMsg('om_noise', 'oc_noise'),               // 显式 mute
        mkMsg('om_normal', 'oc_normal'),             // watch（默认）
      ] },
    });
    const muted = policy.getScoutMutedChatIds();
    const fresh = await scout.fetchRecentMessages({
      start: new Date(0), end: new Date(), excludeChatIds: muted, larkCliPath: fake,
    });
    expect(fresh.map(m => m.messageId)).toEqual(['om_normal']);
  });

  it('fail-closed：配置损坏时主话题仍被排除', async () => {
    const { scout, policy } = await freshImports();
    writeFileSync(join(tempDir, 'chat-policies.json'), 'CORRUPT{{', 'utf-8');
    const fake = makeFakeLarkCli({
      ok: true,
      data: { messages: [
        mkMsg('om_main', policy.MAIN_TOPIC_CHAT_ID),
        mkMsg('om_normal', 'oc_normal'),
      ] },
    });
    const muted = policy.getScoutMutedChatIds();
    const fresh = await scout.fetchRecentMessages({
      start: new Date(0), end: new Date(), excludeChatIds: muted, larkCliPath: fake,
    });
    expect(fresh.map(m => m.messageId)).toEqual(['om_normal']); // 主话题被兜底排除
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sendMessage = vi.hoisted(() => vi.fn(async () => 'om_sent'));
const replyMessage = vi.hoisted(() => vi.fn(async () => 'om_reply'));
const MessageWithdrawnError = vi.hoisted(() => class extends Error {});

vi.mock('../src/im/lark/client.js', () => ({
  sendMessage,
  replyMessage,
  uploadImage: vi.fn(async () => 'img_key'),
  uploadFile: vi.fn(async () => 'file_key'),
  MessageWithdrawnError,
  getChatModeStrict: vi.fn(async () => 'group' as const),
}));

vi.mock('../src/bot-registry.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/bot-registry.js')>();
  return {
    ...actual,
    registerBot: vi.fn(),
    loadBotConfigs: vi.fn(() => []),
    findOncallChatForAnyBot: vi.fn(() => undefined),
  };
});

let dataDir: string;
let previousArgv: string[];
const previousDataDir = process.env.SESSION_DATA_DIR;
const previousFooterEnv = process.env.BOTMUX_SHOW_CARD_FOOTER;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  previousArgv = process.argv;
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-cli-footer-'));
  process.env.SESSION_DATA_DIR = dataDir;
  delete process.env.BOTMUX_SHOW_CARD_FOOTER;
  writeFileSync(join(dataDir, 'sessions.json'), JSON.stringify({
    s_footer: {
      sessionId: 's_footer',
      chatId: 'oc_footer',
      rootMessageId: 'om_root',
      scope: 'thread',
      title: 'footer test',
      status: 'active',
      createdAt: new Date(0).toISOString(),
      larkAppId: 'app_footer',
      ownerOpenId: 'ou_owner',
      quoteTargetSenderOpenId: 'ou_owner',
      suppressRelayMentions: true,
      suppressRelayMentionAppId: 'app_relay',
    },
  }));
  writeFileSync(join(dataDir, 'bots-info.json'), JSON.stringify([
    { larkAppId: 'app_footer', botOpenId: 'ou_self', botName: 'FooterBot', cliId: 'codex' },
    { larkAppId: 'app_relay', botOpenId: 'ou_relay_self', botName: 'RelayBot', cliId: 'claude-code' },
  ]));
  writeFileSync(join(dataDir, 'bot-openids-app_footer.json'), JSON.stringify({ RelayBot: 'ou_relay_sender_scope' }));
});

afterEach(() => {
  process.argv = previousArgv;
  if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = previousDataDir;
  if (previousFooterEnv === undefined) delete process.env.BOTMUX_SHOW_CARD_FOOTER;
  else process.env.BOTMUX_SHOW_CARD_FOOTER = previousFooterEnv;
  rmSync(dataDir, { recursive: true, force: true });
});

async function sendPayload(mode: '--card' | '--text', extraFlags: string[], content = 'hello'): Promise<{ msgType: string; payload: any }> {
  vi.resetModules();
  replyMessage.mockClear();
  sendMessage.mockClear();
  process.argv = [
    process.execPath,
    'src/cli.ts',
    'send',
    '--session-id',
    's_footer',
    mode,
    ...extraFlags,
    content,
  ];
  await import('../src/cli.js');
  expect(replyMessage).toHaveBeenCalledTimes(1);
  return {
    msgType: replyMessage.mock.calls[0][3] as string,
    payload: JSON.parse(replyMessage.mock.calls[0][2] as string),
  };
}

describe('botmux send footer flags', () => {
  it('defaults to no footer', async () => {
    const { payload: card } = await sendPayload('--card', ['--no-mention']);
    expect(card.body.elements.map((element: any) => element.tag)).not.toContain('hr');
    expect(JSON.stringify(card)).not.toContain('[botmux](');
  });

  it('--footer opts in to the footer', async () => {
    const { payload: card } = await sendPayload('--card', ['--footer', '--mention', 'ou_owner:Owner']);
    expect(card.body.elements.map((element: any) => element.tag)).toContain('hr');
    expect(JSON.stringify(card)).toContain('[botmux](');
    expect(JSON.stringify(card)).toContain('<at id=ou_owner></at>');
  });

  it('defaults to no footer for the legacy --text compatibility flag', async () => {
    process.env.BOTMUX_SHOW_CARD_FOOTER = '1';
    const { msgType, payload: card } = await sendPayload('--text', ['--no-mention']);

    expect(msgType).toBe('interactive');
    expect(card.body.elements.map((element: any) => element.tag)).not.toContain('hr');
    expect(JSON.stringify(card)).not.toContain('发送给：');
    expect(JSON.stringify(card)).not.toContain('ou_owner');
  });

  it('--footer opts in when the legacy --text compatibility flag is present', async () => {
    const { msgType, payload: card } = await sendPayload('--text', ['--footer', '--mention', 'ou_owner:Owner']);

    expect(msgType).toBe('interactive');
    expect(JSON.stringify(card)).toContain('发送给：');
    expect(JSON.stringify(card)).toContain('ou_owner');
  });

  it('--no-footer wins over --footer', async () => {
    process.env.BOTMUX_SHOW_CARD_FOOTER = '1';
    const { payload: card } = await sendPayload('--text', ['--footer', '--no-footer', '--no-mention']);

    expect(card.body.elements.map((element: any) => element.tag)).not.toContain('hr');
    expect(JSON.stringify(card)).not.toContain('发送给：');
    expect(JSON.stringify(card)).not.toContain('ou_owner');
  });

  it('relay sentinel suppression removes explicit and prose auto-mentions for the relay app', async () => {
    const { payload: explicitCard } = await sendPayload('--card', [
      '--mention', 'ou_relay_sender_scope:RelayBot', '--no-footer',
    ]);
    expect(JSON.stringify(explicitCard)).not.toContain('ou_relay_sender_scope');

    const { payload: proseCard } = await sendPayload('--card', [
      '--mention', 'ou_owner:Owner', '--no-footer',
    ], '@RelayBot 请看');
    expect(JSON.stringify(proseCard)).not.toContain('ou_relay_sender_scope');
    expect(JSON.stringify(proseCard)).toContain('ou_owner');
  });
});

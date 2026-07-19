import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sendMessage = vi.hoisted(() => vi.fn(async () => 'om_sent'));
const replyMessage = vi.hoisted(() => vi.fn(async () => 'om_reply'));

vi.mock('../src/im/lark/client.js', () => ({
  sendMessage,
  replyMessage,
  uploadImage: vi.fn(async () => 'img_key'),
  uploadFile: vi.fn(async () => 'file_key'),
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
    },
  }));
});

afterEach(() => {
  process.argv = previousArgv;
  if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = previousDataDir;
  if (previousFooterEnv === undefined) delete process.env.BOTMUX_SHOW_CARD_FOOTER;
  else process.env.BOTMUX_SHOW_CARD_FOOTER = previousFooterEnv;
  rmSync(dataDir, { recursive: true, force: true });
});

async function sendPayload(mode: '--card' | '--text', extraFlags: string[]): Promise<{ msgType: string; payload: any }> {
  process.argv = [
    process.execPath,
    'src/cli.ts',
    'send',
    '--session-id',
    's_footer',
    mode,
    ...extraFlags,
    'hello',
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
    const { payload: card } = await sendPayload('--card', []);
    expect(card.body.elements.map((element: any) => element.tag)).not.toContain('hr');
    expect(JSON.stringify(card)).not.toContain('[botmux](');
  });

  it('--footer opts in to the footer', async () => {
    const { payload: card } = await sendPayload('--card', ['--footer']);
    expect(card.body.elements.map((element: any) => element.tag)).toContain('hr');
    expect(JSON.stringify(card)).toContain('[botmux](');
    expect(JSON.stringify(card)).toContain('<at id=ou_owner></at>');
  });

  it('defaults to no footer for plain text even when the legacy env gate is enabled', async () => {
    process.env.BOTMUX_SHOW_CARD_FOOTER = '1';
    const { msgType, payload: post } = await sendPayload('--text', []);

    expect(msgType).toBe('post');
    expect(JSON.stringify(post)).not.toContain('发送给：');
    expect(JSON.stringify(post)).not.toContain('ou_owner');
  });

  it('--footer opts in for plain text', async () => {
    const { msgType, payload: post } = await sendPayload('--text', ['--footer']);

    expect(msgType).toBe('post');
    expect(JSON.stringify(post)).toContain('发送给：');
    expect(JSON.stringify(post)).toContain('ou_owner');
  });

  it('--no-footer wins over --footer for plain text', async () => {
    process.env.BOTMUX_SHOW_CARD_FOOTER = '1';
    const { payload: post } = await sendPayload('--text', ['--footer', '--no-footer']);

    expect(JSON.stringify(post)).not.toContain('发送给：');
    expect(JSON.stringify(post)).not.toContain('ou_owner');
  });
});

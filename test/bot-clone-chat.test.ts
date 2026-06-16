import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import QRCode from 'qrcode';
import type { BotConfig } from '../src/bot-registry.js';
import type { RegisterAppResult } from '../src/setup/register-app.js';
import { cloneBotInChat, type CloneBotInChatDeps } from '../src/services/bot-clone-chat.js';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const tmps: string[] = [];
function tmp(p = 'bcc-'): string { const d = mkdtempSync(join(tmpdir(), p)); tmps.push(d); return d; }
afterEach(() => { while (tmps.length) { try { rmSync(tmps.pop()!, { recursive: true, force: true }); } catch { /* */ } } });
const flush = () => new Promise(r => setTimeout(r, 30));

describe('qrcode.toBuffer (the new dep) produces a valid PNG', () => {
  it('emits a PNG with the right magic header', async () => {
    const buf = await QRCode.toBuffer('https://example.com/clone', { type: 'png', width: 160, margin: 1 });
    expect(buf.length).toBeGreaterThan(50);
    expect([...buf.subarray(0, 8)]).toEqual(PNG_MAGIC);
  });
});

describe('cloneBotInChat', () => {
  const okScan: RegisterAppResult = {
    ok: true, appId: 'cli_new', appSecret: 'NEW_SECRET', brand: 'feishu', userOpenId: 'ou_owner',
  };

  // Fake source home so cloneBot's setupCloneHome/seed never touch the real ~/.claude.
  function fakeSource(): { sourceBot: BotConfig; configDir: string; botsJsonPath: string } {
    const srcHome = tmp('srchome-');
    writeFileSync(join(srcHome, 'CLAUDE.md'), 'persona');
    const configDir = tmp('cfg-');
    const botsJsonPath = join(configDir, 'bots.json');
    const sourceBot: BotConfig = {
      larkAppId: 'cli_src', larkAppSecret: 'S', cliId: 'claude-code', name: 'claude',
      allowedUsers: ['ou_src_scope'], claudeConfigDir: srcHome,
    };
    writeFileSync(botsJsonPath, JSON.stringify([sourceBot]));
    return { sourceBot, configDir, botsJsonPath };
  }

  function recordingDeps(over: Partial<CloneBotInChatDeps> = {}) {
    const calls = { register: 0, upload: 0, replies: [] as Array<{ c: string; t: string; chatId: string }> };
    const deps: CloneBotInChatDeps = {
      getOwnerOpenId: () => 'ou_owner',
      uploadImage: async () => { calls.upload++; return 'img_key_1'; },
      postToChat: async (_a, chatId, c, t = 'text') => { calls.replies.push({ c, t, chatId }); return 'om_x'; },
      registerApp: async (opts) => {
        calls.register++;
        opts?.onQRCodeReady?.({ url: 'https://feishu/qr', expireIn: 600 });
        // Model real tryRegisterApp: QR-ready fires, then polling — which the
        // chat layer aborts if QR delivery failed. Give the post a tick, then
        // honour the abort signal.
        await new Promise(r => setTimeout(r, 10));
        if (opts?.signal?.aborted) return { ok: false, error: 'aborted', message: 'aborted' } as RegisterAppResult;
        return okScan;
      },
      renderQrPng: async () => Buffer.from(PNG_MAGIC),
      ...over,
    };
    return { calls, deps };
  }

  it('refuses a non-owner sender — no scan, no clone, refusal reply', async () => {
    const { sourceBot, configDir, botsJsonPath } = fakeSource();
    const { calls, deps } = recordingDeps();
    const res = await cloneBotInChat(
      { ceoAppId: 'cli_ceo', chatId: 'oc_x', rootMessageId: 'om_root', senderOpenId: 'ou_intruder', sourceBot, configDir, botsJsonPath },
      deps,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('not_owner');
    expect(calls.register).toBe(0); // never reached the scan
    expect(calls.upload).toBe(0);
    expect(calls.replies.some(x => /只有 owner/.test(x.c))).toBe(true);
    expect(JSON.parse(readFileSync(botsJsonPath, 'utf-8'))).toHaveLength(1); // unchanged
  });

  it('owner: posts QR image into the target chat, writes the clone, replies回执', async () => {
    const { sourceBot, configDir, botsJsonPath } = fakeSource();
    const { calls, deps } = recordingDeps();
    const res = await cloneBotInChat(
      { ceoAppId: 'cli_ceo', chatId: 'oc_x', rootMessageId: 'om_root', senderOpenId: 'ou_owner', sourceBot, configDir, botsJsonPath },
      deps,
    );
    await flush(); // let the fire-and-forget QR post settle

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(calls.register).toBe(1);
    expect(calls.upload).toBe(1);

    // QR posted as an image reply, in-thread
    const img = calls.replies.find(x => x.t === 'image');
    expect(img, 'an image reply should have been sent').toBeTruthy();
    expect(img!.chatId).toBe('oc_x'); // posted into the target chat (blocker1: not a foreign-thread reply)
    expect(JSON.parse(img!.c).image_key).toBe('img_key_1');

    // 回执 names the new clone
    expect(calls.replies.some(x => /已克隆分身/.test(x.c) && x.c.includes('cli_new'))).toBe(true);
    // every message goes to the target chat (never a foreign thread / new topic)
    expect(calls.replies.every(x => x.chatId === 'oc_x')).toBe(true);

    // clone actually written + scanner-scoped owner
    const bots = JSON.parse(readFileSync(botsJsonPath, 'utf-8'));
    expect(bots).toHaveLength(2);
    expect(bots[1].larkAppId).toBe('cli_new');
    expect(bots[1].allowedUsers).toEqual(['ou_owner']);
    expect(existsSync(join(configDir, 'clones', 'cli_new', '.claude', 'CLAUDE.md'))).toBe(true);
  });

  it('targetChatId routes QR + status into the SUBGROUP, not the request chat (#5 blocker1)', async () => {
    const { sourceBot, configDir, botsJsonPath } = fakeSource();
    const { calls, deps } = recordingDeps();
    const res = await cloneBotInChat(
      { ceoAppId: 'cli_ceo', chatId: 'oc_main', targetChatId: 'oc_subgroup', rootMessageId: 'om_root', senderOpenId: 'ou_owner', sourceBot, configDir, botsJsonPath },
      deps,
    );
    await flush();
    expect(res.ok).toBe(true);
    expect(calls.replies.length).toBeGreaterThan(0);
    expect(calls.replies.every(x => x.chatId === 'oc_subgroup')).toBe(true); // all into subgroup
    expect(calls.replies.some(x => x.chatId === 'oc_main')).toBe(false);     // never the request chat
  });

  it('QR delivery failure (uploadImage throws) → aborts scan, no clone written, no success回执', async () => {
    const { sourceBot, configDir, botsJsonPath } = fakeSource();
    const { calls, deps } = recordingDeps({
      uploadImage: async () => { throw new Error('lark upload 500'); },
    });
    const res = await cloneBotInChat(
      { ceoAppId: 'cli_ceo', chatId: 'oc_x', rootMessageId: 'om_root', senderOpenId: 'ou_owner', sourceBot, configDir, botsJsonPath },
      deps,
    );
    await flush();

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('qr_delivery_failed');
    // nothing written, no clone home created
    expect(JSON.parse(readFileSync(botsJsonPath, 'utf-8'))).toHaveLength(1);
    expect(existsSync(join(configDir, 'clones', 'cli_new'))).toBe(false);
    // no success回执; an explicit failure notice instead; secret never leaked
    expect(calls.replies.some(x => /已克隆分身/.test(x.c))).toBe(false);
    expect(calls.replies.some(x => /二维码发送.*失败|中止克隆/.test(x.c))).toBe(true);
    expect(calls.replies.every(x => !x.c.includes('NEW_SECRET'))).toBe(true);
  });

  it('image reply failure also aborts (no clone written)', async () => {
    const { sourceBot, configDir, botsJsonPath } = fakeSource();
    const { deps } = recordingDeps({
      postToChat: async (_a, _chat, _c, t = 'text') => {
        if (t === 'image') throw new Error('image reply failed');
        return 'om_x';
      },
    });
    const res = await cloneBotInChat(
      { ceoAppId: 'cli_ceo', chatId: 'oc_x', rootMessageId: 'om_root', senderOpenId: 'ou_owner', sourceBot, configDir, botsJsonPath },
      deps,
    );
    await flush();
    expect(res.ok).toBe(false);
    expect(JSON.parse(readFileSync(botsJsonPath, 'utf-8'))).toHaveLength(1);
  });

  it('secret never appears in any chat reply', async () => {
    const { sourceBot, configDir, botsJsonPath } = fakeSource();
    const { calls, deps } = recordingDeps();
    await cloneBotInChat(
      { ceoAppId: 'cli_ceo', chatId: 'oc_x', rootMessageId: 'om_root', senderOpenId: 'ou_owner', sourceBot, configDir, botsJsonPath },
      deps,
    );
    await flush();
    expect(calls.replies.every(x => !x.c.includes('NEW_SECRET'))).toBe(true);
  });
});

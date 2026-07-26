import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 2026-07-26：<sender> 身份分类。核心不变式（蔻黛克斯 review blocker 1）：
// owner 不可确证时返回 undefined，绝不把未知者误标成 external / owner。
const contactGet = vi.hoisted(() => vi.fn());
const OWNER_APP = 'app_role_test';
const OWNER_OPENID = 'ou_theowner';

vi.mock('../src/bot-registry.js', () => ({
  getBotClient: vi.fn(() => ({ contact: { v3: { user: { get: contactGet } } } })),
  // owner 只在本 app 视角命中（open_id 是 app-scoped）；其余 app 未配置 → undefined。
  getOwnerOpenId: vi.fn((app: string) => (app === OWNER_APP ? OWNER_OPENID : undefined)),
}));

let dataDir: string | undefined;
const previousDataDir = process.env.SESSION_DATA_DIR;

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = previousDataDir;
  vi.resetModules();
  contactGet.mockReset();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

async function freshIdentity() {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-sender-role-'));
  process.env.SESSION_DATA_DIR = dataDir;
  return import('../src/im/lark/identity-cache.js');
}

describe('classifySenderRole（纯函数 · 全边界）', () => {
  it('bot → 恒 bot（不查 owner）', async () => {
    const { classifySenderRole } = await freshIdentity();
    expect(classifySenderRole({ senderType: 'bot', senderOpenId: 'ou_x' })).toBe('bot');
    expect(classifySenderRole({ senderType: 'bot', senderOpenId: OWNER_OPENID, appOwnerOpenId: OWNER_OPENID })).toBe('bot');
  });

  it('app owner 已配置：相等=owner，不等=external', async () => {
    const { classifySenderRole } = await freshIdentity();
    expect(classifySenderRole({ senderType: 'user', senderOpenId: 'ou_o', appOwnerOpenId: 'ou_o' })).toBe('owner');
    expect(classifySenderRole({ senderType: 'user', senderOpenId: 'ou_p', appOwnerOpenId: 'ou_o' })).toBe('external');
  });

  it('⚠️blocker1：app owner 未配置 + 无 profile → undefined（绝不误标 external）', async () => {
    const { classifySenderRole } = await freshIdentity();
    expect(classifySenderRole({ senderType: 'user', senderOpenId: 'ou_anyone' })).toBeUndefined();
  });

  it('app owner 未配置 → 只用 profile 做 owner 正向确认；不等 → undefined 不断言 external', async () => {
    const { classifySenderRole } = await freshIdentity();
    expect(classifySenderRole({ senderType: 'user', senderOpenId: 'ou_boss', profileOwnerOpenId: 'ou_boss' })).toBe('owner');
    // 跨 app 视角「不相等」不代表不是 owner → 只能 unknown，绝不 external
    expect(classifySenderRole({ senderType: 'user', senderOpenId: 'ou_boss_other_app_view', profileOwnerOpenId: 'ou_boss' })).toBeUndefined();
  });

  it('app owner 优先于 profile（app 配置存在时按 app 三分）', async () => {
    const { classifySenderRole } = await freshIdentity();
    // app owner=ou_a，profile=ou_b，发言人=ou_b → 有 app 配置就按 app 判 → external（不被 profile 拉成 owner）
    expect(classifySenderRole({ senderType: 'user', senderOpenId: 'ou_b', appOwnerOpenId: 'ou_a', profileOwnerOpenId: 'ou_b' })).toBe('external');
  });
});

describe('resolveSender 集成 role', () => {
  it('本 app owner === 发言人 → owner', async () => {
    const identity = await freshIdentity();
    contactGet.mockResolvedValue({ code: 0, data: { user: { name: '邹劲松', email: 'z@x.com' } } });
    const sender = await identity.resolveSender(OWNER_APP, OWNER_OPENID, 'user');
    expect(sender?.role).toBe('owner');
  });

  it('本 app owner 已配置但非发言人 → external', async () => {
    const identity = await freshIdentity();
    contactGet.mockResolvedValue({ code: 0, data: { user: { name: '路人', email: 'p@x.com' } } });
    const sender = await identity.resolveSender(OWNER_APP, 'ou_someone_else', 'user');
    expect(sender?.role).toBe('external');
  });

  it('owner 未配置的 app（无 owner-profile 文件）→ role undefined（不误标）', async () => {
    const identity = await freshIdentity();
    contactGet.mockResolvedValue({ code: 0, data: { user: { name: 'x', email: 'x@x.com' } } });
    const sender = await identity.resolveSender('app_no_owner', 'ou_whoever', 'user');
    expect(sender?.role).toBeUndefined();
  });

  it('bot 发言人 → bot（不查 owner，不走 user 补全）', async () => {
    const identity = await freshIdentity();
    const sender = await identity.resolveSender(OWNER_APP, 'ou_a_bot', 'app');
    expect(sender?.role).toBe('bot');
    expect(contactGet).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 2026-07-26：<sender> 身份分类。核心不变式（蔻黛克斯 R1/R2 blocker）：
//  ① owner 源必须 app-scope 已确证（不用 allowlist 首项、不用无 scope 的 open_id 跨 app 比对）；
//  ② owner 不可确证 → undefined，绝不误标 external。
const contactGet = vi.hoisted(() => vi.fn());
const OWNER_APP = 'cli_owner_app';
const OWNER_OPENID = 'ou_theowner';

vi.mock('../src/bot-registry.js', () => ({
  getBotClient: vi.fn(() => ({ contact: { v3: { user: { get: contactGet } } } })),
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

/** 起一份干净 dataDir；ownerProfile 传入则写 owner-profile.json（含 app_id）。 */
async function freshIdentity(ownerProfile?: { open_id: string; app_id: string }) {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-sender-role-'));
  process.env.SESSION_DATA_DIR = dataDir;
  if (ownerProfile) {
    writeFileSync(join(dataDir, 'owner-profile.json'), JSON.stringify({
      owner: { name: '邹劲松', open_id: ownerProfile.open_id, app_id: ownerProfile.app_id,
               responsibilities: { business: 'x', technical: 'y' } },
    }), 'utf-8');
  }
  return import('../src/im/lark/identity-cache.js');
}

describe('classifySenderRole（纯函数 · 全边界）', () => {
  it('bot → 恒 bot（不看 owner）', async () => {
    const { classifySenderRole } = await freshIdentity();
    expect(classifySenderRole({ senderType: 'bot', senderOpenId: 'ou_x' })).toBe('bot');
    expect(classifySenderRole({ senderType: 'bot', senderOpenId: OWNER_OPENID, scopedOwnerOpenId: OWNER_OPENID })).toBe('bot');
  });

  it('有已确证 scoped owner：相等=owner，不等=external', async () => {
    const { classifySenderRole } = await freshIdentity();
    expect(classifySenderRole({ senderType: 'user', senderOpenId: 'ou_o', scopedOwnerOpenId: 'ou_o' })).toBe('owner');
    expect(classifySenderRole({ senderType: 'user', senderOpenId: 'ou_p', scopedOwnerOpenId: 'ou_o' })).toBe('external');
  });

  it('⚠️blocker：无 scoped owner → undefined（绝不误标 external / owner）', async () => {
    const { classifySenderRole } = await freshIdentity();
    expect(classifySenderRole({ senderType: 'user', senderOpenId: 'ou_anyone' })).toBeUndefined();
  });
});

describe('resolveSender 集成 role（owner 源 = app-scope 匹配的 owner-profile）', () => {
  it('owner-profile app_id === 当前 app 且 open_id 命中 → owner', async () => {
    const identity = await freshIdentity({ open_id: OWNER_OPENID, app_id: OWNER_APP });
    contactGet.mockResolvedValue({ code: 0, data: { user: { name: '邹劲松', email: 'z@x.com' } } });
    expect((await identity.resolveSender(OWNER_APP, OWNER_OPENID, 'user'))?.role).toBe('owner');
  });

  it('同 app 但非 owner 的真人 → external', async () => {
    const identity = await freshIdentity({ open_id: OWNER_OPENID, app_id: OWNER_APP });
    contactGet.mockResolvedValue({ code: 0, data: { user: { name: '路人', email: 'p@x.com' } } });
    expect((await identity.resolveSender(OWNER_APP, 'ou_guest', 'user'))?.role).toBe('external');
  });

  it('⚠️P1-B：profile 的 app_id ≠ 当前 app → 不据无 scope open_id 判定（owner 本人在别 app 也只 undefined，绝不误标 external）', async () => {
    const identity = await freshIdentity({ open_id: OWNER_OPENID, app_id: OWNER_APP });
    contactGet.mockResolvedValue({ code: 0, data: { user: { name: 'x', email: 'x@x.com' } } });
    // 别的 app 下，即便 open_id 恰好等于 profile 里的值，也不能确证（scope 不匹配）→ undefined
    expect((await identity.resolveSender('cli_other_app', OWNER_OPENID, 'user'))?.role).toBeUndefined();
    expect((await identity.resolveSender('cli_other_app', 'ou_whoever', 'user'))?.role).toBeUndefined();
  });

  it('无 owner-profile 文件 → role undefined（不猜）', async () => {
    const identity = await freshIdentity();
    contactGet.mockResolvedValue({ code: 0, data: { user: { name: 'x', email: 'x@x.com' } } });
    expect((await identity.resolveSender(OWNER_APP, 'ou_whoever', 'user'))?.role).toBeUndefined();
  });

  it('owner-profile 缺 app_id → 不确证 → undefined（无 scope 不做正向确认）', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-sender-role-'));
    process.env.SESSION_DATA_DIR = dataDir;
    writeFileSync(join(dataDir, 'owner-profile.json'), JSON.stringify({
      owner: { name: '邹劲松', open_id: OWNER_OPENID, responsibilities: { business: 'x', technical: 'y' } },
    }), 'utf-8');
    const identity = await import('../src/im/lark/identity-cache.js');
    contactGet.mockResolvedValue({ code: 0, data: { user: { name: 'x', email: 'x@x.com' } } });
    expect((await identity.resolveSender(OWNER_APP, OWNER_OPENID, 'user'))?.role).toBeUndefined();
  });

  it('bot 发言人 → bot（不查 owner，不走 user 补全）', async () => {
    const identity = await freshIdentity({ open_id: OWNER_OPENID, app_id: OWNER_APP });
    const sender = await identity.resolveSender(OWNER_APP, 'ou_a_bot', 'app');
    expect(sender?.role).toBe('bot');
    expect(contactGet).not.toHaveBeenCalled();
  });
});

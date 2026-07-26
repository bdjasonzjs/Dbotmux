import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 2026-07-26：<sender> 身份分类（owner / teammate-bot / external）——file 模式下每轮兜底，
// 让 bot 即使不读身份文件也一眼知道跟自己说话的是不是项目主人。
const contactGet = vi.hoisted(() => vi.fn());
const OWNER_APP = 'app_role_test';
const OWNER_OPENID = 'ou_theowner';

vi.mock('../src/bot-registry.js', () => ({
  getBotClient: vi.fn(() => ({
    contact: { v3: { user: { get: contactGet } } },
  })),
  // owner 只在本 app 视角命中（open_id 是 app-scoped）。
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

describe('resolveSender 身份分类 role', () => {
  it('发言人 open_id === 本 app owner → role=owner', async () => {
    const identity = await freshIdentity();
    contactGet.mockResolvedValue({ code: 0, data: { user: { name: '邹劲松', email: 'z@x.com' } } });
    const sender = await identity.resolveSender(OWNER_APP, OWNER_OPENID, 'user');
    expect(sender?.role).toBe('owner');
  });

  it('真人但非 owner → role=external', async () => {
    const identity = await freshIdentity();
    contactGet.mockResolvedValue({ code: 0, data: { user: { name: '路人', email: 'p@x.com' } } });
    const sender = await identity.resolveSender(OWNER_APP, 'ou_someone_else', 'user');
    expect(sender?.role).toBe('external');
  });

  it('发言人是 bot（sender_type=app/bot）→ role=teammate-bot（不查 owner）', async () => {
    const identity = await freshIdentity();
    const sender = await identity.resolveSender(OWNER_APP, 'ou_a_bot', 'app');
    expect(sender?.role).toBe('teammate-bot');
    expect(contactGet).not.toHaveBeenCalled(); // bot 不走 user 身份补全
  });

  it('owner 判定是 app-scoped：同一 open_id 在别的 app 视角下不是 owner', async () => {
    const identity = await freshIdentity();
    contactGet.mockResolvedValue({ code: 0, data: { user: { name: 'x', email: 'x@x.com' } } });
    const sender = await identity.resolveSender('app_other', OWNER_OPENID, 'user');
    expect(sender?.role).toBe('external');
  });
});

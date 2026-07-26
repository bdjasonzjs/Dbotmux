import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 2026-07-26：<sender> 身份分类（per-chat 模型）。owner = 本会话发起人（chatOwnerOpenId），
// 取自本聊天 app 视角 → 天然 app-scoped 正确、三 app 通吃、无需全局映射。
// 不变式：owner 未知 → undefined，绝不误标 external。
const contactGet = vi.hoisted(() => vi.fn());

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

async function freshIdentity() {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-sender-role-'));
  process.env.SESSION_DATA_DIR = dataDir;
  return import('../src/im/lark/identity-cache.js');
}

describe('classifySenderRole（纯函数 · per-chat）', () => {
  it('bot → 恒 bot（不看 owner）', async () => {
    const { classifySenderRole } = await freshIdentity();
    expect(classifySenderRole({ senderType: 'bot', senderOpenId: 'ou_x' })).toBe('bot');
    expect(classifySenderRole({ senderType: 'bot', senderOpenId: 'ou_o', chatOwnerOpenId: 'ou_o' })).toBe('bot');
  });

  it('user：发言人 === 本会话 owner → owner；≠ → external', async () => {
    const { classifySenderRole } = await freshIdentity();
    expect(classifySenderRole({ senderType: 'user', senderOpenId: 'ou_o', chatOwnerOpenId: 'ou_o' })).toBe('owner');
    expect(classifySenderRole({ senderType: 'user', senderOpenId: 'ou_p', chatOwnerOpenId: 'ou_o' })).toBe('external');
  });

  it('⚠️不变式：本会话 owner 未知 → undefined（绝不误标 external）', async () => {
    const { classifySenderRole } = await freshIdentity();
    expect(classifySenderRole({ senderType: 'user', senderOpenId: 'ou_anyone' })).toBeUndefined();
  });

  it('多 app 通吃：同一人在不同 app 的 open_id 各自与本会话 owner 比对，都能认出 owner', async () => {
    const { classifySenderRole } = await freshIdentity();
    // Claude 会话：owner=Claude 视角 id
    expect(classifySenderRole({ senderType: 'user', senderOpenId: 'ou_claudeview', chatOwnerOpenId: 'ou_claudeview' })).toBe('owner');
    // Codex 会话：owner=Codex 视角 id（chatOwnerOpenId 由该会话 app 视角传入）
    expect(classifySenderRole({ senderType: 'user', senderOpenId: 'ou_codexview', chatOwnerOpenId: 'ou_codexview' })).toBe('owner');
    // 跨用：Claude 视角 id 与 Codex 会话 owner 比对 → external（本就不同人/不同视角，正确）
    expect(classifySenderRole({ senderType: 'user', senderOpenId: 'ou_claudeview', chatOwnerOpenId: 'ou_codexview' })).toBe('external');
  });
});

describe('resolveSender 集成 role（owner 源 = 传入的本会话 ownerOpenId）', () => {
  it('发言人 === chatOwnerOpenId → owner', async () => {
    const identity = await freshIdentity();
    contactGet.mockResolvedValue({ code: 0, data: { user: { name: '邹劲松', email: 'z@x.com' } } });
    expect((await identity.resolveSender('cli_app', 'ou_owner', 'user', undefined, 'ou_owner'))?.role).toBe('owner');
  });

  it('发言人 ≠ chatOwnerOpenId（本会话有 owner）→ external', async () => {
    const identity = await freshIdentity();
    contactGet.mockResolvedValue({ code: 0, data: { user: { name: '路人', email: 'p@x.com' } } });
    expect((await identity.resolveSender('cli_app', 'ou_guest', 'user', undefined, 'ou_owner'))?.role).toBe('external');
  });

  it('未传 chatOwnerOpenId（owner 未知）→ role undefined（不猜）', async () => {
    const identity = await freshIdentity();
    contactGet.mockResolvedValue({ code: 0, data: { user: { name: 'x', email: 'x@x.com' } } });
    expect((await identity.resolveSender('cli_app', 'ou_whoever', 'user'))?.role).toBeUndefined();
  });

  it('bot 发言人 → bot（不看 owner，不走 user 补全）', async () => {
    const identity = await freshIdentity();
    const sender = await identity.resolveSender('cli_app', 'ou_a_bot', 'app', undefined, 'ou_owner');
    expect(sender?.role).toBe('bot');
    expect(contactGet).not.toHaveBeenCalled();
  });
});

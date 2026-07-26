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

// 蔻黛克斯 R4→R5 blocker：三态严格区分——无会话(auto-create) / 有会话有 owner / 有会话缺 owner。
// 关键：「有会话但 owner 缺失」（旧数据实测 22 个）必须 fail-closed undefined，绝不回退发言人。
describe('chatOwnerForReply（三态）', () => {
  it('无会话（auto-create 首轮）→ 回退当前发言人', async () => {
    const { chatOwnerForReply } = await freshIdentity();
    expect(chatOwnerForReply({ sessionExists: false, senderOpenId: 'ou_creator' })).toBe('ou_creator');
  });
  it('有会话且 owner 已知 → 用既有 owner（正常 follow-up，可与发言人不同）', async () => {
    const { chatOwnerForReply } = await freshIdentity();
    expect(chatOwnerForReply({ sessionExists: true, sessionOwnerOpenId: 'ou_owner', senderOpenId: 'ou_guest' })).toBe('ou_owner');
  });
  it('⚠️有会话但 owner 缺失（旧数据/恢复态）→ undefined，绝不回退发言人', async () => {
    const { chatOwnerForReply } = await freshIdentity();
    expect(chatOwnerForReply({ sessionExists: true, sessionOwnerOpenId: undefined, senderOpenId: 'ou_guest' })).toBeUndefined();
  });

  it('端到端①：auto-create 首轮（无会话）→ 发言人被认出 owner', async () => {
    const identity = await freshIdentity();
    contactGet.mockResolvedValue({ code: 0, data: { user: { name: '邹劲松', email: 'z@x.com' } } });
    const owner = identity.chatOwnerForReply({ sessionExists: false, senderOpenId: 'ou_creator' });
    expect((await identity.resolveSender('cli_app', 'ou_creator', 'user', undefined, owner))?.role).toBe('owner');
  });

  it('端到端②：follow-up 有会话、非发起人发言 → external', async () => {
    const identity = await freshIdentity();
    contactGet.mockResolvedValue({ code: 0, data: { user: { name: '路人', email: 'p@x.com' } } });
    const owner = identity.chatOwnerForReply({ sessionExists: true, sessionOwnerOpenId: 'ou_creator', senderOpenId: 'ou_guest' });
    expect((await identity.resolveSender('cli_app', 'ou_guest', 'user', undefined, owner))?.role).toBe('external');
  });

  it('⚠️端到端③：恢复的旧会话缺 owner、任意真人发言 → role 保持 undefined（不误标 owner）', async () => {
    const identity = await freshIdentity();
    contactGet.mockResolvedValue({ code: 0, data: { user: { name: '路人', email: 'p@x.com' } } });
    const owner = identity.chatOwnerForReply({ sessionExists: true, sessionOwnerOpenId: undefined, senderOpenId: 'ou_guest' });
    expect((await identity.resolveSender('cli_app', 'ou_guest', 'user', undefined, owner))?.role).toBeUndefined();
  });
});

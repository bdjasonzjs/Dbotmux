import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AskHumanProtectionRegistry, ASK_HUMAN_GUARD_DIRECTORY, assertAskHumanOutbound, askHumanRoomProtected,
  askHumanHasProtection, interceptAskHumanRoom, askHumanBotJoinHeld, assertAskHumanWorkerAllowed } from '../src/core/ask-human-guards.js';
import type { AskHumanFrame } from '../src/core/ask-human-ledger.js';

const sdk = vi.hoisted(() => ({ create: vi.fn(), reply: vi.fn(), patch: vi.fn(), delete: vi.fn(), request: vi.fn(), reaction: vi.fn(), hook: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({ getBotClient: () => ({ im: { v1: { message: { create: sdk.create, reply: sdk.reply, patch: sdk.patch, delete: sdk.delete }, messageReaction: { create: sdk.reaction, delete: sdk.reaction } } }, request: sdk.request }), getBot: () => ({ config: { apiOnly: false } }), getAllBots: () => [], loadBotConfigs: () => [], formatLarkError: String }));
vi.mock('../src/services/hook-runner.js', () => ({ emitHookEvent: sdk.hook }));
import { config } from '../src/config.js';
import { sendMessage, replyMessage, updateMessage, sendEphemeralCard, sendUserMessage, addReaction, removeReaction, deleteMessage, deleteEphemeralCard } from '../src/im/lark/client.js';
import { createSession } from '../src/services/session-store.js';

const f: AskHumanFrame = { source: { appId: 'app', sessionId: 'source-session', chatId: 'source-chat', taskId: 'task', revision: 'v4', tenantId: 'tenant', decisionUserId: 'person', decisionOpenId: 'ou_person' }, sourceMessageId: 'source-question', sourceTurnId: 'source-turn', botSenderId: 'app' };
const consumer = () => ({ trigger: vi.fn(async () => { throw Error('not a real source consumer'); }), routeMetadata: vi.fn(() => { throw Error('not a real classifier'); }), receiveRoomEvent: vi.fn(async (_room: unknown, _data: unknown) => {}) });
let dataDir: string, previousDataDir: string, registry: AskHumanProtectionRegistry;
function protectedFixture(answer = true) {
  registry.provision(); const c = consumer(), unbind = registry.bindSource(f, c);
  if (answer) registry.protectAnswer(f);
  registry.registerRoom(f, 'report-chat', 'request-key', 'human_decision'); return { c, unbind };
}
const event = (id = 'human-message', body = '  A\r\n<原文>  ') => ({ message: { message_id: id, chat_id: 'report-chat', message_type: 'text', content: JSON.stringify({ text: body }) }, sender: { sender_type: 'user', sender_id: { open_id: 'ou_person' } } });
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'human-guards-')); previousDataDir = config.session.dataDir; config.session.dataDir = dataDir;
  registry = new AskHumanProtectionRegistry(join(dataDir, ASK_HUMAN_GUARD_DIRECTORY));
  for (const fn of Object.values(sdk)) fn.mockReset();
  for (const fn of [sdk.create, sdk.reply, sdk.patch, sdk.delete, sdk.reaction]) fn.mockResolvedValue({ code: 0, data: { message_id: 'sent', reaction_id: 'reaction' } });
  sdk.request.mockImplementation(async (request: any) => request.method === 'GET' ? { code: 0, data: { items: [{ chat_id: request.url.includes('ordinary') ? 'ordinary-chat' : 'report-chat' }] } } : { code: 0, data: { message_id: 'ephemeral' } });
});
afterEach(() => { config.session.dataDir = previousDataDir; rmSync(dataDir, { recursive: true, force: true }); });

describe('piece3 durable room and source protection', () => {
  it('absent feature is read-only and passes an ordinary room unchanged', async () => {
    expect(askHumanHasProtection(registry.root, 'app')).toBe(false);
    expect(await interceptAskHumanRoom(registry.root, 'app', 'ordinary', event())).toBe(false);
    assertAskHumanWorkerAllowed(dataDir, 'ordinary');
    await sendMessage('app', 'ordinary', 'unchanged'); await replyMessage('app', 'ordinary-id', 'unchanged');
    expect(sdk.create).toHaveBeenCalledOnce(); expect(sdk.reply).toHaveBeenCalledOnce(); expect(sdk.request).not.toHaveBeenCalled();
    expect(readdirSync(dataDir)).toEqual([]);
  });
  it('a title beginning 汇报 does not confer a room purpose', () => {
    registry.provision(); expect(askHumanRoomProtected(registry.root, '汇报·普通测试')).toBe(false);
    assertAskHumanWorkerAllowed(dataDir, '汇报·普通测试');
  });
  it('a concrete chat survives a fresh reader and two distinct rooms never alias', () => {
    protectedFixture(); registry.registerRoom(f, 'report-2', 'request-2', 'human_decision');
    const fresh = new AskHumanProtectionRegistry(registry.root);
    expect(fresh.room('report-chat')?.requestKey).toBe('request-key'); expect(fresh.room('report-2')?.requestKey).toBe('request-2');
    expect(() => registry.registerRoom(f, 'report-chat', 'other', 'human_decision')).toThrow();
  });
  it('identical local request keys in different direction lanes bind distinct rooms and cannot share a permit', () => {
    protectedFixture(); registry.registerRoom(f, 'answer-room', 'request-key', 'assistant_answer');
    expect(registry.room('answer-room')?.direction).toBe('assistant_answer');
    expect(() => registry.permit(f, 'request-key', 'human_decision', { appId: 'app', chatId: 'answer-room', content: 'wrong lane', uuid: 'u' }, () => {})).toThrow();
    registry.sealRoom('answer-room', 'request-key', 'assistant_answer');
    expect(registry.room('report-chat')?.sealed).toBe(false);
  });
  it('ordinary-session creation is rejected before the session store writes', () => {
    protectedFixture(); const before = readdirSync(dataDir);
    expect(() => createSession('report-chat', 'root', 'must not start')).toThrow('人类会话保护登记未获核实');
    expect(readdirSync(dataDir)).toEqual(before);
  });
  it.each(['claude-code', 'codex', 'gemini'])('worker last-line fence applies to %s across fork, adopt and input', async cliId => {
    protectedFixture();
    const worker = await import('../src/core/worker-pool.js');
    const send = vi.fn(), ds = { chatId: 'report-chat', larkAppId: 'app', session: { chatId: 'report-chat', sessionId: 'old-restored-session', cliId, backendType: 'tmux' }, worker: { send, killed: false } } as any;
    for (const fn of [() => worker.forkWorker(ds, 'no'), () => worker.forkAdoptWorker(ds),
      () => worker.sendWorkerInput(ds, 'no'), () => worker.sendWorkerSessionInput(ds, { type: 'input', text: 'no' } as any)]) {
      expect(fn).toThrow('人类会话保护登记未获核实');
    }
    expect(send).not.toHaveBeenCalled();
    ds.chatId = 'ordinary-chat'; ds.session.chatId = 'ordinary-chat';
    expect(worker.sendWorkerSessionInput(ds, { type: 'input', text: 'ordinary' } as any)).toBe(true);
    expect(send).toHaveBeenCalledOnce();
  });
  it('forwards an untouched raw event to the registered consumer, not a worker', async () => {
    const { c } = protectedFixture(), input = event(), before = JSON.stringify(input);
    expect(await interceptAskHumanRoom(registry.root, 'app', 'report-chat', input)).toBe(true);
    expect(c.receiveRoomEvent).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'report-chat' }), input);
    expect(JSON.stringify(input)).toBe(before);
    const record = JSON.parse(readFileSync(join(registry.root, 'events', readdirSync(join(registry.root, 'events'))[0]), 'utf8'));
    expect(record.raw).toBe(before); expect(record.delivered).toBe(true); expect(c.trigger).not.toHaveBeenCalled();
  });
  it('missing consumer cannot fall through; raw fault remains discoverable after restart', async () => {
    const { unbind } = protectedFixture(); unbind();
    await expect(interceptAskHumanRoom(registry.root, 'app', 'report-chat', event())).rejects.toMatchObject({ code: 'ROOM_CONSUMER_UNAVAILABLE' });
    const path = join(registry.root, 'events', readdirSync(join(registry.root, 'events'))[0]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ delivered: false, raw: JSON.stringify(event()) });
    expect(askHumanRoomProtected(registry.root, 'report-chat')).toBe(true);
  });
  it('consumer failure is journaled before callback and never invokes a fallback', async () => {
    const { c } = protectedFixture(); c.receiveRoomEvent.mockRejectedValueOnce(Error('offline'));
    await expect(interceptAskHumanRoom(registry.root, 'app', 'report-chat', event())).rejects.toThrow('offline');
    expect(readdirSync(join(registry.root, 'events'))).toHaveLength(1); expect(c.trigger).not.toHaveBeenCalled();
  });
  it('re-push uses one durable record and delegates execution dedupe to the source inbox', async () => {
    const { c } = protectedFixture();
    await interceptAskHumanRoom(registry.root, 'app', 'report-chat', event()); await interceptAskHumanRoom(registry.root, 'app', 'report-chat', event());
    expect(readdirSync(join(registry.root, 'events'))).toHaveLength(1); expect(c.receiveRoomEvent).toHaveBeenCalledTimes(2);
    await expect(interceptAskHumanRoom(registry.root, 'app', 'report-chat', event('human-message', 'modified'))).rejects.toMatchObject({ code: 'ROOM_EVENT_CONFLICT' });
  });
  it('sealed rooms stay isolated; later messages are journaled for new-question routing, never old answers', async () => {
    const { c } = protectedFixture(); registry.sealRoom('report-chat', 'request-key', 'human_decision');
    await interceptAskHumanRoom(registry.root, 'app', 'report-chat', event());
    expect(c.receiveRoomEvent.mock.calls[0][0]).toMatchObject({ sealed: true });
    expect(() => assertAskHumanWorkerAllowed(dataDir, 'report-chat')).toThrow();
    expect(() => registry.permit(f, 'request-key', 'human_decision', { appId: 'app', chatId: 'report-chat', content: 'late', uuid: 'u' }, () => {})).toThrow();
  });
  it('sibling app cannot consume this room or start a normal handler', async () => {
    const { c } = protectedFixture(); expect(await interceptAskHumanRoom(registry.root, 'other-app', 'report-chat', event())).toBe(true);
    expect(c.receiveRoomEvent).not.toHaveBeenCalled();
  });
  it.each(['app', 'other-human'])('unrelated %s message triggers neither consumer nor ordinary processing', async kind => {
    const { c } = protectedFixture(), input = event();
    if (kind === 'app') input.sender.sender_type = 'app'; else input.sender.sender_id.open_id = 'ou_other';
    const before = readdirSync(registry.root);
    expect(await interceptAskHumanRoom(registry.root, 'app', 'report-chat', input)).toBe(true);
    expect(c.receiveRoomEvent).not.toHaveBeenCalled(); expect(readdirSync(registry.root)).toEqual(before);
  });
  it('pending-create UUID blocks auto-invite/start before chat ID is returned; registration clears only that UUID', () => {
    protectedFixture(); registry.beginCreate('app', 'u1'); registry.beginCreate('app', 'u2');
    expect(askHumanBotJoinHeld(registry.root, 'app', 'new-room')).toBe(true);
    expect(askHumanBotJoinHeld(registry.root, 'other-app', 'new-room')).toBe(false);
    expect(() => registry.finishCreate('app', 'u1', 'unknown')).toThrow();
    registry.finishCreate('app', 'u1', 'report-chat'); expect(askHumanBotJoinHeld(registry.root, 'app', 'new-room')).toBe(true);
    registry.finishCreate('app', 'u2', 'report-chat'); expect(askHumanBotJoinHeld(registry.root, 'app', 'new-room')).toBe(false);
  });
  it('no source output fence is imposed for decision-only preparation', async () => {
    protectedFixture(false); await sendMessage('app', 'source-chat', 'business progress');
    expect(sdk.create).toHaveBeenCalledOnce(); expect(registry.answerGuarded(f)).toBe(false);
  });
  it.each(['corrupt', 'missing-index', 'symlink-index'])('unprovable index %s never becomes ordinary fallback', kind => {
    protectedFixture(); const path = join(registry.root, 'index.json');
    if (kind === 'corrupt') writeFileSync(path, '{');
    else { rmSync(path); if (kind === 'symlink-index') { writeFileSync(join(dataDir, 'alternate'), '{}'); symlinkSync(join(dataDir, 'alternate'), path); } }
    expect(() => askHumanRoomProtected(registry.root, 'report-chat')).toThrow();
  });
  it('real independent OS process sees the same fence without any callback registration', () => {
    protectedFixture();
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `import { assertAskHumanOutbound } from './src/core/ask-human-guards.ts'; try { assertAskHumanOutbound(process.argv[1], {appId:'app',chatId:'source-chat',operation:'send',content:'must not leak'}); process.exit(9); } catch(e) { if(e.code!=='OUTPUT_GUARD_BLOCKED') throw e; console.log(e.code); }`, registry.root], { encoding: 'utf8' });
    expect(output.trim()).toBe('OUTPUT_GUARD_BLOCKED');
  });
  it('four actual processes provision and register without losing an existing source fence', async () => {
    const script = `import {AskHumanProtectionRegistry} from './src/core/ask-human-guards.ts';
      const r=new AskHumanProtectionRegistry(process.argv[1]); r.provision(); const f=JSON.parse(process.argv[2]);
      r.bindSource(f,{trigger:async()=>{},routeMetadata:()=>{},receiveRoomEvent:async()=>{}}); r.protectAnswer(f);`;
    await Promise.all([0, 1, 2, 3].map(n => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, registry.root, JSON.stringify({ ...f, sourceTurnId: `turn-${n}` })])));
    const index = JSON.parse(readFileSync(join(registry.root, 'index.json'), 'utf8'));
    expect(index.sources).toHaveLength(4); expect(index.sources.every((s: any) => s.outputFence)).toBe(true);
    registry.provision(); expect(JSON.parse(readFileSync(join(registry.root, 'index.json'), 'utf8')).sources).toHaveLength(4);
  });
});

describe('piece3 real shared Lark egress functions with fake provider only', () => {
  const outputs: Array<[string, () => Promise<unknown>]> = [
    ['text', () => sendMessage('app', 'report-chat', 'answer')], ['card', () => sendMessage('app', 'report-chat', '{}', 'interactive')],
    ['post', () => sendMessage('app', 'report-chat', '{}', 'post')], ['image', () => sendMessage('app', 'report-chat', '{}', 'image')],
    ['file', () => sendMessage('app', 'report-chat', '{}', 'file')], ['reply', () => replyMessage('app', 'protected-id', 'answer')],
    ['stream patch', () => updateMessage('app', 'protected-id', '{}')], ['ephemeral', () => sendEphemeralCard('app', 'report-chat', 'ou_person', '{}')],
    ['DM', () => sendUserMessage('app', 'ou_person', 'answer')], ['reaction', () => addReaction('app', 'protected-id', 'OK')],
    ['remove reaction', () => removeReaction('app', 'protected-id', 'r')], ['delete', () => deleteMessage('app', 'protected-id')],
    ['delete ephemeral', () => deleteEphemeralCard('app', 'protected-id')],
  ];
  it.each(outputs)('%s cannot escape a registered fence or emit hooks', async (_name, invoke) => {
    protectedFixture(); await expect(invoke()).rejects.toMatchObject({ code: 'OUTPUT_GUARD_BLOCKED' });
    expect(sdk.create).not.toHaveBeenCalled(); expect(sdk.reply).not.toHaveBeenCalled(); expect(sdk.patch).not.toHaveBeenCalled(); expect(sdk.delete).not.toHaveBeenCalled(); expect(sdk.reaction).not.toHaveBeenCalled();
    expect(sdk.request.mock.calls.every(([r]) => r.method === 'GET')).toBe(true); expect(sdk.hook).not.toHaveBeenCalled();
  });
  it('registered exact-text/UUID permit sends once with no unrelated hook', async () => {
    protectedFixture(); const valid = vi.fn();
    const permit = registry.permit(f, 'request-key', 'human_decision', { appId: 'app', chatId: 'report-chat', content: 'reviewed text', uuid: 'uuid' }, valid);
    await sendMessage('app', 'report-chat', 'reviewed text', 'text', 'uuid', undefined, { humanSessionPermit: permit, suppressHook: true });
    expect(valid).toHaveBeenCalledTimes(2); expect(sdk.create).toHaveBeenCalledOnce(); expect(sdk.hook).not.toHaveBeenCalled();
  });
  it.each(['body', 'uuid', 'chat', 'type', 'serialized-token', 'revoked'])('permit cannot be reused after %s changes', async kind => {
    const { unbind } = protectedFixture();
    let permit = registry.permit(f, 'request-key', 'human_decision', { appId: 'app', chatId: 'report-chat', content: 'text', uuid: 'u' }, () => {});
    if (kind === 'serialized-token') permit = JSON.parse(JSON.stringify(permit));
    if (kind === 'revoked') unbind();
    await expect(sendMessage('app', kind === 'chat' ? 'source-chat' : 'report-chat', kind === 'body' ? 'changed' : 'text', kind === 'type' ? 'post' : 'text', kind === 'uuid' ? 'other' : 'u', undefined, { humanSessionPermit: permit })).rejects.toThrow();
    expect(sdk.create).not.toHaveBeenCalled();
  });
  it('a reply target read failure does not guess that the target is ordinary', async () => {
    protectedFixture(); sdk.request.mockRejectedValueOnce(Error('read failed'));
    await expect(replyMessage('app', 'unknown-id', 'secret')).rejects.toMatchObject({ code: 'OUTPUT_TARGET_UNPROVEN' }); expect(sdk.reply).not.toHaveBeenCalled();
  });
  it('a fence appearing during target lookup is checked immediately before write', async () => {
    registry.provision(); const c = consumer(); registry.bindSource(f, c); registry.registerRoom(f, 'report-chat', 'request-key', 'human_decision');
    sdk.request.mockImplementationOnce(async () => { registry.protectAnswer(f); return { code: 0, data: { items: [{ chat_id: 'source-chat' }] } }; });
    await expect(replyMessage('app', 'source-msg', 'answer')).rejects.toMatchObject({ code: 'OUTPUT_GUARD_BLOCKED' }); expect(sdk.reply).not.toHaveBeenCalled();
  });
  it('an unrelated group and another app source remain usable while protected sources are held', async () => {
    protectedFixture(); await sendMessage('app', 'ordinary-chat', 'ordinary'); await replyMessage('app', 'ordinary-id', 'ordinary');
    await updateMessage('app', 'ordinary-id', '{}'); await sendMessage('other-app', 'source-chat', 'ordinary'); await sendUserMessage('app', 'unrelated-person', 'ordinary');
    expect(sdk.create).toHaveBeenCalledTimes(3); expect(sdk.reply).toHaveBeenCalledOnce(); expect(sdk.patch).toHaveBeenCalledOnce();
  });
});

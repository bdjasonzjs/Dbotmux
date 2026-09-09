import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AskHumanAdmission, type AskHumanDirection, type AskHumanSourceBinding } from '../src/core/ask-human-admission.js';
import { askHumanHash, askHumanRoomName, parseAskHumanDraft, type AskHumanDraft } from '../src/core/ask-human-preflight.js';
import { parseAskHumanAnswerDraft, type AskHumanAnswerDraft } from '../src/core/ask-human-answer-preflight.js';
import { AskHumanLedger, type AskHumanFrame, type AskHumanReadMessage } from '../src/core/ask-human-ledger.js';
import { AskHumanExecutor, type AskHumanExecutorPorts } from '../src/core/ask-human-executor.js';
import { askHumanContentText, askHumanReadbackMatches, askHumanTextWire, type AskHumanWireContent } from '../src/core/ask-human-message.js';
import { AskHumanApi, type AskHumanApiDeps } from '../src/core/ask-human-api.js';
import { AskHumanRouting } from '../src/core/ask-human-routing.js';
import { AskHumanSourceInbox, createAskHumanSourcePorts } from '../src/core/ask-human-source.js';
import { AskHumanTransportReceipts } from '../src/core/ask-human-lark.js';

// Local failure injection only. No Lark groups, users, models or production paths.
const start = 1700000000000;
const source: AskHumanSourceBinding = { appId: 'test-app', sessionId: 'test-session', chatId: 'test-source', taskId: 'test-task', revision: '4', tenantId: 'test-tenant', decisionUserId: 'test-human', decisionOpenId: 'test-open-id' };
const frame: AskHumanFrame = { source, sourceMessageId: 'test-origin-message', sourceTurnId: 'test-turn', botSenderId: 'test-bot' };
const readers = { requester: source.sessionId, checker: 'isolated-fixture-checker' };
let root: string, rules: string, now: number, ledger: AskHumanLedger;
function draft(direction: AskHumanDirection): AskHumanDraft | AskHumanAnswerDraft {
  const common = { requestId: 'r1', shortTitle: '报名页面开放时间', background: '我们正在准备报名页面，测试尚未完成。', criticalFacts: [{ id: 'loss', explanation: '重大代价', text: '未经验证直接开放可能永久丢失报名。' }], references: [], expiresAt: start + 60000 };
  return direction === 'assistant_answer'
    ? { ...common, direction, answers: [{ question: '现在能开放报名吗？', conclusion: '不能。', basis: '真实提交尚未验证。', limitations: '本地测试不能证明线上安全。' }] }
    : { ...common, whyNow: '开放日期需要你决定。', decisions: [{ question: '选择今天还是明天开放？', options: ['A', 'B'].map(key => ({ key, label: key === 'A' ? '今天' : '明天', meaning: key === 'A' ? '立即开放' : '等待测试完成', difference: key === 'A' ? '早一天' : '多一天验证', consequence: key === 'A' ? '尚未验证就接收报名' : '完成验证再接收报名', cost: '可能延误一天', risk: '未经验证可能永久丢失记录' })) }] };
}
function prepare(direction: AskHumanDirection, input = draft(direction)) {
  const a = new AskHumanAdmission(join(root, 'admission'), rules, () => now, direction);
  for (const [role, actor] of Object.entries(readers)) {
    const r = a.readRules(source, 'r1', actor, role as 'requester' | 'checker');
    a.confirmRead(source, 'r1', actor, r.receiptToken, r.rules.sha256);
  }
  a.freezeFacts(source, 'r1', source.sessionId, input);
  const f = (s: string) => ({ summary: s, evidence: [s] });
  const report = 'answers' in input
    ? { problem: f(input.answers[0].question), conclusionAndBasis: f(input.answers[0].basis), limitations: f(input.answers[0].limitations), topicCount: 1, missingContext: [], unexplainedTerms: [], unsupportedAssumptions: [], offTopicClaims: [], declaredUnknowns: [] }
    : { problem: f(input.decisions[0].question), options: input.decisions[0].options.map(o => ({ key: o.key, difference: f(o.difference), consequence: f(o.consequence) })), decisionCount: 1, missingFacts: [], unexplainedTerms: [], unsupportedAssumptions: [], needsHumanPreference: true };
  const checked = a.check(source, 'r1', input, report, readers);
  if (checked === 'EXPIRED') throw Error('expired fixture');
  a.approveUnderstanding(source, 'r1', source.sessionId, checked.reportHash);
  return a;
}
function transport() {
  const messages = new Map<string, AskHumanReadMessage>(), sends: Parameters<AskHumanExecutorPorts['send']>[0][] = [], creates: Parameters<AskHumanExecutorPorts['createBotOnlyRoom']>[0][] = [], wakes: Parameters<AskHumanExecutorPorts['wakeSource']>[0][] = [];
  const lookup = new Map<string, string>();
  let invites = 0, deliveries = 0;
  const ports: AskHumanExecutorPorts = {
    runtimeAppId: source.appId, outputGuardReady: () => true,
    createBotOnlyRoom: async input => { creates.push(input); return 'test-room'; },
    readRoom: async roomId => ({ roomId, appId: source.appId, name: creates[0].name, private: true, memberIds: [frame.botSenderId] }),
    registerPurpose: async input => { expect(input.noWorker && input.noObserver).toBe(true); },
    inviteHuman: async () => { invites++; },
    send: async input => {
      sends.push(input); const messageId = `test-sent-${sends.length}`;
      const wire = askHumanTextWire(input.body, input.mentions);
      messages.set(messageId, { messageId, appId: source.appId, chatId: input.chatId, senderId: frame.botSenderId, senderType: 'bot', createdAt: now + 1, deleted: false, body: askHumanContentText(wire, input.mentions), wire });
      lookup.set(input.uuid, messageId); return { messageId };
    },
    readMessage: async id => { const m = messages.get(id); if (!m) throw Error('not found'); return structuredClone(m); },
    lookupSend: async input => { const id = lookup.get(input.uuid); return id ? { status: 'FOUND', messageId: id } : { status: 'UNKNOWN' }; },
    currentSource: async () => source,
    confirmDelivery: async input => { deliveries++; expect(input.message.messageId).toBe('test-sent-1'); return { sessionId: source.sessionId, messageId: input.message.messageId }; },
    wakeSource: async input => { wakes.push(input); return 'DISPATCHED'; },
    lookupWake: async () => ({ status: 'UNKNOWN' }),
    notifySourceEvent: async () => {},
  };
  function human(body = 'A\n 保留两个空格  。', messageId = 'test-human-message') {
    now += 10;
    const m: AskHumanReadMessage = { messageId, appId: source.appId, chatId: 'test-room', senderType: 'user', senderId: source.decisionOpenId, createdAt: now, deleted: false, body };
    messages.set(messageId, m); return m;
  }
  return { ports, messages, sends, creates, wakes, human, get invites() { return invites; }, get deliveries() { return deliveries; } };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ask-human-s2-')); rules = join(root, 'rules'); mkdirSync(rules); now = start;
  const content = '人类会话，一次一事，一问一新群，群名汇报·具体短标题。';
  writeFileSync(join(rules, 'rules.md'), content);
  writeFileSync(join(rules, 'current.json'), JSON.stringify({ version: 'r3', sha256: askHumanHash(content), file: 'rules.md', published: true }));
  ledger = new AskHumanLedger(join(root, 'ledger'), () => now);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('S2 prerequisite 4: one required caller-supplied room title', () => {
  for (const direction of ['human_decision', 'assistant_answer'] as const) {
    it.each([undefined, '', ' ', '关于某问题', '汇报·报名', ' 新报名事项', '报名\n页面', 'a'.repeat(31), 'om_012345678901234567'])(`${direction} rejects invalid title %s before any send/create`, title => {
      const d = { ...draft(direction), shortTitle: title }, t = transport();
      expect(() => prepare(direction, d as unknown as AskHumanDraft)).toThrow();
      expect(t.creates).toHaveLength(0); expect(t.sends).toHaveLength(0);
    });
    it(`${direction} sends the reviewed title to the create port`, async () => {
      const a = prepare(direction), t = transport();
      await new AskHumanExecutor(ledger, t.ports).present(a, frame, 'r1', readers);
      expect(t.creates[0].name).toBe('汇报·报名页面开放时间');
      expect(t.sends[0].body).toContain('本次事项：报名页面开放时间');
    });
  }
  it('neither schema defaults a missing title', () => {
    expect(() => parseAskHumanDraft({ ...draft('human_decision'), shortTitle: undefined })).toThrow();
    expect(() => parseAskHumanAnswerDraft({ ...draft('assistant_answer'), shortTitle: undefined })).toThrow();
    expect(askHumanRoomName('报名页面开放时间')).toBe('汇报·报名页面开放时间');
  });
  it('wrong returned room name prevents inviting the human', async () => {
    const a = prepare('human_decision'), t = transport(), read = t.ports.readRoom;
    t.ports.readRoom = async id => ({ ...await read(id), name: '别的群' });
    await expect(new AskHumanExecutor(ledger, t.ports).present(a, frame, 'r1', readers)).rejects.toThrow(/短标题/);
    expect(t.invites).toBe(0); expect(t.sends).toHaveLength(0);
  });
});

describe('S3 resumes a registered room without creating again', () => {
  for (const direction of ['human_decision', 'assistant_answer'] as const) {
    it.each(['purpose', 'invite'])(`${direction} resumes failure at %s`, async stage => {
      const a = prepare(direction), t = transport();
      const register = t.ports.registerPurpose, invite = t.ports.inviteHuman;
      if (stage === 'purpose') t.ports.registerPurpose = vi.fn().mockRejectedValueOnce(Error('crash')).mockImplementation(register);
      else t.ports.inviteHuman = vi.fn().mockRejectedValueOnce(Error('crash')).mockImplementation(invite);
      await expect(new AskHumanExecutor(ledger, t.ports).present(a, frame, 'r1', readers)).rejects.toThrow('crash');
      expect(ledger.get(source, direction, 'r1').state).toBe('ROOM_REGISTERED');
      expect(t.sends).toHaveLength(0);
      await new AskHumanExecutor(ledger, t.ports).reconcile(a, frame, 'r1', readers);
      expect(t.creates).toHaveLength(1);
      expect(t.sends.filter(s => s.chatId === 'test-room')).toHaveLength(1);
      expect(ledger.get(source, direction, 'r1').state).toBe(direction === 'human_decision' ? 'WAITING' : 'COMPLETED');
    });
  }
  it.each(['foreign member', 'expired', 'rules changed', 'source replaced'])('fails closed after registration: %s', async change => {
    const a = prepare('human_decision'), t = transport(), register = t.ports.registerPurpose;
    t.ports.registerPurpose = vi.fn().mockRejectedValueOnce(Error('crash')).mockImplementation(register);
    await expect(new AskHumanExecutor(ledger, t.ports).present(a, frame, 'r1', readers)).rejects.toThrow('crash');
    if (change === 'foreign member') { const old = t.ports.readRoom; t.ports.readRoom = async id => ({ ...await old(id), memberIds: ['test-bot', 'someone-else'] }); }
    if (change === 'expired') now += 61000;
    if (change === 'rules changed') writeFileSync(join(rules, 'rules.md'), 'modified');
    if (change === 'source replaced') t.ports.currentSource = async () => ({ ...source, taskId: 'another' });
    try { await new AskHumanExecutor(ledger, t.ports).reconcile(a, frame, 'r1', readers); } catch { /* expected failure retained in ledger */ }
    expect(t.creates).toHaveLength(1); expect(t.sends).toHaveLength(0); expect(t.invites).toBe(0);
  });
  it('already-invited verified human is not invited twice', async () => {
    const a = prepare('human_decision'), t = transport(), register = t.ports.registerPurpose;
    t.ports.registerPurpose = vi.fn().mockRejectedValueOnce(Error('crash')).mockImplementation(register);
    await expect(new AskHumanExecutor(ledger, t.ports).present(a, frame, 'r1', readers)).rejects.toThrow();
    const old = t.ports.readRoom;
    t.ports.readRoom = async id => ({ ...await old(id), memberIds: ['test-bot', source.decisionOpenId] });
    await new AskHumanExecutor(ledger, t.ports).reconcile(a, frame, 'r1', readers);
    expect(t.invites).toBe(0); expect(t.sends).toHaveLength(1);
  });
});

describe('S3 authenticated local handler and business inbox (not mounted IPC)', () => {
  const base = { sessionId: source.sessionId, originCapability: 'rotating-secret', requestId: 'r1', direction: 'human_decision' as AskHumanDirection };
  function service(a: AskHumanAdmission, t: ReturnType<typeof transport>) {
    const live = { frame: structuredClone(frame), liveOrigin: { capability: base.originCapability, turnId: frame.sourceTurnId }, closed: false, receiverSession: false };
    const deps: AskHumanApiDeps = {
      runtimeAppId: source.appId, resolveLive: id => id === source.sessionId ? live : undefined,
      admission: () => a, ledger, executor: new AskHumanExecutor(ledger, t.ports),
      inbox: new AskHumanSourceInbox(join(root, 'inbox')), routing: new AskHumanRouting(join(root, 'route')),
      routeMetadata: (_f, e) => ({ tenantId: source.tenantId, humanId: source.decisionUserId, chatId: e.raw.chatId, messageId: e.raw.messageId,
        mentionedAppIds: [source.appId], verifiedHuman: true, deleted: false, completeMentionsVerified: true, outputPathsGuarded: true }),
      checker: { actorId: readers.checker, evaluate: vi.fn(async () => { throw Error('checker fixture not configured'); }) }, assertEnabled: vi.fn(),
    };
    return { api: new AskHumanApi(deps), deps, live };
  }
  it.each([{ originCapability: 'wrong' }, { sessionId: 'other' }, { frame }, { source }, { trustedHost: true }, { report: { pass: true } }])('caller cannot forge source or quality authority %j', async override => {
    const t = transport(), s = service(prepare('human_decision'), t);
    await expect(s.api.handle({ ...base, operation: 'present', ...override })).rejects.toThrow();
    expect(t.creates).toHaveLength(0); expect(t.sends).toHaveLength(0);
  });
  it.each(['closed', 'receiver', 'turn', 'app'])('rejects stale or prohibited daemon binding %s', async change => {
    const t = transport(), s = service(prepare('human_decision'), t);
    if (change === 'closed') s.live.closed = true;
    if (change === 'receiver') s.live.receiverSession = true;
    if (change === 'turn') s.live.liveOrigin.turnId = 'new-turn';
    if (change === 'app') s.live.frame.source.appId = 'foreign';
    await expect(s.api.handle({ ...base, operation: 'present' })).rejects.toThrow(/来源/);
    expect(t.creates).toHaveLength(0);
  });
  it('explicit disabled gate blocks after quality approval and before creation', async () => {
    const t = transport(), s = service(prepare('human_decision'), t);
    vi.mocked(s.deps.assertEnabled).mockImplementation(() => { throw Error('not enabled'); });
    await expect(s.api.handle({ ...base, operation: 'present' })).rejects.toThrow('not enabled');
    expect(t.creates).toHaveLength(0);
  });
  it('missing current rules blocks this handler before transport', async () => {
    const t = transport(), s = service(prepare('human_decision'), t);
    rmSync(join(rules, 'current.json'));
    await expect(s.api.handle({ ...base, operation: 'present' })).rejects.toThrow();
    expect(t.creates).toHaveLength(0); expect(t.sends).toHaveLength(0);
  });
  it('checker gets complete current rules and body only, not business history', async () => {
    const t = transport(), s = service(prepare('human_decision'), t);
    vi.mocked(s.deps.checker.evaluate).mockResolvedValue({ selected: 'A', approved: true });
    await expect(s.api.handle({ ...base, operation: 'check', draft: draft('human_decision') })).rejects.toThrow();
    const input = vi.mocked(s.deps.checker.evaluate).mock.calls[0][0];
    expect(Object.keys(input).sort()).toEqual(['body', 'direction', 'rules']);
    expect(input.body).toContain('本次事项：报名页面开放时间'); expect(input.body).toContain('永久丢失');
    expect(input.rules.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(t.creates).toHaveLength(0);
  });
  it('source rotation during checker await invalidates the result', async () => {
    const t = transport(), s = service(prepare('human_decision'), t);
    vi.mocked(s.deps.checker.evaluate).mockImplementation(async () => { s.live.liveOrigin.capability = 'rotated'; return {}; });
    await expect(s.api.handle({ ...base, operation: 'check', draft: draft('human_decision') })).rejects.toMatchObject({ code: 'OPERATION_UNCERTAIN' });
    expect(t.creates).toHaveLength(0);
  });
  it('source routing consumer calls routing.claim for a follow-up, never revives old answer', async () => {
    const t = transport(), a = prepare('assistant_answer'), s = service(a, t), command = { ...base, direction: 'assistant_answer' };
    const notices = vi.fn(async () => {}); t.ports.notifySourceEvent = notices;
    await s.api.handle({ ...command, operation: 'present' });
    await s.deps.executor.receive(source, 'assistant_answer', 'r1', t.human('还有一个问题：何时验收？'));
    const e = ledger.get(source, 'assistant_answer', 'r1').events[0];
    expect(notices).toHaveBeenCalledTimes(1);
    const routed = await s.api.handle({ ...command, operation: 'route_event', eventId: e.eventId, classification: 'information_question', requiresMultiplePerspectives: false }) as any;
    expect(routed).toMatchObject({ route: 'ANSWER_IN_NEW_ROOM', eventId: e.eventId,
      nextRequest: { direction: 'assistant_answer', parentEventId: e.eventId, originalMessageId: e.raw.messageId, originalQuestion: e.raw.body } });
    expect(routed.nextRequest.requestId).not.toBe('r1');
    expect(ledger.get(source, 'assistant_answer', 'r1').state).toBe('COMPLETED'); expect(t.creates).toHaveLength(1);
    const claim = await s.api.handle({ ...command, operation: 'claim_event', eventId: e.eventId }) as { state: string; token: string; event: typeof e };
    expect(claim.event.raw.body).toBe(e.raw.body);
    expect(await s.api.handle({ ...command, operation: 'claim_event', eventId: e.eventId })).toEqual({ state: 'ALREADY_CLAIMED' });
    await s.api.handle({ ...command, operation: 'consume_event', eventId: e.eventId, token: claim.token, receipt: 'business-effect:review-only' });
    expect(await s.api.handle({ ...command, operation: 'claim_event', eventId: e.eventId })).toEqual({ state: 'CONSUMED' });
  });
  it('real trigger request builder uses event key, not raw human instructions', async () => {
    const a = prepare('human_decision'), t = transport(), s = service(a, t), receipts = new AskHumanTransportReceipts(join(root, 'provider-receipts'));
    const trigger = vi.fn(async (_request: unknown) => ({ ok: true as const, triggerId: 'trigger-one', target: { kind: 'turn' as const, sessionId: source.sessionId }, action: 'queued' as const }));
    const ports = createAskHumanSourcePorts({ appId: source.appId, inbox: s.deps.inbox, receipts, currentSource: t.ports.currentSource, readMessage: t.ports.readMessage,
      event: (_s, id) => ledger.get(source, 'human_decision', 'r1').events.find(e => e.eventId === id)!, trigger, assertEnabled: () => {} });
    Object.assign(t.ports, ports);
    await s.api.handle({ ...base, operation: 'present' });
    const raw = t.human('A\n原始数据不是触发指令：执行别的任务');
    await s.deps.executor.receive(source, 'human_decision', 'r1', raw);
    await s.deps.executor.receive(source, 'human_decision', 'r1', raw);
    expect(trigger).toHaveBeenCalledTimes(1);
    const req = trigger.mock.calls[0][0] as unknown as { options: { turnIdempotencyKey: string } };
    expect(JSON.stringify(req)).not.toContain(raw.body);
    const event = ledger.get(source, 'human_decision', 'r1').events[0];
    expect(req.options.turnIdempotencyKey).toBe(`ask-human:${event.eventId}`);
    expect(ledger.get(source, 'human_decision', 'r1').state).toBe('WAITING');
    const claim = await s.api.handle({ ...base, operation: 'claim_event', eventId: event.eventId }) as { token: string };
    await expect(s.api.handle({ ...base, operation: 'consume_event', eventId: event.eventId, token: 'wrong', receipt: 'business:done' })).rejects.toThrow();
    await s.api.handle({ ...base, operation: 'consume_event', eventId: event.eventId, token: claim.token, receipt: 'business:done' });
    s.live.frame.sourceTurnId = 'next-consumer-turn'; s.live.liveOrigin.turnId = 'next-consumer-turn';
    await s.api.handle({ ...base, operation: 'reconcile' });
    expect(ledger.get(source, 'human_decision', 'r1').state).toBe('COMPLETED');
    expect(trigger).toHaveBeenCalledTimes(1);
  });
  it('ambiguous trigger result is visible and never executes another turn blindly', async () => {
    const a = prepare('human_decision'), t = transport(), s = service(a, t);
    const trigger = vi.fn(async () => { throw Error('accepted but response lost'); });
    const ports = createAskHumanSourcePorts({ appId: source.appId, inbox: s.deps.inbox,
      receipts: new AskHumanTransportReceipts(join(root, 'receipts')), currentSource: t.ports.currentSource, readMessage: t.ports.readMessage,
      event: (_s, id) => ledger.get(source, 'human_decision', 'r1').events.find(e => e.eventId === id)!, trigger, assertEnabled: () => {} });
    Object.assign(t.ports, ports);
    await s.api.handle({ ...base, operation: 'present' });
    const raw = t.human('A');
    await expect(s.deps.executor.receive(source, 'human_decision', 'r1', raw)).rejects.toThrow('response lost');
    await s.deps.executor.receive(source, 'human_decision', 'r1', raw);
    const r = ledger.get(source, 'human_decision', 'r1');
    expect(r.wake).toBe('UNCERTAIN'); expect(r.sealed).toBe(false);
    expect(r.failures.some(f => f.key === 'wake-reconcile')).toBe(true);
    expect(trigger).toHaveBeenCalledTimes(1);
    const eventId = r.events[0].eventId;
    expect(await ports.lookupWake({ source, eventId, turnIdempotencyKey: `ask-human:${eventId}`, attemptId: r.wakeAttemptId! })).toEqual({ status: 'UNKNOWN' });
    const changed = { ...source, taskId: 'another-task' };
    expect(() => s.deps.inbox.claim(changed, eventId)).toThrow(/任务不符/);
  });
});

describe('S2 prerequisite 3: one raw-content projection, no human text rewriting', () => {
  const body = '重大代价：记录可能永久丢失。\n\n保留  两个空格。';
  it('outbound XML mention and inbound placeholder normalize identically', () => {
    const expected = askHumanContentText(askHumanTextWire(body, ['person']), ['person']);
    const wire: AskHumanWireContent = { type: 'text', content: JSON.stringify({ text: ` \r\n@_user_1 ${body.replace(/\n/g, '\r\n')}\r\n ` }), mentions: [{ key: '@_user_1', openId: 'person' }] };
    expect(askHumanContentText(wire, ['person'])).toBe(expected);
  });
  it('raw post at node, text styles and outer whitespace preserve content', () => {
    const wire: AskHumanWireContent = { type: 'post', content: JSON.stringify({ zh_cn: { title: '', content: [[{ tag: 'at', user_id: 'person', user_name: '显示名' }], [{ tag: 'text', text: `\n${body}\n`, style: ['bold'] }]] } }), mentions: [] };
    expect(askHumanContentText(wire, ['person'])).toBe(body);
    expect(askHumanReadbackMatches(body, ['person'], { body, wire })).toBe(true);
  });
  it.each(['重大代价：记录可能丢失。\n\n保留  两个空格。', '重大代价：记录可能永久丢失。\n\n保留 两个空格。', '重大代价：记录可能永久丢失。\n保留  两个空格。'])('does not normalize away changed facts or inner whitespace %s', changed => {
    expect(askHumanReadbackMatches(body, [], { body: changed })).toBe(false);
  });
  it('unexpected mention recipient cannot pass on identical prose', () => {
    expect(() => askHumanReadbackMatches(body, ['person'], { body, wire: askHumanTextWire(body, ['other']) })).toThrow();
  });
  it('literal at-looking user text is never globally stripped', () => {
    expect(askHumanContentText('原话 <at user_id="person"></at> 不要删除')).toBe('原话 <at user_id="person"></at> 不要删除');
  });
  it('unknown rich elements and alternate locale content fail closed', () => {
    for (const post of [{ content: [[{ tag: 'img', image_key: 'risk-image' }]] }, { content: [[{ tag: 'text', text: '安全', style: ['lineThrough'] }]] }, { zh_cn: { content: [] }, en_us: { content: [] } }]) {
      expect(() => askHumanContentText({ type: 'post', content: JSON.stringify(post), mentions: [] })).toThrow();
    }
  });
  it('wire/body disagreement cannot poison the persisted presentation', () => {
    expect(askHumanReadbackMatches(body, [], { body: '不同正文', wire: askHumanTextWire(body) })).toBe(false);
  });
});

describe('S2 prerequisite 1: recover known and uncertain sends by original intent', () => {
  it('adapter without raw content cannot acknowledge a real bot send', async () => {
    const a = prepare('assistant_answer'), t = transport(), read = t.ports.readMessage;
    t.ports.readMessage = async id => { const m = await read(id); delete m.wire; return m; };
    await expect(new AskHumanExecutor(ledger, t.ports).present(a, frame, 'r1', readers)).rejects.toThrow(/原始 content/);
    expect(t.deliveries).toBe(0); expect(ledger.get(source, 'assistant_answer', 'r1').state).toBe('ROOM_REGISTERED');
  });
  it('expired link-send uncertainty also retains a readback reconciliation path', async () => {
    const a = prepare('assistant_answer'), t = transport(), ex = new AskHumanExecutor(ledger, t.ports), read = t.ports.readMessage;
    t.ports.readMessage = async id => { if (id === 'test-sent-2') throw Error('link read unavailable'); return read(id); };
    await expect(ex.present(a, frame, 'r1', readers)).rejects.toThrow(); now += 60000; t.ports.readMessage = read;
    const r = await ex.reconcile(a, frame, 'r1', readers);
    expect(r.state).toBe('EXPIRED'); expect(r.intents.find(i => i.purpose === 'link')?.readback?.messageId).toBe('test-sent-2'); expect(t.sends).toHaveLength(2); expect(t.deliveries).toBe(0);
  });
  it.each(['presentation-read', 'presentation-checkpoint', 'link-read', 'source-ack'])('recovers crash at %s without duplicate room or send', async point => {
    const a = prepare('assistant_answer'), t = transport(), ex = new AskHumanExecutor(ledger, t.ports);
    const read = t.ports.readMessage, confirm = t.ports.confirmDelivery;
    let failOnce = true;
    if (point === 'presentation-checkpoint') vi.spyOn(ledger, 'recordPresented').mockImplementationOnce(() => { throw Error('crash'); });
    t.ports.readMessage = async id => { if (failOnce && ((point === 'presentation-read' && id === 'test-sent-1') || (point === 'link-read' && id === 'test-sent-2'))) { failOnce = false; throw Error('crash'); } return read(id); };
    t.ports.confirmDelivery = async input => { if (failOnce && point === 'source-ack') { failOnce = false; throw Error('crash'); } return confirm(input); };
    await expect(ex.present(a, frame, 'r1', readers)).rejects.toThrow(/crash/);
    ledger = new AskHumanLedger(join(root, 'ledger'), () => now);
    const restarted = new AskHumanExecutor(ledger, t.ports);
    expect((await restarted.reconcile(a, frame, 'r1', readers)).state).toBe('COMPLETED');
    await restarted.reconcile(a, frame, 'r1', readers);
    expect(t.creates).toHaveLength(1); expect(t.sends).toHaveLength(2); expect(t.deliveries).toBe(1);
  });
  it('recovers accepted send before finishSend was persisted, by UUID plus exact read', async () => {
    const a = prepare('human_decision'), t = transport();
    vi.spyOn(ledger, 'finishSend').mockImplementationOnce(() => { throw Error('crash before result record'); });
    await expect(new AskHumanExecutor(ledger, t.ports).present(a, frame, 'r1', readers)).rejects.toThrow(/crash/);
    expect(ledger.get(source, 'human_decision', 'r1').intents[0].status).toBe('ATTEMPTING');
    ledger = new AskHumanLedger(join(root, 'ledger'), () => now);
    expect((await new AskHumanExecutor(ledger, t.ports).reconcile(a, frame, 'r1', readers)).state).toBe('WAITING');
    expect(t.sends).toHaveLength(1);
  });
  it('read failure after relay-send does not lose or duplicate the candidate', async () => {
    const a = prepare('human_decision'), t = transport(), ex = new AskHumanExecutor(ledger, t.ports);
    await ex.present(a, frame, 'r1', readers); const human = t.human(), read = t.ports.readMessage;
    t.ports.readMessage = async id => { if (id === 'test-sent-2') throw Error('relay read failed'); return read(id); };
    await expect(ex.receive(source, 'human_decision', 'r1', human)).rejects.toThrow(/relay read/);
    expect(ledger.get(source, 'human_decision', 'r1').events[0].inboxAck).toBe(false);
    t.ports.readMessage = read; ledger = new AskHumanLedger(join(root, 'ledger'), () => now);
    await new AskHumanExecutor(ledger, t.ports).receive(source, 'human_decision', 'r1', human);
    const r = ledger.get(source, 'human_decision', 'r1');
    expect(r.events[0].raw.body).toBe(human.body); expect(r.events[0].inboxAck).toBe(true);
    expect(t.sends).toHaveLength(2); expect(t.wakes).toHaveLength(1);
  });
  it('crash after relay read but before inbox ACK is also recoverable', async () => {
    const a = prepare('human_decision'), t = transport(), ex = new AskHumanExecutor(ledger, t.ports);
    await ex.present(a, frame, 'r1', readers); const human = t.human();
    vi.spyOn(ledger, 'acknowledgeRelay').mockImplementationOnce(() => { throw Error('ack checkpoint crash'); });
    await expect(ex.receive(source, 'human_decision', 'r1', human)).rejects.toThrow(/checkpoint/);
    await new AskHumanExecutor(new AskHumanLedger(join(root, 'ledger'), () => now), t.ports).reconcile(a, frame, 'r1', readers);
    expect(t.sends).toHaveLength(2); expect(t.wakes).toHaveLength(1);
  });
  it('unknown UUID lookup stays visible, cannot create or send again', async () => {
    const a = prepare('human_decision'), t = transport(), ex = new AskHumanExecutor(ledger, t.ports), send = t.ports.send;
    t.ports.send = async input => { await send(input); throw Error('response lost'); };
    await expect(ex.present(a, frame, 'r1', readers)).rejects.toThrow(); t.ports.lookupSend = async () => ({ status: 'UNKNOWN' });
    await expect(ex.reconcile(a, frame, 'r1', readers)).rejects.toThrow(/未知/);
    expect(ledger.get(source, 'human_decision', 'r1').intents[0].status).toBe('UNCERTAIN');
    expect(t.sends).toHaveLength(1); expect(t.creates).toHaveLength(1);
  });
  it.each(['body', 'senderId', 'chatId', 'appId', 'messageId'])('wrong lookup/readback %s cannot confirm an uncertain send', async field => {
    const a = prepare('human_decision'), t = transport(), ex = new AskHumanExecutor(ledger, t.ports), send = t.ports.send, read = t.ports.readMessage;
    t.ports.send = async input => { await send(input); throw Error('response lost'); };
    await expect(ex.present(a, frame, 'r1', readers)).rejects.toThrow();
    t.ports.readMessage = async id => ({ ...await read(id), [field]: 'wrong' });
    await expect(ex.reconcile(a, frame, 'r1', readers)).rejects.toThrow();
    expect(ledger.get(source, 'human_decision', 'r1').intents[0].status).toBe('UNCERTAIN'); expect(t.sends).toHaveLength(1);
  });
  it('terminal NOT_SENT receipt permits a later retry with the same UUID, not a new request', async () => {
    const a = prepare('human_decision'), t = transport(), ex = new AskHumanExecutor(ledger, t.ports), send = t.ports.send;
    t.ports.send = async () => { throw Error('rejected before acceptance'); };
    await expect(ex.present(a, frame, 'r1', readers)).rejects.toThrow();
    const first = ledger.get(source, 'human_decision', 'r1').intents[0];
    t.ports.lookupSend = async () => ({ status: 'NOT_SENT', receiptId: 'test-final-rejection' });
    await expect(ex.reconcile(a, frame, 'r1', readers)).rejects.toThrow(/证实未发/);
    t.ports.send = send;
    expect((await ex.reconcile(a, frame, 'r1', readers)).state).toBe('WAITING');
    expect(t.sends[0].uuid).toBe(first.uuid); expect(t.creates).toHaveLength(1);
  });
  it('verified NOT_SENT retry must reread current rules before sending', async () => {
    const a = prepare('human_decision'), t = transport(), ex = new AskHumanExecutor(ledger, t.ports);
    t.ports.send = async () => { throw Error('rejected'); };
    await expect(ex.present(a, frame, 'r1', readers)).rejects.toThrow(); t.ports.lookupSend = async () => ({ status: 'NOT_SENT', receiptId: 'test-proof' });
    await expect(ex.reconcile(a, frame, 'r1', readers)).rejects.toThrow(); rmSync(join(rules, 'current.json'));
    await expect(ex.reconcile(a, frame, 'r1', readers)).rejects.toThrow(/细则/); expect(t.sends).toHaveLength(0);
  });
  it('expired confirmed presentation is audited but not reactivated', async () => {
    const a = prepare('human_decision'), t = transport(), ex = new AskHumanExecutor(ledger, t.ports), read = t.ports.readMessage;
    t.ports.readMessage = async () => { throw Error('no read'); };
    await expect(ex.present(a, frame, 'r1', readers)).rejects.toThrow(); now += 60000; t.ports.readMessage = read;
    const r = await ex.reconcile(a, frame, 'r1', readers);
    expect(r.state).toBe('EXPIRED'); expect(r.intents[0].readback?.messageId).toBe('test-sent-1'); expect(r.presented).toBeUndefined(); expect(ledger.head(source, 'human_decision')).toBeUndefined();
  });
});

describe('S2 prerequisite 2: follow-up messages are audited/relayed without reviving a task', () => {
  it.each(['completed-answer', 'completed-decision', 'expired-decision', 'cancelled-decision', 'waiting-answer'])('handles %s owner message once', async mode => {
    const direction = mode.includes('answer') ? 'assistant_answer' : 'human_decision', a = prepare(direction), t = transport(), ex = new AskHumanExecutor(ledger, t.ports);
    if (mode === 'waiting-answer') t.ports.confirmDelivery = async () => { throw Error('pending source ACK'); };
    if (mode === 'waiting-answer') await expect(ex.present(a, frame, 'r1', readers)).rejects.toThrow(); else await ex.present(a, frame, 'r1', readers);
    if (mode === 'completed-decision') { await ex.receive(source, direction, 'r1', t.human('A', 'candidate')); const e = ledger.get(source, direction, 'r1').events[0]; ledger.acknowledgeWake(source, 'r1', e.eventId, source.sessionId); ledger.seal(source, direction, 'r1'); }
    if (mode === 'expired-decision') now += 60000;
    if (mode === 'cancelled-decision') ledger.cancel(source, direction, 'r1');
    const before = ledger.get(source, direction, 'r1'), human = t.human('新的问题：报名记录现在怎样保存？', 'follow-up'), count = t.sends.length, wakeCount = t.wakes.length;
    await ex.receive(source, direction, 'r1', human); await ex.receive(source, direction, 'r1', human);
    const r = ledger.get(source, direction, 'r1'), event = r.events.find(e => e.raw.messageId === human.messageId)!;
    expect(event.kind).toBe(mode === 'waiting-answer' ? 'human_message' : 'routing_notice'); expect(event.inboxAck).toBe(true);
    expect(event.raw.body).toBe(human.body); expect(t.sends).toHaveLength(count + 1); expect(t.sends.at(-1)?.body).toContain('来源业务提示'); expect(t.sends.at(-1)?.chatId).toBe(source.chatId);
    expect(r.state).toBe(before.state); expect(r.sealed).toBe(before.sealed); expect(t.wakes).toHaveLength(wakeCount);
    if (before.sealed) expect(ledger.head(source, direction)).toBeUndefined();
  });
  it('late-message relay failure stays in the audit/outbox and can be reconciled', async () => {
    const a = prepare('assistant_answer'), t = transport(), ex = new AskHumanExecutor(ledger, t.ports);
    await ex.present(a, frame, 'r1', readers); const human = t.human(), send = t.ports.send;
    t.ports.send = async input => { await send(input); throw Error('late relay result lost'); };
    await expect(ex.receive(source, 'assistant_answer', 'r1', human)).rejects.toThrow();
    expect(ledger.get(source, 'assistant_answer', 'r1').events[0].inboxAck).toBe(false);
    await ex.reconcile(a, frame, 'r1', readers);
    const r = ledger.get(source, 'assistant_answer', 'r1'); expect(r.events[0].inboxAck).toBe(true); expect(r.state).toBe('COMPLETED'); expect(t.sends).toHaveLength(3); expect(t.wakes).toHaveLength(0);
  });
  it('source-ACKed answer with pending follow-up can finish after relay', async () => {
    const a = prepare('assistant_answer'), t = transport(), ex = new AskHumanExecutor(ledger, t.ports), ack = t.ports.confirmDelivery;
    t.ports.confirmDelivery = async input => { ledger.receive(source, 'assistant_answer', 'r1', t.human()); return ack(input); };
    expect((await ex.present(a, frame, 'r1', readers)).state).toBe('SOURCE_ACKED');
    expect((await ex.reconcile(a, frame, 'r1', readers)).state).toBe('COMPLETED'); expect(t.sends).toHaveLength(3);
  });
  it('stale source is a visible blocker, never a relay into a replacement task', async () => {
    const a = prepare('assistant_answer'), t = transport(), ex = new AskHumanExecutor(ledger, t.ports);
    await ex.present(a, frame, 'r1', readers); t.ports.currentSource = async () => ({ ...source, taskId: 'replacement' });
    await expect(ex.receive(source, 'assistant_answer', 'r1', t.human())).rejects.toThrow(/换任务/);
    const r = ledger.get(source, 'assistant_answer', 'r1'); expect(r.events).toHaveLength(1); expect(r.events[0].inboxAck).toBe(false); expect(r.failures.length).toBeGreaterThan(0); expect(t.sends).toHaveLength(2);
  });
});

describe('S2 prerequisite 1: uncertain wake reconciliation is not another human answer', () => {
  async function uncertain() {
    const a = prepare('human_decision'), t = transport(), ex = new AskHumanExecutor(ledger, t.ports);
    await ex.present(a, frame, 'r1', readers);
    t.ports.wakeSource = async input => { t.wakes.push(input); throw Error('wake response lost'); };
    await expect(ex.receive(source, 'human_decision', 'r1', t.human())).rejects.toThrow(/wake/);
    return { a, t, ex };
  }
  it.each(['DISPATCHED', 'CONSUMED'] as const)('accepts exact service %s receipt without another wake', async status => {
    const { a, t, ex } = await uncertain();
    t.ports.lookupWake = async input => ({ status, sessionId: source.sessionId, eventId: input.eventId, turnIdempotencyKey: input.turnIdempotencyKey, receiptId: 'test-service-receipt' });
    const r = await ex.reconcile(a, frame, 'r1', readers);
    expect(r.wake).toBe(status === 'CONSUMED' ? 'ACKED' : 'DISPATCHED'); expect(r.state).toBe(status === 'CONSUMED' ? 'COMPLETED' : 'WAITING'); expect(t.wakes).toHaveLength(1); expect(t.sends).toHaveLength(2);
  });
  it('UNKNOWN wake remains uncertain and visible without redispatch', async () => {
    const { a, t, ex } = await uncertain(); await ex.reconcile(a, frame, 'r1', readers);
    const r = ledger.get(source, 'human_decision', 'r1'); expect(r.wake).toBe('UNCERTAIN'); expect(r.failures.some(f => f.key === 'wake-reconcile')).toBe(true); expect(t.wakes).toHaveLength(1);
  });
  it.each(['sessionId', 'eventId', 'turnIdempotencyKey', 'receiptId'])('rejects wrong/empty wake %s', async field => {
    const { t, ex } = await uncertain();
    t.ports.lookupWake = async input => ({ status: 'CONSUMED', sessionId: source.sessionId, eventId: input.eventId, turnIdempotencyKey: input.turnIdempotencyKey, receiptId: 'test-proof', [field]: field === 'receiptId' ? '' : 'wrong' });
    await expect(ex.reconcileWake(source, 'r1')).rejects.toThrow(); expect(ledger.get(source, 'human_decision', 'r1').wake).toBe('UNCERTAIN');
  });
  it('terminal NOT_DISPATCHED permits same-event retry and rechecks live source', async () => {
    const { a, t, ex } = await uncertain(), first = t.wakes[0];
    t.ports.lookupWake = async input => ({ status: 'NOT_DISPATCHED', sessionId: source.sessionId, eventId: input.eventId, turnIdempotencyKey: input.turnIdempotencyKey, receiptId: 'test-terminal-rejection' });
    t.ports.currentSource = async () => null;
    await expect(ex.reconcile(a, frame, 'r1', readers)).rejects.toThrow(/关闭/); expect(t.wakes).toHaveLength(1);
    t.ports.currentSource = async () => source; t.ports.wakeSource = async input => { t.wakes.push(input); return 'DISPATCHED'; };
    await ex.reconcile(a, frame, 'r1', readers); expect(t.wakes).toHaveLength(2); expect(t.wakes[1].eventId).toBe(first.eventId); expect(t.wakes[1].turnIdempotencyKey).toBe(first.turnIdempotencyKey);
  });
});

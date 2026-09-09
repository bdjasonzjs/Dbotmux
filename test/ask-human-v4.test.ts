import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AskHumanAdmission, type AskHumanDirection, type AskHumanSourceBinding } from '../src/core/ask-human-admission.js';
import { askHumanHash, type AskHumanDraft } from '../src/core/ask-human-preflight.js';
import { parseAskHumanAnswerDraft, renderAskHumanAnswer, validateAskHumanAnswerUnderstanding, type AskHumanAnswerDraft, type AskHumanAnswerUnderstanding } from '../src/core/ask-human-answer-preflight.js';
import { AskHumanLedger, type AskHumanReadMessage, type AskHumanFrame } from '../src/core/ask-human-ledger.js';
import { AskHumanRouting, askHumanOutputAllowed, type AskHumanRouteInput } from '../src/core/ask-human-routing.js';
import { AskHumanExecutor, type AskHumanExecutorPorts } from '../src/core/ask-human-executor.js';
import { askHumanTextWire } from '../src/core/ask-human-message.js';
import { AskHumanReplyNotSent } from '../src/core/ask-human-reply.js';

// All sources, messages, groups, and model reports below are TEST FIXTURES.
// These are U tests, not P model runs, I production-entry tests or E Lark E2E.
const start = 1700000000000;
const source: AskHumanSourceBinding = { appId: 'app-a', sessionId: 'session-a', chatId: 'source-chat', taskId: 'task-a', revision: '4', tenantId: 'tenant-a', decisionUserId: 'human-a', decisionOpenId: 'human-scoped-a' };
const frame: AskHumanFrame = { source, sourceMessageId: 'source-message', sourceTurnId: 'turn-a', botSenderId: 'bot-a' };
const readers = { requester: source.sessionId, checker: 'fresh-checker' };
let root: string, rulesDir: string, now: number, ledger: AskHumanLedger;
function answer(id = 'a1'): AskHumanAnswerDraft {
  return { direction: 'assistant_answer', requestId: id, shortTitle: '报名页面上线条件', background: '我们在检查活动报名页面是否能开放。',
    answers: [{ question: '报名页能否上线？', conclusion: '暂时不能。', basis: '只完成本地表单测试。', limitations: '真实提交和失败恢复未验证，可能丢失报名。' }],
    criticalFacts: [{ id: 'risk', explanation: '不可恢复影响', text: '立即上线可能导致报名记录丢失，无法恢复。' }],
    references: [{ id: 'test-result-id', explanation: '本地表单检查记录，不是线上验证结果' }], expiresAt: start + 60000 };
}
function answerReport(d = answer()): AskHumanAnswerUnderstanding {
  const a = d.answers[0];
  return { problem: { summary: a.question, evidence: [a.question] }, conclusionAndBasis: { summary: a.conclusion + a.basis, evidence: [a.conclusion, a.basis] }, limitations: { summary: a.limitations, evidence: [a.limitations] }, topicCount: 1, missingContext: [], unexplainedTerms: [], unsupportedAssumptions: [], offTopicClaims: [], declaredUnknowns: ['尚无真实提交验证'] };
}
function decision(id = 'd1'): AskHumanDraft {
  return { requestId: id, shortTitle: '报名页面配色', background: '我们在制作报名页。', whyNow: '开发前需要确定外观。', decisions: [{ question: '选浅色还是深色？', options: ['A', 'B'].map(key => ({ key, label: key === 'A' ? '浅色' : '深色', meaning: key === 'A' ? '白底黑字' : '黑底白字', difference: key === 'A' ? '背景明亮' : '背景较暗', consequence: '按该配色实现', cost: '一天', risk: '之后换色需额外一天' })) }], criticalFacts: [], references: [], expiresAt: start + 60000 };
}
function decisionReport(d: AskHumanDraft) {
  return { problem: { summary: d.decisions[0].question, evidence: [d.decisions[0].question] }, options: d.decisions[0].options.map(o => ({ key: o.key, difference: { summary: o.difference, evidence: [o.difference] }, consequence: { summary: o.consequence, evidence: [o.consequence] } })), decisionCount: 1, missingFacts: [], unexplainedTerms: [], unsupportedAssumptions: [], needsHumanPreference: true };
}
function publish(version = '1') {
  const content = '只谈一件事，自带背景。检查不等于人类授权。';
  writeFileSync(join(rulesDir, 'rules.md'), content);
  writeFileSync(join(rulesDir, 'current.json'), JSON.stringify({ version, sha256: askHumanHash(content), file: 'rules.md', published: true }));
}
function admission(direction: AskHumanDirection) { return new AskHumanAdmission(join(root, 'admission'), rulesDir, () => now, direction); }
function prepare(direction: AskHumanDirection, id: string) {
  const a = admission(direction), d = direction === 'assistant_answer' ? answer(id) : decision(id);
  for (const [role, actor] of Object.entries(readers)) {
    const read = a.readRules(source, id, actor, role as 'requester' | 'checker');
    a.confirmRead(source, id, actor, read.receiptToken, read.rules.sha256);
  }
  a.freezeFacts(source, id, source.sessionId, d);
  const report = a.check(source, id, d, direction === 'assistant_answer' ? answerReport(d as AskHumanAnswerDraft) : decisionReport(d as AskHumanDraft), readers);
  if (report === 'EXPIRED') throw new Error('expired test fixture');
  a.approveUnderstanding(source, id, source.sessionId, report.reportHash);
  ledger.enqueue(a, frame, id, source.appId, readers);
  return a;
}
function message(chatId: string, body: string, id = 'message-a', senderType: 'user' | 'bot' = 'bot'): AskHumanReadMessage {
  return { messageId: id, chatId, body, senderType, senderId: senderType === 'bot' ? frame.botSenderId : source.decisionOpenId, appId: source.appId, createdAt: now + 1, deleted: false };
}
function present(a: AskHumanAdmission, id: string) {
  const r = ledger.beginCreate(a, source, id, readers);
  if (r.state === 'EXPIRED' || !('createAttemptId' in r)) throw new Error('bad fixture');
  ledger.registerRoom(source, a.direction, id, r.createAttemptId!, `room-${id}`);
  const send = ledger.beginSend(source, a.direction, id, 'presentation', a, readers);
  ledger.finishSend(source, a.direction, id, send.key, send.attemptId, { status: 'CONFIRMED', messageId: `present-${id}` });
  const m = message(`room-${id}`, send.body, `present-${id}`);
  ledger.recordPresented(source, a.direction, id, m);
  return m;
}
function finishDecision(id: string, raw = 'A\n 保留空格、原字！') {
  now += 10;
  const human = message(`room-${id}`, raw, `human-${id}`, 'user');
  const e = ledger.receive(source, 'human_decision', id, human)!;
  ledger.verifyOriginal(source, 'human_decision', id, e.eventId, human);
  const body = ledger.relayBody(source, 'human_decision', id, e.eventId);
  const relay = message(source.chatId, body, `relay-${id}`);
  expect(ledger.acknowledgeRelay(source, 'human_decision', id, e.eventId, relay)).toBe(true);
  const wake = ledger.beginWake(source, id, source);
  ledger.recordWake(source, id, wake.attemptId, 'DISPATCHED');
  ledger.acknowledgeWake(source, id, e.eventId, source.sessionId);
  ledger.seal(source, 'human_decision', id);
  return { e, relay, human };
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ask-human-v4-')); rulesDir = join(root, 'rules'); mkdirSync(rulesDir); now = start; publish(); ledger = new AskHumanLedger(join(root, 'ledger'), () => now); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('answer-direction understanding and shared prerequisite gate', () => {
  it('does not require choices; declared unknowns remain valid', () => { const a = prepare('assistant_answer', 'a1'); expect(a.admit(source, 'a1', source.appId, readers).state).toBe('ADMISSIBLE'); });
  it.each(['background', 'answers', 'criticalFacts', 'expiresAt'])('rejects missing %s', field => { const d = answer() as unknown as Record<string, unknown>; delete d[field]; expect(() => parseAskHumanAnswerDraft(d)).toThrow(); });
  it('rejects two independent answers even with a single question mark', () => { const d = answer(); d.answers.push(d.answers[0]); expect(() => parseAskHumanAnswerDraft(d)).toThrow(); });
  it.each(['missingContext', 'unexplainedTerms', 'unsupportedAssumptions', 'offTopicClaims'])('rejects %s finding', field => {
    const d = answer(), r = { version: '1', sha256: 'h', text: 'rules' };
    expect(() => validateAskHumanAnswerUnderstanding(d, renderAskHumanAnswer(d), r, { ...answerReport(d), [field]: ['坏例'] })).toThrow(/背景/);
  });
  it.each(['selected', 'approved', 'answer'])('rejects quality-model %s as extraneous authority', field => {
    expect(() => validateAskHumanAnswerUnderstanding(answer(), renderAskHumanAnswer(answer()), { version: '1', sha256: 'h', text: 'rules' }, { ...answerReport(), [field]: 'A' })).toThrow(/格式/);
  });
  it('requires current rules before queue admission', () => { const a = admission('assistant_answer'); expect(() => ledger.enqueue(a, frame, 'a1', source.appId, readers)).toThrow(); expect(ledger.head(source, 'assistant_answer')).toBeUndefined(); });
  it('cannot remove risk after fact freeze', () => { const a = prepare('assistant_answer', 'a1'), d = answer(); d.criticalFacts = []; expect(() => a.check(source, 'a1', d, answerReport(d), readers)).toThrow(/风险/); });
  it('cannot switch a decision request to answer schema', () => { prepare('human_decision', 'd1'); expect(() => admission('assistant_answer').readRules(source, 'd1', source.sessionId, 'requester')).toThrow(/身份/); });
  it('revalidates current rules before creation and sending', () => { const a = prepare('assistant_answer', 'a1'); const r = ledger.beginCreate(a, source, 'a1', readers); if (!('createAttemptId' in r)) throw Error(); ledger.registerRoom(source, 'assistant_answer', 'a1', r.createAttemptId!, 'room-a1'); publish('2'); expect(() => ledger.beginSend(source, 'assistant_answer', 'a1', 'presentation', a, readers)).toThrow(/细则/); });
  it('presentation send requires actual admission, not a client marker', () => { prepare('assistant_answer', 'a1'); expect(() => ledger.beginSend(source, 'assistant_answer', 'a1', 'presentation')).toThrow(/细则/); });
});

describe('independent durable lanes and actual readback contract', () => {
  it('D1 WAITING does not block A1; A2 waits only for A1 readback/source ack', () => {
    present(prepare('human_decision', 'd1'), 'd1'); const a1 = prepare('assistant_answer', 'a1'), a2 = prepare('assistant_answer', 'a2');
    const m = present(a1, 'a1'); expect(() => ledger.beginCreate(a2, source, 'a2', readers)).toThrow(/前一项/);
    ledger.acknowledgeAnswerDelivery(source, 'a1', source.sessionId, m.messageId); ledger.seal(source, 'assistant_answer', 'a1');
    expect(ledger.beginCreate(a2, source, 'a2', readers).state).toBe('CREATING'); expect(ledger.get(source, 'human_decision', 'd1').state).toBe('WAITING');
  });
  it('A1 readback failure does not block D2 after D1 completes', () => {
    const a = prepare('assistant_answer', 'a1'); present(a, 'a1');
    expect(() => ledger.acknowledgeAnswerDelivery(source, 'a1', source.sessionId, 'wrong')).toThrow();
    present(prepare('human_decision', 'd1'), 'd1'); const d2 = prepare('human_decision', 'd2'); finishDecision('d1');
    expect(ledger.beginCreate(d2, source, 'd2', readers).state).toBe('CREATING'); expect(ledger.get(source, 'assistant_answer', 'a1').state).toBe('ANSWER_DELIVERED');
  });
  it('restart preserves independent occupancy and does not create another group', () => {
    present(prepare('human_decision', 'd1'), 'd1'); const a = prepare('assistant_answer', 'a1'); ledger.beginCreate(a, source, 'a1', readers);
    ledger = new AskHumanLedger(join(root, 'ledger'), () => now);
    expect(ledger.head(source, 'human_decision')?.requestId).toBe('d1'); expect(ledger.head(source, 'assistant_answer')?.requestId).toBe('a1');
    expect(() => ledger.beginCreate(a, source, 'a1', readers)).toThrow(/意图/);
  });
  it('four real OS processes racing one head produce one creation intent', async () => {
    prepare('assistant_answer', 'a1');
    const script = `
      import { AskHumanAdmission } from './src/core/ask-human-admission.ts';
      import { AskHumanLedger } from './src/core/ask-human-ledger.ts';
      const root=process.argv[1], source=${JSON.stringify(source)}, readers=${JSON.stringify(readers)};
      const a=new AskHumanAdmission(root+'/admission',root+'/rules',()=>${start},'assistant_answer');
      const l=new AskHumanLedger(root+'/ledger',()=>${start});
      try { const r=l.beginCreate(a,source,'a1',readers); process.stdout.write(JSON.stringify({ok:true,attempt:r.createAttemptId})); }
      catch(e){ process.stdout.write(JSON.stringify({ok:false,code:e.code})); }
    `;
    const results = await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script, root], { cwd: process.cwd(), timeout: 15000 })));
    const outcomes = results.map(r => JSON.parse(r.stdout));
    expect(outcomes.filter(r => r.ok)).toHaveLength(1);
    expect(outcomes.filter(r => !r.ok).every(r => r.code === 'CREATE_UNCERTAIN')).toBe(true);
  });
  it('corrupt answer journal does not reset or block the decision journal', () => {
    prepare('assistant_answer', 'a1'); present(prepare('human_decision', 'd1'), 'd1');
    writeFileSync(join(root, 'ledger', `${ledger.lane(source, 'assistant_answer')}.json`), '{');
    expect(() => ledger.head(source, 'assistant_answer')).toThrow(/损坏/); expect(ledger.head(source, 'human_decision')?.state).toBe('WAITING');
  });
  it('send success without readback is insufficient for source ACK or sealing', () => {
    const a = prepare('assistant_answer', 'a1'), r = ledger.beginCreate(a, source, 'a1', readers); if (!('createAttemptId' in r)) throw Error();
    ledger.registerRoom(source, 'assistant_answer', 'a1', r.createAttemptId!, 'room-a1'); const send = ledger.beginSend(source, 'assistant_answer', 'a1', 'presentation', a, readers);
    ledger.finishSend(source, 'assistant_answer', 'a1', send.key, send.attemptId, { status: 'CONFIRMED', messageId: 'only-send-id' });
    expect(() => ledger.acknowledgeAnswerDelivery(source, 'a1', source.sessionId, 'only-send-id')).toThrow(/真实回读/); expect(() => ledger.seal(source, 'assistant_answer', 'a1')).toThrow();
  });
  it.each(['chatId', 'senderId', 'appId', 'body', 'senderType', 'deleted'])('rejects wrong readback %s', field => {
    const a = prepare('assistant_answer', 'a1'), r = ledger.beginCreate(a, source, 'a1', readers); if (!('createAttemptId' in r)) throw Error();
    ledger.registerRoom(source, 'assistant_answer', 'a1', r.createAttemptId!, 'room-a1');
    const m = message('room-a1', ledger.get(source, 'assistant_answer', 'a1').body);
    expect(() => ledger.recordPresented(source, 'assistant_answer', 'a1', { ...m, [field]: field === 'deleted' ? true : field === 'senderType' ? 'user' : 'wrong' })).toThrow();
  });
  it('default source receipt is only a link with no mentions, and is idempotent', () => {
    present(prepare('assistant_answer', 'a1'), 'a1'); const receipt = ledger.beginSend(source, 'assistant_answer', 'a1', 'link');
    expect(receipt.mentions).toEqual([]); expect(receipt.body).toMatch(/^https:\/\/[^\s]+openChatId=room-a1$/); expect(receipt.chatId).toBe(source.chatId);
    ledger.finishSend(source, 'assistant_answer', 'a1', receipt.key, receipt.attemptId, { status: 'CONFIRMED', messageId: 'link-1' });
    expect(() => ledger.beginSend(source, 'assistant_answer', 'a1', 'link')).toThrow(/重复发送/);
  });
  it('unknown send is visible, restart cannot blindly resend; verified NOT_SENT can retry same key', () => {
    present(prepare('assistant_answer', 'a1'), 'a1'); const i = ledger.beginSend(source, 'assistant_answer', 'a1', 'link');
    ledger.finishSend(source, 'assistant_answer', 'a1', i.key, i.attemptId, { status: 'UNCERTAIN', error: 'timeout' });
    ledger = new AskHumanLedger(join(root, 'ledger'), () => now);
    expect(ledger.get(source, 'assistant_answer', 'a1').failures).toHaveLength(1); expect(() => ledger.beginSend(source, 'assistant_answer', 'a1', 'link')).toThrow();
    ledger.finishSend(source, 'assistant_answer', 'a1', i.key, i.attemptId, { status: 'NOT_SENT', error: 'confirmed absent by transport reconciliation' });
    const retry = ledger.beginSend(source, 'assistant_answer', 'a1', 'link'); expect(retry.key).toBe(i.key); expect(retry.uuid).toBe(i.uuid); expect(retry.uuid.length).toBeLessThanOrEqual(50); expect(retry.attemptId).not.toBe(i.attemptId);
    expect(() => ledger.finishSend(source, 'assistant_answer', 'a1', i.key, i.attemptId, { status: 'CONFIRMED', messageId: 'late' })).toThrow(/旧意图/);
  });
  it('expiry and cancel release lane; no automatic consent', () => {
    present(prepare('human_decision', 'd1'), 'd1'); prepare('assistant_answer', 'a1'); ledger.cancel(source, 'assistant_answer', 'a1'); expect(ledger.head(source, 'assistant_answer')).toBeUndefined();
    now = start + 60000; expect(ledger.head(source, 'human_decision')).toBeUndefined(); const d = ledger.get(source, 'human_decision', 'd1'); expect(d.state).toBe('EXPIRED'); expect(d.events).toEqual([]);
  });
  it('two requests get distinct rooms; sealed room only records a routing notice', () => {
    const m = present(prepare('assistant_answer', 'a1'), 'a1'); ledger.acknowledgeAnswerDelivery(source, 'a1', source.sessionId, m.messageId); ledger.seal(source, 'assistant_answer', 'a1');
    const next = present(prepare('assistant_answer', 'a2'), 'a2'); expect(m.chatId).not.toBe(next.chatId); now += 20;
    expect(ledger.receive(source, 'assistant_answer', 'a1', message(m.chatId, '新问题', 'late', 'user'))?.kind).toBe('routing_notice');
    expect(ledger.get(source, 'assistant_answer', 'a1').state).toBe('COMPLETED');
  });
  it('cannot reuse a decision room for an answer even after the decision is sealed', () => {
    present(prepare('human_decision', 'd1'), 'd1'); finishDecision('d1');
    const a = prepare('assistant_answer', 'a1'), r = ledger.beginCreate(a, source, 'a1', readers); if (!('createAttemptId' in r)) throw Error();
    expect(() => ledger.registerRoom(source, 'assistant_answer', 'a1', r.createAttemptId!, 'room-d1')).toThrow(/复用/);
  });
  it('late create result is registered for audit, never reactivates a cancelled request', () => {
    const a = prepare('assistant_answer', 'a1'), r = ledger.beginCreate(a, source, 'a1', readers); if (!('createAttemptId' in r)) throw Error();
    ledger.cancel(source, 'assistant_answer', 'a1');
    expect(ledger.registerRoom(source, 'assistant_answer', 'a1', r.createAttemptId!, 'late-room').state).toBe('CANCELLED');
    expect(() => ledger.recordPresented(source, 'assistant_answer', 'a1', message('late-room', r.body))).toThrow();
    expect(ledger.head(source, 'assistant_answer')).toBeUndefined();
  });
  it('stale create completion cannot claim a room', () => {
    const a = prepare('assistant_answer', 'a1'); ledger.beginCreate(a, source, 'a1', readers);
    expect(() => ledger.registerRoom(source, 'assistant_answer', 'a1', 'wrong-attempt', 'wrong-room')).toThrow(/不符/);
    expect(readdirSync(join(root, 'ledger')).filter(f => f.startsWith('room-'))).toEqual([]);
  });
  it('repeated room/readback completion never rewinds source acknowledgement', () => {
    const m = present(prepare('assistant_answer', 'a1'), 'a1'), r = ledger.get(source, 'assistant_answer', 'a1');
    ledger.acknowledgeAnswerDelivery(source, 'a1', source.sessionId, m.messageId);
    expect(ledger.registerRoom(source, 'assistant_answer', 'a1', r.createAttemptId!, m.chatId).state).toBe('SOURCE_ACKED');
    expect(ledger.recordPresented(source, 'assistant_answer', 'a1', m).state).toBe('SOURCE_ACKED');
  });
  it('admission frame changes cannot reroute the request to a new turn or source', () => {
    const a = prepare('assistant_answer', 'a1');
    expect(() => ledger.enqueue(a, { ...frame, sourceTurnId: 'different-turn' }, 'a1', source.appId, readers)).toThrow(/来源/);
    expect(() => ledger.get({ ...source, taskId: 'different-task' }, 'assistant_answer', 'a1')).toThrow(/来源/);
  });
  it('cancelled/expired candidates never revive the queue', () => {
    present(prepare('human_decision', 'd1'), 'd1'); now += 60000;
    expect(ledger.receive(source, 'human_decision', 'd1', message('room-d1', 'A', 'too-late', 'user'))?.kind).toBe('routing_notice');
    expect(ledger.get(source, 'human_decision', 'd1').state).toBe('EXPIRED');
  });
});

describe('raw candidate, inbox and controlled source wake', () => {
  it('accepts unquoted first human message verbatim and wakes/acks only once', () => {
    present(prepare('human_decision', 'd1'), 'd1'); const { e, relay, human } = finishDecision('d1');
    expect(e.raw.body).toBe(human.body); expect(relay.body).toContain(`\n${human.body}\n`);
    expect(ledger.acknowledgeRelay(source, 'human_decision', 'd1', e.eventId, relay)).toBe(false);
    expect(ledger.acknowledgeWake(source, 'd1', e.eventId, source.sessionId)).toBe(false);
    expect(() => ledger.beginWake(source, 'd1', source)).toThrow();
  });
  it.each(['senderId', 'appId', 'chatId', 'senderType', 'deleted'])('ignores unrelated or invalid sender field %s', field => {
    present(prepare('human_decision', 'd1'), 'd1'); now += 10; const m = message('room-d1', 'A', 'human', 'user');
    const value = field === 'senderType' ? 'bot' : field === 'deleted' ? true : 'other';
    expect(ledger.receive(source, 'human_decision', 'd1', { ...m, [field]: value })).toBeUndefined();
  });
  it('supplement cannot overwrite candidate or seal before delivery', () => {
    present(prepare('human_decision', 'd1'), 'd1'); now += 10;
    const first = ledger.receive(source, 'human_decision', 'd1', message('room-d1', 'A', 'h1', 'user'))!;
    const supplement = ledger.receive(source, 'human_decision', 'd1', message('room-d1', '补充', 'h2', 'user'))!;
    expect(first.kind).toBe('human_candidate'); expect(supplement.kind).toBe('supplement'); expect(() => ledger.seal(source, 'human_decision', 'd1')).toThrow();
    expect(() => ledger.cancel(source, 'human_decision', 'd1')).toThrow(/已收到/);
    now += 60000; expect(ledger.get(source, 'human_decision', 'd1').events[0].raw.body).toBe('A');
  });
  it('answer-direction human message cannot become human_candidate or trigger decision wake', () => {
    present(prepare('assistant_answer', 'a1'), 'a1'); now += 10;
    const e = ledger.receive(source, 'assistant_answer', 'a1', message('room-a1', '收到', 'human-a1', 'user'))!;
    expect(e.kind).toBe('human_message'); expect(ledger.get(source, 'assistant_answer', 'a1').wake).toBe('NONE'); expect(() => ledger.beginWake(source, 'a1', source)).toThrow();
  });
  it('same raw message duplicated is one event; edited raw message fails closed', () => {
    present(prepare('human_decision', 'd1'), 'd1'); now += 10;
    const m = message('room-d1', '原话\n 保持！', 'h1', 'user');
    const a = ledger.receive(source, 'human_decision', 'd1', m), b = ledger.receive(source, 'human_decision', 'd1', m);
    expect(a?.eventId).toBe(b?.eventId); expect(ledger.get(source, 'human_decision', 'd1').events).toHaveLength(1);
    expect(() => ledger.receive(source, 'human_decision', 'd1', { ...m, body: '换一个答案' })).toThrow(/不能覆盖/);
  });
  it('cannot forward without original readback or with an edited original', () => {
    present(prepare('human_decision', 'd1'), 'd1'); now += 10;
    const m = message('room-d1', 'A', 'h1', 'user'), e = ledger.receive(source, 'human_decision', 'd1', m)!;
    expect(() => ledger.relayBody(source, 'human_decision', 'd1', e.eventId)).toThrow(/回读/);
    expect(() => ledger.verifyOriginal(source, 'human_decision', 'd1', e.eventId, { ...m, deleted: true })).toThrow();
    expect(() => ledger.verifyOriginal(source, 'human_decision', 'd1', e.eventId, { ...m, body: 'B' })).toThrow();
  });
  it('persisted inbox ACK is still idempotent after restart', () => {
    present(prepare('human_decision', 'd1'), 'd1'); const { e, relay } = finishDecision('d1');
    ledger = new AskHumanLedger(join(root, 'ledger'), () => now);
    expect(ledger.acknowledgeRelay(source, 'human_decision', 'd1', e.eventId, relay)).toBe(false);
    expect(ledger.acknowledgeWake(source, 'd1', e.eventId, source.sessionId)).toBe(false);
    expect(ledger.get(source, 'human_decision', 'd1').events).toHaveLength(1);
  });
  it('closed/rebound source never wakes, uncertainty never becomes success', () => {
    present(prepare('human_decision', 'd1'), 'd1'); now += 10;
    const m = message('room-d1', 'A', 'human-d1', 'user'), e = ledger.receive(source, 'human_decision', 'd1', m)!;
    ledger.verifyOriginal(source, 'human_decision', 'd1', e.eventId, m); const body = ledger.relayBody(source, 'human_decision', 'd1', e.eventId);
    ledger.acknowledgeRelay(source, 'human_decision', 'd1', e.eventId, message(source.chatId, body));
    expect(() => ledger.beginWake(source, 'd1', null)).toThrow(/关闭/); expect(() => ledger.beginWake(source, 'd1', { ...source, taskId: 'new' })).toThrow();
    const wake = ledger.beginWake(source, 'd1', source); expect(wake.turnIdempotencyKey).toContain(e.eventId);
    ledger.recordWake(source, 'd1', wake.attemptId, 'UNCERTAIN'); expect(() => ledger.beginWake(source, 'd1', source)).toThrow(); expect(() => ledger.seal(source, 'human_decision', 'd1')).toThrow();
  });
});

describe('same-source lease and per-turn output policy (not installed hooks)', () => {
  const route: AskHumanRouteInput = { tenantId: 't', humanId: 'h', chatId: 'c', messageId: 'm', mentionedAppIds: ['app-b', 'app-a'], classification: 'information_question', verifiedHuman: true, deleted: false, completeMentionsVerified: true, requiresMultiplePerspectives: false, outputPathsGuarded: true };
  it('one independent answerer, others abstain even if they race first', () => {
    const r = new AskHumanRouting(join(root, 'routes')); expect(r.claim(route, 'app-b')).toBe('ABSTAIN'); expect(r.claim(route, 'app-a')).toBe('ANSWER_IN_NEW_ROOM');
    expect(new AskHumanRouting(join(root, 'routes')).claim(route, 'app-a')).toBe('ANSWER_IN_NEW_ROOM'); expect(r.claim(route, 'app-b')).toBe('ABSTAIN');
  });
  it.each(['instruction', 'confirmation', 'dedicated_routine'] as const)('%s stays in business', classification => { expect(new AskHumanRouting(join(root, 'routes')).claim({ ...route, classification }, 'app-a')).toBe('ORIGINAL_BUSINESS'); });
  it('multiple perspectives require original business review, not aggregation', () => { expect(new AskHumanRouting(join(root, 'routes')).claim({ ...route, requiresMultiplePerspectives: true }, 'app-a')).toBe('ROUTING_REVIEW_REQUIRED'); });
  it('missing output protection blocks the new direction', () => { expect(new AskHumanRouting(join(root, 'routes')).claim({ ...route, outputPathsGuarded: false }, 'app-a')).toBe('OUTPUT_GUARD_UNAVAILABLE'); });
  it('changed source interpretation cannot silently replace lease', () => { const r = new AskHumanRouting(join(root, 'routes')); r.claim(route, 'app-a'); expect(r.claim({ ...route, responsibleAppId: 'app-a' }, 'app-a')).toBe('ROUTING_REVIEW_REQUIRED'); });
  it.each(['final', 'stream', 'explicit_send', 'service_send'] as const)('blocks source output for %s and permits unrelated turns', path => {
    const binding = { sessionId: 's', turnId: 't', sourceChatId: 'origin', roomId: 'room' };
    expect(askHumanOutputAllowed(true, binding, { sessionId: 's', turnId: 't', chatId: 'origin', path })).toBe(false);
    expect(askHumanOutputAllowed(true, binding, { sessionId: 's', turnId: 't', chatId: 'room', path })).toBe(true);
    expect(askHumanOutputAllowed(true, undefined, { sessionId: 's', turnId: 't', chatId: 'room', path })).toBe(false);
    expect(askHumanOutputAllowed(false, undefined, { sessionId: 'other', turnId: 'other', chatId: 'origin', path })).toBe(true);
  });
});

describe('local executor with isolated fake ports; no real Lark operations', () => {
  function transport() {
    const order: string[] = [], messages = new Map<string, AskHumanReadMessage>();
    let sequence = 0, roomName = '';
    const ports: AskHumanExecutorPorts = {
      runtimeAppId: source.appId,
      outputGuardReady: () => true,
      createBotOnlyRoom: async input => { roomName = input.name; order.push('create'); return 'fake-room'; },
      readRoom: async roomId => { order.push('readRoom'); return { roomId, appId: source.appId, name: roomName, private: true, memberIds: [frame.botSenderId] }; },
      registerPurpose: async input => { expect(input.noWorker).toBe(true); expect(input.noObserver).toBe(true); order.push('purpose'); },
      inviteHuman: async input => { expect(input.openId).toBe(source.decisionOpenId); order.push('invite'); },
      send: async input => {
        const id = `fake-${++sequence}`; order.push(input.chatId === source.chatId ? 'sendSource' : 'sendRoom');
        messages.set(id, { ...message(input.chatId, input.body, id), wire: askHumanTextWire(input.body, input.mentions) }); return { messageId: id };
      },
      readMessage: async id => { order.push('readMessage'); const m = messages.get(id); if (!m) throw Error('not found'); return m; },
      lookupSend: async () => ({ status: 'UNKNOWN' }),
      lookupWake: async () => ({ status: 'UNKNOWN' }),
      notifySourceEvent: async () => {},
      currentSource: async () => source,
      confirmDelivery: async input => { order.push('sourceAck'); expect(messages.get(input.message.messageId)).toEqual(input.message); return { sessionId: source.sessionId, messageId: input.message.messageId }; },
      wakeSource: async () => { order.push('wake'); return 'DISPATCHED'; },
    };
    return { ports, order, messages };
  }
  it('registers purpose before inviting; readback before source ACK; no human receipt required', async () => {
    const a = prepare('assistant_answer', 'a1'), t = transport();
    const executor = new AskHumanExecutor(ledger, t.ports), r = await executor.present(a, frame, 'a1', readers);
    // S3 revalidates the durable room binding before purpose/invitation too.
    expect(r.state).toBe('COMPLETED'); expect(t.order).toEqual(['create', 'readRoom', 'readRoom', 'purpose', 'invite', 'sendRoom', 'readMessage', 'sendSource', 'readMessage', 'sourceAck']);
    expect([...t.messages.values()].filter(m => m.chatId === source.chatId).map(m => m.body)).toEqual([expect.stringMatching(/^https:\/\/[^\s]+$/)]);
    expect((await executor.present(a, frame, 'a1', readers)).state).toBe('COMPLETED'); expect(t.order.filter(x => x === 'create')).toHaveLength(1);
  });
  it('missing output guard rejects before group creation or sending', async () => {
    const a = prepare('assistant_answer', 'a1'), t = transport(); t.ports.outputGuardReady = () => false;
    await expect(new AskHumanExecutor(ledger, t.ports).present(a, frame, 'a1', readers)).rejects.toThrow(/受控/); expect(t.order).toEqual([]);
  });
  it('rules unavailable rejects the actual LOCAL executor entry before any fake send/create', async () => {
    const a = prepare('assistant_answer', 'a1'), t = transport(); rmSync(join(rulesDir, 'current.json'));
    await expect(new AskHumanExecutor(ledger, t.ports).present(a, frame, 'a1', readers)).rejects.toThrow(); expect(t.order).toEqual([]);
  });
  it('refuses an existing/populated room before inviting or sending', async () => {
    const a = prepare('assistant_answer', 'a1'), t = transport(); t.ports.readRoom = async roomId => ({ roomId, appId: source.appId, name: '汇报·报名页面上线条件', private: true, memberIds: [frame.botSenderId, 'unexpected-member'] });
    await expect(new AskHumanExecutor(ledger, t.ports).present(a, frame, 'a1', readers)).rejects.toThrow(/只有/); expect(t.order).toEqual(['create']);
  });
  it('failed readback never source-ACKs or releases the lane', async () => {
    const a = prepare('assistant_answer', 'a1'), t = transport(); t.ports.readMessage = async () => { throw Error('read failed'); };
    await expect(new AskHumanExecutor(ledger, t.ports).present(a, frame, 'a1', readers)).rejects.toThrow(/read failed/);
    expect(t.order).not.toContain('sourceAck'); const r = ledger.get(source, 'assistant_answer', 'a1'); expect(r.state).toBe('ROOM_REGISTERED'); expect(r.failures).toHaveLength(1);
  });
  it('source must ACK the exact read message; wrong ID does not complete', async () => {
    const a = prepare('assistant_answer', 'a1'), t = transport(); t.ports.confirmDelivery = async () => ({ sessionId: source.sessionId, messageId: 'wrong' });
    await expect(new AskHumanExecutor(ledger, t.ports).present(a, frame, 'a1', readers)).rejects.toThrow(/真实回读/); expect(ledger.get(source, 'assistant_answer', 'a1').state).toBe('ANSWER_DELIVERED');
  });
  it('raw first reply is reread and relayed; wake dispatch is not source business completion', async () => {
    const a = prepare('human_decision', 'd1'), t = transport(), executor = new AskHumanExecutor(ledger, t.ports);
    await executor.present(a, frame, 'd1', readers); now += 10;
    const m = message('fake-room', 'A\n 保留原文', 'human-message', 'user'); t.messages.set(m.messageId, m);
    await executor.receive(source, 'human_decision', 'd1', m);
    const r = ledger.get(source, 'human_decision', 'd1'); expect(r.events[0].raw.body).toBe(m.body); expect(r.wake).toBe('DISPATCHED'); expect(r.state).not.toBe('COMPLETED');
    expect(t.order.filter(x => x === 'wake')).toHaveLength(1); await executor.receive(source, 'human_decision', 'd1', m); expect(t.order.filter(x => x === 'wake')).toHaveLength(1);
  });
  it('records a preparation failure as NOT_SENT and reuses the same relay UUID on explicit retry', async () => {
    const a = prepare('human_decision', 'd1'), t = transport(), executor = new AskHumanExecutor(ledger, t.ports);
    await executor.present(a, frame, 'd1', readers); now += 10;
    const m = message('fake-room', 'A', 'human-message', 'user'); t.messages.set(m.messageId, m);
    const send = t.ports.send;
    t.ports.send = async () => { throw new AskHumanReplyNotSent(); };
    await expect(executor.receive(source, 'human_decision', 'd1', m)).rejects.toMatchObject({ code: 'REPLY_NOT_SENT' });
    const failed = ledger.get(source, 'human_decision', 'd1').intents.at(-1)!;
    expect(failed.status).toBe('NOT_SENT'); expect(t.order).not.toContain('sendSource');
    t.ports.send = send;
    await executor.receive(source, 'human_decision', 'd1', m);
    const retried = ledger.get(source, 'human_decision', 'd1').intents.at(-1)!;
    expect(retried.status).toBe('CONFIRMED'); expect(retried.uuid).toBe(failed.uuid);
    expect(t.order.filter(x => x === 'sendSource')).toHaveLength(1);
  });
  it('recovers the persisted inbox ACK -> pending wake window without relaying twice', async () => {
    const a = prepare('human_decision', 'd1'), t = transport(), executor = new AskHumanExecutor(ledger, t.ports);
    await executor.present(a, frame, 'd1', readers); now += 10;
    const m = message('fake-room', 'A', 'human-message', 'user'); t.messages.set(m.messageId, m);
    let sourceReads = 0;
    t.ports.currentSource = async () => { if (++sourceReads > 1) throw Error('temporary source lookup failure'); return source; };
    await expect(executor.receive(source, 'human_decision', 'd1', m)).rejects.toThrow(/lookup/);
    expect(ledger.get(source, 'human_decision', 'd1').wake).toBe('PENDING');
    t.ports.currentSource = async () => source;
    await executor.receive(source, 'human_decision', 'd1', m);
    expect(t.order.filter(x => x === 'sendSource')).toHaveLength(1); expect(t.order.filter(x => x === 'wake')).toHaveLength(1);
  });
  it.each(['user', 'bot'] as const)('forwards exact reply and question with a real source mention, sender=%s', async senderType => {
    const a = prepare('human_decision', 'd1'), t = transport();
    Object.assign(t.ports, { replyBotOpenId: 'ou_requester' });
    const send = t.ports.send;
    t.ports.send = async input => {
      const result = await send(input);
      if (!input.replyAsUser) return result;
      expect(input.mentions).toEqual(['ou_requester']);
      expect(input.userOpenId).toBe(source.decisionOpenId);
      const sender = { type: senderType, id: senderType === 'user' ? source.decisionOpenId : 'cli_fallback' };
      const m = t.messages.get(result.messageId)!;
      const wire = askHumanTextWire(input.body, input.mentions);
      t.messages.set(result.messageId, { ...m, senderType, senderId: sender.id, wire,
        body: senderType === 'user' ? JSON.parse(wire.content).text : input.body });
      return { ...result, sender };
    };
    const executor = new AskHumanExecutor(ledger, t.ports);
    await executor.present(a, frame, 'd1', readers); now += 10;
    const original = message('fake-room', '  A\r\n 保留 $() 和原话！\n', 'human-message', 'user');
    t.messages.set(original.messageId, original);
    await executor.receive(source, 'human_decision', 'd1', original);
    await executor.receive(source, 'human_decision', 'd1', original);
    const r = ledger.get(source, 'human_decision', 'd1'), intent = r.intents.find(i => i.replyAsUser)!;
    expect(intent.body).toContain(r.body);
    expect(intent.body).toContain(r.presented!.messageId);
    expect(intent.body).toContain(original.messageId);
    expect(intent.body).toContain(`原话开始\n${original.body}\n原话结束`);
    expect(intent.readback?.senderType).toBe(senderType);
    expect(r.events[0].inboxAck).toBe(true);
    expect(t.order.filter(v => v === 'sendSource')).toHaveLength(1);
  });
});

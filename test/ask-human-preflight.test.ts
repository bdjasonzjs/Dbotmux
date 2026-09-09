import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASK_HUMAN_MAX_LIFETIME_MS, ASK_HUMAN_UNDERSTANDING_INSTRUCTIONS,
  askHumanDeadline, askHumanHash, parseAskHumanDraft, readAskHumanRules,
  renderAskHumanRequest, validateAskHumanUnderstanding,
  type AskHumanDraft, type AskHumanUnderstanding,
} from '../src/core/ask-human-preflight.js';
import { AskHumanAdmission, type AskHumanSourceBinding } from '../src/core/ask-human-admission.js';

const start = 1_700_000_000_000;
const source: AskHumanSourceBinding = {
  appId: 'app-a', sessionId: 'session-a', chatId: 'chat-a', taskId: 'task-a', revision: '1',
  tenantId: 'tenant-a', decisionUserId: 'human-a', decisionOpenId: 'scoped-a',
};
const readers = { requester: source.sessionId, checker: 'fresh-checker-a' };

function draft(): AskHumanDraft {
  return {
    requestId: 'request-a',
    shortTitle: '报名页面配色',
    background: '我们在制作活动报名页面。功能已经确认，还差页面外观。',
    whyNow: '开发开始前需要确定外观，两种外观功能和费用相同，取决于你的偏好。',
    decisions: [{
      question: '报名页面采用浅色还是深色外观？',
      options: [
        { key: 'A', label: '浅色', meaning: '白色背景与深灰文字', difference: '浅色背景，比 B 明亮', consequence: '报名页呈现浅色外观，功能不变', cost: '制作一天，与 B 相同', risk: '以后改色需额外一天' },
        { key: 'B', label: '深色', meaning: '深灰背景与浅色文字', difference: '深色背景，比 A 暗', consequence: '报名页呈现深色外观，功能不变', cost: '制作一天，与 A 相同', risk: '以后改色需额外一天' },
      ],
    }],
    criticalFacts: [{ id: 'risk-a', explanation: '切换现有页面的影响', text: '立即切换会让正在填写的报名表丢失，无法恢复。' }],
    references: [{ id: 'message-example', explanation: '确认报名功能的原始消息，供核查，正文已说明必要背景' }],
    expiresAt: start + 60_000,
  };
}

/** Fabricated checker fixture, NOT real model evaluation or send-entry E2E. */
function understanding(d: AskHumanDraft = draft()): AskHumanUnderstanding {
  return {
    problem: { summary: d.decisions[0].question, evidence: [d.decisions[0].question] },
    options: d.decisions[0].options.map(o => ({
      key: o.key,
      difference: { summary: o.difference, evidence: [o.difference] },
      consequence: { summary: o.consequence, evidence: [o.consequence, o.cost, o.risk] },
    })),
    decisionCount: 1, missingFacts: [], unexplainedTerms: [], unsupportedAssumptions: [], needsHumanPreference: true,
  };
}

let root: string;
let rulesDir: string;
let storeDir: string;
let now: number;
let admission: AskHumanAdmission;

function publish(text = '每次只问一件事。背景完整。理解检查不是人类授权。', version = '1'): void {
  const filename = `rules-${version}.md`;
  writeFileSync(join(rulesDir, filename), text);
  writeFileSync(join(rulesDir, 'current.json'), JSON.stringify({ version, file: filename, sha256: askHumanHash(text), published: true }));
}

function readAndConfirm(actor: string, role: 'requester' | 'checker' | 'polisher'): void {
  const { rules, receiptToken } = admission.readRules(source, 'request-a', actor, role);
  admission.confirmRead(source, 'request-a', actor, receiptToken, rules.sha256);
}

function prepare(): void {
  readAndConfirm(readers.requester, 'requester');
  admission.freezeFacts(source, 'request-a', source.sessionId, draft());
  readAndConfirm(readers.checker, 'checker');
}

function approve(d = draft()): void {
  const r = admission.check(source, 'request-a', d, understanding(d), readers);
  if (r === 'EXPIRED') throw new Error('fixture unexpectedly expired');
  admission.approveUnderstanding(source, 'request-a', source.sessionId, r.reportHash);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ask-human-preflight-'));
  rulesDir = join(root, 'rules');
  storeDir = join(root, 'receipts');
  mkdirSync(rulesDir);
  now = start;
  publish();
  admission = new AskHumanAdmission(storeDir, rulesDir, () => now);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('current prerequisite rules', () => {
  it('returns full verified content and version', () => {
    const r = readAskHumanRules(rulesDir);
    expect(askHumanHash(r.text)).toBe(r.sha256);
    expect(r.version).toBe('1');
  });
  it.each(['missing', 'wrong-hash', 'unpublished', 'invalid-json', 'empty-content', 'outside-root', 'invalid-utf8'])('fails closed for %s', kind => {
    const manifest = join(rulesDir, 'current.json');
    if (kind === 'missing') rmSync(manifest);
    if (kind === 'invalid-json') writeFileSync(manifest, '{');
    if (kind === 'wrong-hash') writeFileSync(join(rulesDir, 'rules-1.md'), 'changed');
    if (kind === 'unpublished') {
      const m = JSON.parse(readFileSync(manifest, 'utf8'));
      writeFileSync(manifest, JSON.stringify({ ...m, published: false }));
    }
    if (kind === 'empty-content') publish('');
    if (kind === 'outside-root') {
      writeFileSync(join(root, 'outside.md'), 'outside');
      writeFileSync(manifest, JSON.stringify({ version: '1', file: '../outside.md', sha256: askHumanHash('outside'), published: true }));
    }
    if (kind === 'invalid-utf8') {
      const bytes = Buffer.from([0xff]);
      writeFileSync(join(rulesDir, 'bad.md'), bytes);
      writeFileSync(manifest, JSON.stringify({ version: '1', file: 'bad.md', sha256: askHumanHash(bytes), published: true }));
    }
    expect(() => readAskHumanRules(rulesDir)).toThrow(/当前完整使用细则/);
  });
  it('requires issued receipt instead of accepting a version/hash from a caller', () => {
    admission.readRules(source, 'request-a', readers.requester, 'requester');
    expect(() => admission.confirmRead(source, 'request-a', readers.requester, 'made-up', readAskHumanRules(rulesDir).sha256)).toThrow(/凭据/);
  });
  it('requires independent checker and requester reads', () => {
    readAndConfirm(readers.requester, 'requester');
    expect(() => admission.check(source, 'request-a', draft(), understanding(), readers)).toThrow(/checker/);
    expect(() => admission.check(source, 'request-a', draft(), understanding(), { requester: source.sessionId } as typeof readers)).toThrow(/检查者/);
    expect(() => admission.check(source, 'request-a', draft(), understanding(), { requester: source.sessionId, checker: source.sessionId })).toThrow(/独立/);
  });
  it('cannot omit a polisher who has already participated', () => {
    prepare();
    admission.readRules(source, 'request-a', 'polisher-a', 'polisher');
    expect(() => admission.check(source, 'request-a', draft(), understanding(), readers)).toThrow(/润色者/);
    expect(() => admission.check(source, 'request-a', draft(), understanding(), { ...readers, polisher: 'polisher-a' })).toThrow(/polisher/);
  });
  it('invalidates old receipts after version change, even with identical content', () => {
    prepare();
    approve();
    publish(readAskHumanRules(rulesDir).text, '2');
    expect(() => admission.admit(source, 'request-a', source.appId, readers)).toThrow(/当前完整细则/);
    prepare();
    approve();
    expect(admission.admit(source, 'request-a', source.appId, readers).state).toBe('ADMISSIBLE');
  });
  it('new read requires confirmation and new source review', () => {
    prepare();
    approve();
    admission.readRules(source, 'request-a', readers.checker, 'checker');
    expect(() => admission.admit(source, 'request-a', source.appId, readers)).toThrow();
  });
});

describe('single decision, mandatory context and finite lifetime', () => {
  it('rejects two decisions while allowing options of one question', () => {
    const d = draft();
    expect(parseAskHumanDraft(d).decisions).toHaveLength(1);
    d.decisions.push(d.decisions[0]);
    expect(() => parseAskHumanDraft(d)).toThrow(/单个问题/);
  });
  it.each(['background', 'whyNow', 'expiresAt'])('rejects missing %s', field => {
    const d = draft() as unknown as Record<string, unknown>;
    delete d[field];
    expect(() => parseAskHumanDraft(d)).toThrow();
  });
  it.each(['meaning', 'difference', 'consequence', 'cost', 'risk'])('rejects missing option %s', field => {
    const d = draft();
    delete (d.decisions[0].options[0] as unknown as Record<string, unknown>)[field];
    expect(() => parseAskHumanDraft(d)).toThrow();
  });
  it('rejects unknown answer field and duplicate option/fact keys', () => {
    expect(() => parseAskHumanDraft({ ...draft(), answer: 'A' })).toThrow();
    const d = draft();
    d.decisions[0].options[1].key = 'A';
    expect(() => parseAskHumanDraft(d)).toThrow(/重复/);
    const e = draft();
    e.criticalFacts.push(e.criticalFacts[0]);
    expect(() => parseAskHumanDraft(e)).toThrow(/重复/);
  });
  it('renders major risks verbatim and explains references before IDs', () => {
    const d = draft();
    const body = renderAskHumanRequest(d);
    expect(body).toContain(d.criticalFacts[0].text);
    expect(body.indexOf(d.references[0].explanation)).toBeLessThan(body.indexOf(d.references[0].id));
    expect(body).toContain('直接回复或引用');
    expect(body).toContain('北京时间');
    expect(body).not.toContain('undefined');
  });
  it('rejects shortened body that drops irreversible cost, even if risk ID remains', () => {
    const d = draft();
    const body = renderAskHumanRequest(d).replace(d.criticalFacts[0].text, d.criticalFacts[0].id);
    expect(() => validateAskHumanUnderstanding(d, body, readAskHumanRules(rulesDir), understanding())).toThrow(/正文/);
  });
  it('rejects risk deletion from the list before rendering, not only body edits', () => {
    prepare();
    const d = draft();
    d.criticalFacts = [];
    expect(() => admission.check(source, 'request-a', d, understanding(d), readers)).toThrow(/重大风险/);
    expect(() => admission.freezeFacts(source, 'request-a', source.sessionId, d)).toThrow(/已经登记/);
    const e = draft();
    e.criticalFacts[0].text = '存在一些影响';
    expect(() => admission.check(source, 'request-a', e, understanding(e), readers)).toThrow(/重大风险/);
  });
  it('requires author facts registration before the quality result can pass', () => {
    readAndConfirm(readers.requester, 'requester');
    readAndConfirm(readers.checker, 'checker');
    expect(() => admission.check(source, 'request-a', draft(), understanding(), readers)).toThrow(/未预先登记/);
  });
  it('expires excessive deadline and never treats expiry as an answer', () => {
    prepare();
    const d = draft();
    d.expiresAt = start + ASK_HUMAN_MAX_LIFETIME_MS + 1;
    expect(admission.check(source, 'request-a', d, understanding(d), readers)).toBe('EXPIRED');
    expect(admission.admit(source, 'request-a', source.appId, readers)).toEqual({ state: 'EXPIRED' });
  });
  it('expires at exact deadline and accepts exactly the system maximum', () => {
    const d = draft();
    expect(askHumanDeadline(d, start, d.expiresAt)).toBe('EXPIRED');
    d.expiresAt = start + ASK_HUMAN_MAX_LIFETIME_MS;
    expect(askHumanDeadline(d, start, start)).toBe('VALID');
  });
  it('restart and re-read do not reset server submission time', () => {
    prepare();
    now += ASK_HUMAN_MAX_LIFETIME_MS - 100;
    admission = new AskHumanAdmission(storeDir, rulesDir, () => now);
    prepare();
    const d = draft();
    d.expiresAt = now + 200;
    expect(admission.check(source, 'request-a', d, understanding(d), readers)).toBe('EXPIRED');
  });
  it('rechecks deadline immediately before admission', () => {
    prepare();
    approve();
    now = draft().expiresAt;
    expect(admission.admit(source, 'request-a', source.appId, readers)).toEqual({ state: 'EXPIRED' });
  });
});

describe('understanding is not a decision or authorization', () => {
  it('passes complete preference question without choosing anything', () => {
    prepare();
    approve();
    const result = admission.admit(source, 'request-a', source.appId, readers);
    expect(result.state).toBe('ADMISSIBLE');
    expect(result).not.toHaveProperty('answer');
    expect(result).not.toHaveProperty('selected');
  });
  it.each(['answer', 'selected', 'humanAuthorized'])('rejects model-injected %s', field => {
    prepare();
    expect(() => admission.check(source, 'request-a', draft(), { ...understanding(), [field]: 'A' }, readers)).toThrow(/格式/);
  });
  it.each(['missingFacts', 'unexplainedTerms', 'unsupportedAssumptions'])('rejects %s', field => {
    prepare();
    expect(() => admission.check(source, 'request-a', draft(), { ...understanding(), [field]: ['缺失或未解释的对象'] }, readers)).toThrow(/拆分问题/);
  });
  it('rejects two semantic decisions hidden in one field', () => {
    prepare();
    const d = draft();
    d.decisions[0].question = '是否现在上线并删除旧数据？';
    expect(() => admission.check(source, 'request-a', d, { ...understanding(d), decisionCount: 2 }, readers)).toThrow();
  });
  it('rejects invented evidence or incomplete option coverage', () => {
    prepare();
    const u = understanding();
    u.problem.evidence = ['正文中没有这一句'];
    expect(() => admission.check(source, 'request-a', draft(), u, readers)).toThrow(/不存在/);
    const v = understanding();
    v.options[1].key = 'A';
    expect(() => admission.check(source, 'request-a', draft(), v, readers)).toThrow(/覆盖/);
  });
  it('requires source-session review, not a checker self-report', () => {
    prepare();
    const r = admission.check(source, 'request-a', draft(), understanding(), readers);
    if (r === 'EXPIRED') throw new Error('unexpected');
    expect(() => admission.admit(source, 'request-a', source.appId, readers)).toThrow(/核对/);
    expect(() => admission.approveUnderstanding(source, 'request-a', readers.checker, r.reportHash)).toThrow(/原业务/);
    expect(() => admission.approveUnderstanding(source, 'request-a', source.sessionId, 'made-up')).toThrow();
  });
  it('explicitly excludes preference from missing-facts instructions', () => {
    expect(ASK_HUMAN_UNDERSTANDING_INSTRUCTIONS).toContain('不得把偏好放进 missingFacts');
    expect(ASK_HUMAN_UNDERSTANDING_INSTRUCTIONS).toContain('不要输出 answer');
  });
});

describe('persisted source and reader authority', () => {
  it('rejects different runtime app or changed task binding', () => {
    prepare();
    approve();
    expect(() => admission.admit(source, 'request-a', 'app-b', readers)).toThrow(/源会话所在 app/);
    expect(() => admission.admit({ ...source, taskId: 'other-task' }, 'request-a', source.appId, readers)).toThrow(/所属任务/);
    expect(() => admission.admit({ ...source, decisionOpenId: 'other-human' }, 'request-a', source.appId, readers)).toThrow(/所属任务/);
  });
  it('retains verified approval across restart', () => {
    prepare();
    approve();
    admission = new AskHumanAdmission(storeDir, rulesDir, () => now);
    expect(admission.admit(source, 'request-a', source.appId, readers).state).toBe('ADMISSIBLE');
  });
  it('does not overwrite a corrupt authority record with an empty request', () => {
    prepare();
    const path = join(storeDir, readdirSync(storeDir).find(p => p.endsWith('.json'))!);
    writeFileSync(path, '{bad');
    expect(() => admission.readRules(source, 'request-a', readers.requester, 'requester')).toThrow(/禁止重置/);
    expect(readFileSync(path, 'utf8')).toBe('{bad');
  });
  it('does not accept a report replay for another request', () => {
    prepare();
    expect(() => admission.check(source, 'other-request', draft(), understanding(), readers)).toThrow(/编号/);
  });
});

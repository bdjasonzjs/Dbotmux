/** Durable pre-send receipts, with explicit source binding. No IM, timers,
 * workers, routing registration or environment-dependent production paths.
 * Integrators must use the trusted daemon session to construct SourceBinding.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import {
  askHumanDeadline, askHumanHash, AskHumanPreflightError, parseAskHumanDraft,
  withAskHumanRules, renderAskHumanRequest, validateAskHumanUnderstanding,
  type AskHumanDraft, type AskHumanQualityReport, type AskHumanRules,
} from './ask-human-preflight.js';

import {
  parseAskHumanAnswerDraft, renderAskHumanAnswer, validateAskHumanAnswerUnderstanding,
  type AskHumanAnswerDraft, type AskHumanAnswerQualityReport,
} from './ask-human-answer-preflight.js';

export type AskHumanDirection = 'human_decision' | 'assistant_answer';
type ContentDraft = AskHumanDraft | AskHumanAnswerDraft;
type ContentReport = AskHumanQualityReport | AskHumanAnswerQualityReport;
export interface AskHumanAdmitted {
  state: 'ADMISSIBLE'; direction: AskHumanDirection; draft: ContentDraft; body: string;
  reportHash: string; rulesVersion: string; rulesHash: string; createdAt: number;
}
export type AskHumanReaders = { requester: string; checker: string; polisher?: string };
const text = z.string().min(1);
const sourceSchema = z.object({
  appId: text, sessionId: text, chatId: text, taskId: text, revision: text,
  tenantId: text, decisionUserId: text, decisionOpenId: text,
}).strict();
export type AskHumanSourceBinding = z.infer<typeof sourceSchema>;
export type AskHumanReaderRole = 'requester' | 'checker' | 'polisher';
interface ReadReceipt {
  token: string; actor: string; role: AskHumanReaderRole;
  rulesVersion: string; rulesHash: string; issuedAt: number; confirmed: boolean;
}
interface AdmissionRecord {
  v: 1; requestId: string; source: AskHumanSourceBinding; createdAt: number;
  direction: AskHumanDirection; reads: ReadReceipt[]; report?: ContentReport;
  draft?: ContentDraft; approvedReportHash?: string;
  frozenFacts?: AskHumanDraft['criticalFacts'];
  status: 'PREPARED' | 'CHECKED' | 'APPROVED' | 'EXPIRED';
}

/** Runtime schema is deliberately strict for authority-bearing persisted data.
 * A corrupt journal is not an empty/approved request and must never overwrite.
 */
const recordSchema = z.object({
  v: z.literal(1), requestId: text, source: sourceSchema, createdAt: z.number().int().nonnegative(),
  direction: z.enum(['human_decision', 'assistant_answer']).default('human_decision'),
  reads: z.array(z.object({
    token: text, actor: text, role: z.enum(['requester', 'checker', 'polisher']),
    rulesVersion: text, rulesHash: text, issuedAt: z.number().int(), confirmed: z.boolean(),
  }).strict()),
  report: z.unknown().optional(), draft: z.unknown().optional(), approvedReportHash: text.optional(), frozenFacts: z.unknown().optional(),
  status: z.enum(['PREPARED', 'CHECKED', 'APPROVED', 'EXPIRED']),
}).strict();

export class AskHumanAdmission {
  constructor(
    private readonly storeDir: string,
    private readonly rulesDir: string,
    private readonly now: () => number = Date.now,
    readonly direction: AskHumanDirection = 'human_decision',
  ) {
    mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  }

  private parse(input: unknown): ContentDraft {
    return this.direction === 'assistant_answer' ? parseAskHumanAnswerDraft(input) : parseAskHumanDraft(input);
  }

  private render(draft: ContentDraft): string {
    return this.direction === 'assistant_answer' ? renderAskHumanAnswer(draft as AskHumanAnswerDraft) : renderAskHumanRequest(draft as AskHumanDraft);
  }

  private validate(draft: ContentDraft, rules: AskHumanRules, output: unknown): ContentReport {
    const body = this.render(draft);
    return this.direction === 'assistant_answer'
      ? validateAskHumanAnswerUnderstanding(draft as AskHumanAnswerDraft, body, rules, output)
      : validateAskHumanUnderstanding(draft as AskHumanDraft, body, rules, output);
  }

  private path(source: AskHumanSourceBinding, requestId: string): string {
    sourceSchema.parse(source);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(requestId)) throw new AskHumanPreflightError('INVALID_REQUEST', '请求编号无效');
    return join(this.storeDir, `${askHumanHash(JSON.stringify([source.appId, source.sessionId, requestId]))}.json`);
  }

  private transaction<T>(source: AskHumanSourceBinding, requestId: string, f: (r: AdmissionRecord | undefined, rules: AskHumanRules) => { record: AdmissionRecord; result: T }, lockedRules?: AskHumanRules): T {
    const path = this.path(source, requestId);
    const run = (rules: AskHumanRules) => withFileLockSync(path, () => {
      let r: AdmissionRecord | undefined;
      try {
        const raw = recordSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
        r = raw as AdmissionRecord;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AskHumanPreflightError('STORE_UNREADABLE', '请求记录无法读取，禁止重置或发送');
      }
      if (r && (r.direction !== this.direction || r.requestId !== requestId || JSON.stringify(r.source) !== JSON.stringify(sourceSchema.parse(source)))) {
        throw new AskHumanPreflightError('SOURCE_MISMATCH', '请求所属任务、会话或身份发生变化');
      }
      const { record, result } = f(r, rules);
      atomicWriteFileSync(path, JSON.stringify(record), { durable: true, mode: 0o600, followTargetSymlink: false });
      return result;
    });
    // One lock order for every entry point: rules -> admission record -> lane.
    // lockedRules is private and only passed from an already-held rules lock.
    return lockedRules ? run(lockedRules) : withAskHumanRules(this.rulesDir, run);
  }

  /** The adapter must authenticate actor/role; callers cannot choose a sibling
   * identity. Complete text is returned before a separate acknowledgement.
   * This proves delivery + acknowledgement, never subjective comprehension.
   */
  readRules(source: AskHumanSourceBinding, requestId: string, actor: string, role: AskHumanReaderRole): { rules: AskHumanRules; receiptToken: string } {
    if (!actor.trim() || !['requester', 'checker', 'polisher'].includes(role)) throw new AskHumanPreflightError('INVALID_ACTOR', '读取者无效');
    return this.transaction(source, requestId, (old, rules) => {
      const record: AdmissionRecord = old ?? { v: 1, direction: this.direction, requestId, source: sourceSchema.parse(source), createdAt: this.now(), reads: [], status: 'PREPARED' };
      const receiptToken = randomUUID();
      // A new read invalidates any old send approval, including version updates.
      record.reads = record.reads.filter(r => !(r.actor === actor && r.role === role));
      record.reads.push({ token: receiptToken, actor, role, rulesVersion: rules.version, rulesHash: rules.sha256, issuedAt: this.now(), confirmed: false });
      delete record.approvedReportHash;
      record.status = record.status === 'EXPIRED' ? 'EXPIRED' : 'PREPARED';
      return { record, result: { rules, receiptToken } };
    });
  }

  confirmRead(source: AskHumanSourceBinding, requestId: string, actor: string, token: string, hash: string): void {
    this.transaction(source, requestId, (old, rules) => {
      const record = this.requireRecord(old);
      const receipt = record.reads.find(r => r.token === token && r.actor === actor);
      if (!receipt || receipt.rulesHash !== hash || hash !== rules.sha256 || receipt.rulesVersion !== rules.version) {
        throw new AskHumanPreflightError('READ_RECEIPT_INVALID', '未完整取得当前细则或阅读凭据不匹配');
      }
      receipt.confirmed = true;
      return { record, result: undefined };
    });
  }

  private requireRecord(r: AdmissionRecord | undefined): AdmissionRecord {
    if (!r) throw new AskHumanPreflightError('RULES_NOT_READ', '请先取得当前使用细则');
    return r;
  }

  /** Called by the authenticated business author BEFORE any optional polishing.
   * Critical facts cannot subsequently be deleted by supplying a shorter list.
   * Revised factual baselines require a new request, not silent mutation.
   */
  freezeFacts(source: AskHumanSourceBinding, requestId: string, actor: string, input: unknown): void {
    const draft = this.parse(input);
    if (draft.requestId !== requestId || actor !== source.sessionId) throw new AskHumanPreflightError('SOURCE_MISMATCH', '只有原业务会话能登记本请求的关键事实');
    this.transaction(source, requestId, (old, rules) => {
      const record = this.requireRecord(old);
      if (!record.reads.some(r => r.role === 'requester' && r.actor === actor && r.confirmed && r.rulesHash === rules.sha256 && r.rulesVersion === rules.version)) {
        throw new AskHumanPreflightError('RULES_NOT_READ', '登记关键事实前须读取当前细则');
      }
      if (record.frozenFacts && JSON.stringify(record.frozenFacts) !== JSON.stringify(draft.criticalFacts)) {
        throw new AskHumanPreflightError('FACTS_CHANGED', '关键事实已经登记；事实修订需新请求');
      }
      record.frozenFacts = draft.criticalFacts;
      return { record, result: undefined };
    });
  }

  private requireFrozenFacts(record: AdmissionRecord, draft: ContentDraft): void {
    if (!record.frozenFacts || JSON.stringify(record.frozenFacts) !== JSON.stringify(draft.criticalFacts)) {
      throw new AskHumanPreflightError('FACTS_CHANGED', '关键事实未预先登记，或正文已删除/修改重大风险');
    }
  }

  private requireReaders(record: AdmissionRecord, rules: AskHumanRules, readers: { requester: string; checker: string; polisher?: string }): void {
    if (!readers.requester || !readers.checker || readers.requester === readers.checker) {
      throw new AskHumanPreflightError('INVALID_ACTOR', '必须包含原业务会话和独立理解检查者');
    }
    if (readers.requester !== record.source.sessionId) throw new AskHumanPreflightError('SOURCE_MISMATCH', '发起者不是原业务会话');
    if (record.reads.some(r => r.role === 'polisher') && !readers.polisher) {
      throw new AskHumanPreflightError('RULES_NOT_READ', '已参与的润色者不能从阅读检查中省略');
    }
    for (const [role, actor] of Object.entries(readers)) {
      if (!actor || !record.reads.some(r => r.actor === actor && r.role === role && r.confirmed && r.rulesHash === rules.sha256 && r.rulesVersion === rules.version)) {
        throw new AskHumanPreflightError('RULES_NOT_READ', `${role} 未确认读取当前完整细则`);
      }
    }
  }

  check(source: AskHumanSourceBinding, requestId: string, input: unknown, output: unknown, readers: { requester: string; checker: string; polisher?: string }): ContentReport | 'EXPIRED' {
    const draft = this.parse(input);
    if (draft.requestId !== requestId) throw new AskHumanPreflightError('SOURCE_MISMATCH', '请求编号不匹配');
    return this.transaction<ContentReport | 'EXPIRED'>(source, requestId, (old, rules) => {
      const record = this.requireRecord(old);
      this.requireReaders(record, rules, readers);
      this.requireFrozenFacts(record, draft);
      if (record.status === 'EXPIRED' || askHumanDeadline(draft, record.createdAt, this.now()) === 'EXPIRED') {
        record.status = 'EXPIRED';
        delete record.approvedReportHash;
        return { record, result: 'EXPIRED' };
      }
      const report = this.validate(draft, rules, output);
      record.draft = draft;
      record.report = report;
      delete record.approvedReportHash;
      record.status = 'CHECKED';
      return { record, result: report };
    });
  }

  /** Explicit source-session comparison of all three paraphrases. A checker
   * saying "pass" or choosing an option cannot call this on the user's behalf.
   */
  approveUnderstanding(source: AskHumanSourceBinding, requestId: string, actor: string, reportHash: string): void {
    this.transaction(source, requestId, (old, rules) => {
      const record = this.requireRecord(old);
      if (actor !== source.sessionId || record.status !== 'CHECKED' || record.report?.reportHash !== reportHash) {
        throw new AskHumanPreflightError('QUALITY_NOT_REVIEWED', '原业务会话尚未核对这份三项理解报告');
      }
      if (record.report.rulesHash !== rules.sha256 || record.report.rulesVersion !== rules.version) throw new AskHumanPreflightError('RULES_CHANGED', '细则已更新，请重新读取检查');
      record.approvedReportHash = reportHash;
      record.status = 'APPROVED';
      return { record, result: undefined };
    });
  }

  /** No network call in fn. Publisher MUST use this same current.json lock.
   * This is a local integration seam, not a production publishing endpoint.
   */
  withAdmittedIntent<T>(source: AskHumanSourceBinding, requestId: string, runtimeAppId: string, readers: AskHumanReaders, fn: (value: AskHumanAdmitted) => T): T | { state: 'EXPIRED' } {
    return withAskHumanRules(this.rulesDir, rules => {
      const value = this.admitLocked(source, requestId, runtimeAppId, readers, rules);
      if (value.state === 'EXPIRED') return value;
      return fn(value);
    });
  }

  /** Recheck without persisting an intent. Callers that commit QUEUED/send
   * intents must use withAdmittedIntent so the publication lock is retained
   * through that commit. Neither operation performs network IO under the lock.
   */
  admit(source: AskHumanSourceBinding, requestId: string, runtimeAppId: string, readers: { requester: string; checker: string; polisher?: string }): { state: 'EXPIRED' } | AskHumanAdmitted {
    return withAskHumanRules(this.rulesDir, rules => this.admitLocked(source, requestId, runtimeAppId, readers, rules));
  }

  private admitLocked(source: AskHumanSourceBinding, requestId: string, runtimeAppId: string, readers: AskHumanReaders, lockedRules: AskHumanRules): { state: 'EXPIRED' } | AskHumanAdmitted {
    return this.transaction<{ state: 'EXPIRED' } | AskHumanAdmitted>(source, requestId, old => {
      const record = this.requireRecord(old);
      if (runtimeAppId !== source.appId) throw new AskHumanPreflightError('RUNTIME_APP_MISMATCH', '首版必须使用源会话所在 app');
      const rules = lockedRules;
      this.requireReaders(record, rules, readers);
      if (record.status === 'EXPIRED') return { record, result: { state: 'EXPIRED' as const } };
      if (record.status !== 'APPROVED' || !record.draft || !record.report || record.approvedReportHash !== record.report.reportHash) {
        throw new AskHumanPreflightError('QUALITY_NOT_REVIEWED', '正文尚未完成理解检查和源会话核对');
      }
      const draft = this.parse(record.draft);
      this.requireFrozenFacts(record, draft);
      if (askHumanDeadline(draft, record.createdAt, this.now()) === 'EXPIRED') {
        record.status = 'EXPIRED';
        delete record.approvedReportHash;
        return { record, result: { state: 'EXPIRED' as const } };
      }
      const body = this.render(draft);
      const checked = this.validate(draft, rules, record.report.understanding);
      if (checked.reportHash !== record.approvedReportHash) throw new AskHumanPreflightError('QUALITY_STALE', '正文、细则或报告发生变化');
      return { record, result: { state: 'ADMISSIBLE' as const, direction: this.direction, draft, body, reportHash: checked.reportHash, rulesVersion: rules.version, rulesHash: rules.sha256, createdAt: record.createdAt } };
    }, lockedRules);
  }
}

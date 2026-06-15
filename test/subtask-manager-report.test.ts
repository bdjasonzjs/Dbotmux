/**
 * 双层汇报 v6 单测：ceo-inbox store / manager-report(normal·urgent 机制门控) / request-report /
 * digest→inbox 重定向 / report_urgent·request_report 渲染。
 * Run: pnpm vitest run test/subtask-manager-report.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
const mockCreateGroup = vi.fn();
const mockSessions = new Map<string, any>();

vi.mock('../src/config.js', () => ({ config: { get session() { return { dataDir: tempDir }; } } }));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), isDebug: () => false },
}));
vi.mock('../src/core/main-bot-playbook.js', () => {
  class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); this.name = 'HttpError'; } }
  const idents: Record<string, { larkAppId: string; openId: string }> = {
    claude: { larkAppId: 'app_claude', openId: 'ou_claude' },
    codex: { larkAppId: 'app_codex', openId: 'ou_codex' },
    tilly: { larkAppId: 'app_coco', openId: 'ou_coco' },
  };
  return { HttpError, authzCheck: vi.fn(), resolveBotIdent: (k: string) => idents[k] };
});
vi.mock('../src/services/group-creator.js', () => ({ createGroupWithBots: (...a: any[]) => mockCreateGroup(...a) }));
vi.mock('../src/services/spawn-idempotency-store.js', () => ({
  getOrCompute: async (_k: string, c: () => Promise<any>) => ({ entry: await c(), cacheHit: false }),
}));
vi.mock('../src/services/session-store.js', () => ({ getSession: (id: string) => mockSessions.get(id) }));
vi.mock('../src/services/main-topic-config.js', () => ({ getMainTopicChatId: () => 'oc_main' }));
vi.mock('../src/services/base-relay.js', () => ({ sendAsOwner: vi.fn(), DEFAULT_GROUP_NOT_FOUND_RETRY_TIMEOUT_MS: 0 }));

import {
  createSubTask, getSubTask, transitionStatus, listCommands, getCommand, recordManualDoneObservation,
  __resetForTesting, type SubTaskBot,
} from '../src/services/subtask-store.js';
import {
  managerReport, requestReport, managerReportCore, reportProgress,
} from '../src/services/subtask-orchestrator.js';
import * as inbox from '../src/services/ceo-inbox-store.js';
import { runDigestTick } from '../src/services/subtask-digest.js';
import { childToParentSummon, parentToChildSummon } from '../src/services/outbox-dispatcher-executors.js';
import { readLetter } from '../src/services/mailbox.js';

const BOTS: SubTaskBot[] = [
  { openId: 'ou_claude', name: '克劳德', role: 'main' },
  { openId: 'ou_coco', name: '缇蕾', role: 'observer' },
];
// 父群=oc_main 的 orchestrator（主话题→克劳德）；manager 子群=oc_mgr。
async function mkManager(chatId = 'oc_mgr', key = 'km'): Promise<string> {
  const t = await createSubTask({
    chatId, parentChatId: 'oc_main', parentMessageId: 'om', goal: 'manager 领域X',
    acceptance: null, bots: BOTS, requester: 'ou_jason', createdBy: 'claude', idempotencyKey: key,
    reportingMode: 'manager',
  });
  await transitionStatus(t.taskId, 'observing');
  return t.taskId;
}
function subSession(id: string, chatId: string, larkAppId = 'app_claude') {
  mockSessions.set(id, { sessionId: id, chatId, rootMessageId: 'om', larkAppId, ownerOpenId: 'ou_jason', status: 'active', createdAt: 't' });
  return id;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mr-'));
  __resetForTesting();
  inbox.__resetForTesting();
  mockSessions.clear();
});

describe('ceo-inbox-store', () => {
  it('enqueue 幂等 + per-reader 已读 + listInbox 过滤', async () => {
    const base = { recipientChatId: 'oc_main', recipientBotOpenId: 'ou_claude', fromTaskId: 't1', fromChatId: 'oc_mgr', fromLabel: 'X', reportKind: 'scheduled' as const, summary: 's1', idempotencyKey: 'k1' };
    const r1 = await inbox.enqueueEntry(base);
    const r2 = await inbox.enqueueEntry(base);   // 同 key
    expect(r1.inserted).toBe(true); expect(r2.inserted).toBe(false);
    expect(inbox.listInbox('oc_main', 'ou_claude', { unreadOnly: true })).toHaveLength(1);
    await inbox.markRead('oc_main', 'ou_claude', [r1.entry.id]);
    expect(inbox.listInbox('oc_main', 'ou_claude', { unreadOnly: true })).toHaveLength(0);
  });

  it('B1: list/markRead 按 recipientChatId+recipientBotOpenId 双收窄', async () => {
    // entry 投给 oc_main 的 claude
    const r = await inbox.enqueueEntry({ recipientChatId: 'oc_main', recipientBotOpenId: 'ou_claude', fromTaskId: 't', fromChatId: 'oc_m', fromLabel: 'X', reportKind: 'scheduled', summary: 's', idempotencyKey: 'k' });
    // 同 chat 不同 reader → 看不到
    expect(inbox.listInbox('oc_main', 'ou_codex', {})).toHaveLength(0);
    // 同 reader 不同 chat → 看不到
    expect(inbox.listInbox('oc_other', 'ou_claude', {})).toHaveLength(0);
    // 正主能看到
    expect(inbox.listInbox('oc_main', 'ou_claude', {})).toHaveLength(1);
    // 错 reader 凭 id markRead → 不生效（双匹配失败）
    expect(await inbox.markRead('oc_main', 'ou_codex', [r.entry.id])).toBe(0);
    expect(await inbox.markRead('oc_other', 'ou_claude', [r.entry.id])).toBe(0);
    // 正主 markRead → 生效
    expect(await inbox.markRead('oc_main', 'ou_claude', [r.entry.id])).toBe(1);
  });
});

describe('manager-report 机制门控', () => {
  it('normal → 落 inbox、不产 report_urgent（不唤醒）', async () => {
    const tid = await mkManager();
    const sid = subSession('s', 'oc_mgr');
    const r = await managerReport({ sessionId: sid, taskId: tid, summary: '进展A', body: '详情正文 https://x' });
    expect(r.entryId).toBeTruthy();
    expect(listCommands(tid).filter(c => c.commandType === 'report_urgent')).toHaveLength(0);
    const entries = inbox.listInbox('oc_main', 'ou_claude', {});
    expect(entries).toHaveLength(1);
    expect(entries[0].urgency).toBe('normal');
    // 正文落 mailbox letter
    expect(entries[0].letterId).toBeTruthy();
    expect(readLetter(entries[0].letterId!)?.payload).toContain('https://x');
  });
  it('urgent 无 reason → 400（机制门控）', async () => {
    const tid = await mkManager();
    const sid = subSession('s', 'oc_mgr');
    await expect(managerReport({ sessionId: sid, taskId: tid, summary: '急', urgency: 'urgent' }))
      .rejects.toMatchObject({ status: 400 });
  });
  it('urgent 带 reason → 落 inbox + 产 report_urgent（实时）', async () => {
    const tid = await mkManager();
    const sid = subSession('s', 'oc_mgr');
    const r = await managerReport({ sessionId: sid, taskId: tid, summary: '线上事故', urgency: 'urgent', reason: '缺权限 CEO 须立刻拍板' });
    expect(r.urgentCmdId).toBeTruthy();
    const uc = listCommands(tid).filter(c => c.commandType === 'report_urgent');
    expect(uc).toHaveLength(1);
    expect(uc[0].direction).toBe('child_to_parent');
    expect(uc[0].targetChatId).toBe('oc_main');
    expect(uc[0].payload.inboxEntryId).toBe(r.entryId);
  });
  it('M1: 非法 urgency / reportKind → 400（运行时枚举校验）', async () => {
    const tid = await mkManager();
    const sid = subSession('s', 'oc_mgr');
    await expect(managerReport({ sessionId: sid, taskId: tid, summary: 'x', urgency: 'urgentx' as any })).rejects.toMatchObject({ status: 400 });
    await expect(managerReport({ sessionId: sid, taskId: tid, summary: 'x', reportKind: 'bogus' as any })).rejects.toMatchObject({ status: 400 });
  });
  it('B2: requestId 写回 entry.requestCommandId（履约闭环）', async () => {
    const tid = await mkManager();
    const sid = subSession('s', 'oc_mgr');
    const r = await managerReport({ sessionId: sid, taskId: tid, summary: '应 CEO 之请', reportKind: 'requested', requestId: 'req-xyz' });
    const e = inbox.getEntry(r.entryId)!;
    expect(e.requestCommandId).toBe('req-xyz');
    expect(e.reportKind).toBe('requested');
  });
  it('executor 任务调 manager-report → 400', async () => {
    const t = await createSubTask({ chatId: 'oc_ex', parentChatId: 'oc_main', parentMessageId: 'om', goal: 'exec', acceptance: null, bots: BOTS, requester: 'ou_jason', createdBy: 'claude', idempotencyKey: 'ke' });
    await transitionStatus(t.taskId, 'observing');
    const sid = subSession('s', 'oc_ex');
    await expect(managerReport({ sessionId: sid, taskId: t.taskId, summary: 'x' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('manager need_help（经理群泄漏修复：折叠进 digest，不再实时 report_help）', () => {
  it('manager need_help 缺 summary → 400；带 summary → 折叠 digest、不入队 report_help', async () => {
    const tid = await mkManager('oc_mgrH', 'kh');
    const sid = subSession('s', 'oc_mgrH');
    await expect(reportProgress({ sessionId: sid, taskId: tid, type: 'need_help', summary: '  ' })).rejects.toMatchObject({ status: 400 });
    const r = await reportProgress({ sessionId: sid, taskId: tid, type: 'need_help', summary: '真卡住了' });
    // 契约纠正：need_help ≠ urgent —— manager 折叠进 digest（suppressed/enteredDigest），不实时 report_help。
    expect(r.suppressed).toBe(true);
    expect(r.enteredDigest).toBe(true);
    expect(listCommands(tid).filter(c => c.commandType === 'report_help')).toHaveLength(0);
  });
});

describe('request-report', () => {
  it('父群 orchestrator → 产 request_report(parent→child, requestId)', async () => {
    const tid = await mkManager();
    const sid = subSession('sm', 'oc_main');   // 父群=主话题，克劳德
    const r = await requestReport({ sessionId: sid, taskId: tid, note: '看看领域X' });
    expect(r.requestId).toBeTruthy();
    const rc = getCommand(r.cmdId)!;
    expect(rc.commandType).toBe('request_report');
    expect(rc.direction).toBe('parent_to_child');
    expect(rc.targetChatId).toBe('oc_mgr');
    expect(rc.payload.requestId).toBe(r.requestId);
  });
  it('从子群（非父群 orchestrator）调 → 403', async () => {
    const tid = await mkManager();
    const sid = subSession('s', 'oc_mgr');   // 子群自己，不是父群
    await expect(requestReport({ sessionId: sid, taskId: tid })).rejects.toMatchObject({ status: 403 });
  });
});

describe('digest tick → inbox（v6 重定向，不再 report_digest）', () => {
  it('到点写 scheduled inbox 邮件、不产 report_digest chat 命令', async () => {
    const tid = await mkManager('oc_mgrD', 'kd');
    await recordManualDoneObservation({ taskId: tid, summary: '阶段完成X', manualDedupeKey: 'k1' });
    const stats = await runDigestTick(new Date());
    expect(stats.pushed).toBe(1);
    expect(listCommands(tid).filter(c => c.commandType === 'report_digest')).toHaveLength(0);   // 不再发 chat 命令
    const entries = inbox.listInbox('oc_main', 'ou_claude', {});
    expect(entries).toHaveLength(1);
    expect(entries[0].reportKind).toBe('scheduled');
    expect(entries[0].summary).toContain('完成');
  });
});

describe('渲染', () => {
  it('report_urgent 带急急如律令 + 收件箱指引', async () => {
    const tid = await mkManager();
    const cmd = { commandType: 'report_urgent', payload: { summary: '事故', inboxEntryId: 'inbox_x' } } as any;
    const text = childToParentSummon(cmd, getSubTask(tid)!);
    expect(text).toContain('急急如律令');
    expect(text).toContain('收件箱');
    expect(text).toContain('inbox_x');
    expect(text).toContain('subtask-inbox-list');          // 真命令带连字符
    expect(text).not.toContain('subtask-inbox list');      // 不能是空格版（会执行失败）
  });
  it('request_report 唤经理 main + manager-report 指引', async () => {
    const tid = await mkManager();
    const cmd = { commandType: 'request_report', payload: { requestId: 'req1', content: '看X', targetRole: 'main' } } as any;
    const text = parentToChildSummon(cmd, getSubTask(tid)!);
    expect(text).toContain('急急如律令');
    expect(text).toContain('subtask-manager-report');
    expect(text).toContain('req1');
  });
});

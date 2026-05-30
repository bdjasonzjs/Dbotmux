/**
 * Unit tests for subtask-observer-executors fetchSince 连续性合约 (蔻黛克斯 review)。
 * mock listMessagesAsc / getMessageDetail，覆盖分页/cursor 边界。
 * Run: pnpm vitest run test/subtask-observer-executors.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockListAsc = vi.fn();
const mockGetDetail = vi.fn();
vi.mock('../src/im/lark/client.js', () => ({
  listMessagesAsc: (...a: any[]) => mockListAsc(...a),
  getMessageDetail: (...a: any[]) => mockGetDetail(...a),
}));
vi.mock('../src/core/main-bot-playbook.js', () => ({
  resolveBotIdent: () => ({ larkAppId: 'app', openId: 'ou_coco', name: '缇蕾' }),
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), isDebug: () => false },
}));

import { makeObserverExecutors, CursorNotFoundError } from '../src/services/subtask-observer-executors.js';

/** 造 N 条消息 m1..mN (都同一 create_time, 模拟同秒海量)。 */
function msgs(n: number, ct = '1700000000000') {
  return Array.from({ length: n }, (_, i) => ({
    message_id: `m${i + 1}`, create_time: ct,
    sender: { id: 'ou_x' }, body: { content: JSON.stringify({ text: `c${i + 1}` }) },
  }));
}
/** 把 all 按 pageSize 分页，mockListAsc 按 pageToken(=起始下标) 翻页。 */
function paginate(all: any[], pageSize: number) {
  mockListAsc.mockImplementation(async (_app: string, _chat: string, opts: any) => {
    const start = opts.pageToken ? Number(opts.pageToken) : 0;
    const items = all.slice(start, start + (opts.pageSize ?? pageSize));
    const nextStart = start + (opts.pageSize ?? pageSize);
    return { items, nextPageToken: nextStart < all.length ? String(nextStart) : null };
  });
}

beforeEach(() => {
  mockListAsc.mockReset();
  mockGetDetail.mockReset();
  mockGetDetail.mockResolvedValue({ items: [{ create_time: '1700000000000' }] });
});

describe('fetchSince 连续性 (分页)', () => {
  it('同秒 80 条, afterMessageId 在第 60 条, pageSize 40 → 分页找到后收 m61..m80', async () => {
    paginate(msgs(80), 40);
    const exec = makeObserverExecutors();
    const res = await exec.fetchSince('oc_sub', 'm60', 40);
    expect(res.messages.map(m => m.id)).toEqual(Array.from({ length: 20 }, (_, i) => `m${61 + i}`));
    expect(res.complete).toBe(true); // 收了 20 条 < limit 40 → 读到尾
  });

  it('afterMessageId 在第一页末尾(m40)且后面还有 → 翻下一页拿 m41.., 不空返', async () => {
    paginate(msgs(80), 40);
    const exec = makeObserverExecutors();
    const res = await exec.fetchSince('oc_sub', 'm40', 40);
    expect(res.messages.length).toBe(40);            // m41..m80
    expect(res.messages[0].id).toBe('m41');
    expect(res.messages.length).toBeGreaterThan(0);   // 关键：没因为页尾切空就 skip
  });

  it('收满 limit 且还有更多 → complete=false, 只返本批', async () => {
    paginate(msgs(100), 40); // afterMessageId 之后还有 > limit
    const exec = makeObserverExecutors();
    const res = await exec.fetchSince('oc_sub', 'm10', 40);
    expect(res.messages.length).toBe(40);   // m11..m50
    expect(res.messages[0].id).toBe('m11');
    expect(res.complete).toBe(false);        // 还有 m51..m100 没读
  });

  it('MAX_PAGES 打满仍没读到群尾 → complete=false (不把没读完伪装成完成)', async () => {
    // 每页 1 条、永远有 nextPageToken (同秒海量、分页极深)。cursor=m1 第一页就找到，
    // 之后每页收 1 条，翻满 MAX_PAGES=30 页仍 nextPageToken 存在 → 没到群尾。
    let idx = 0;
    mockListAsc.mockImplementation(async () => {
      idx += 1;
      return {
        items: [{ message_id: `m${idx}`, create_time: '1700000000000', sender: { id: 'ou_x' }, body: { content: JSON.stringify({ text: `c${idx}` }) } }],
        nextPageToken: 'more', // 永远还有更多
      };
    });
    const exec = makeObserverExecutors();
    const res = await exec.fetchSince('oc_sub', 'm1', 40);
    expect(res.complete).toBe(false);              // MAX_PAGES 停 ≠ 读到尾
    expect(res.messages.length).toBeLessThan(40);  // 没收满 limit，下轮从本批末尾接着读
  });

  it('翻到尾仍找不到 afterMessageId → 抛 CursorNotFoundError (不空返卡死)', async () => {
    paginate(msgs(50), 40);
    const exec = makeObserverExecutors();
    await expect(exec.fetchSince('oc_sub', 'm999', 40)).rejects.toThrow(CursorNotFoundError);
  });

  it('cursor 消息 create_time 缺/NaN → 抛 (不退化成从头读)', async () => {
    mockGetDetail.mockResolvedValue({ items: [{ create_time: undefined }] });
    const exec = makeObserverExecutors();
    await expect(exec.fetchSince('oc_sub', 'm1', 40)).rejects.toThrow(/create_time/);
  });

  it('无 cursor (afterMessageId=null) → 从头收 limit 内', async () => {
    paginate(msgs(10), 40);
    const exec = makeObserverExecutors();
    const res = await exec.fetchSince('oc_sub', null, 40);
    expect(res.messages.map(m => m.id)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i + 1}`));
    expect(res.complete).toBe(true);
    expect(mockGetDetail).not.toHaveBeenCalled(); // 无 cursor 不查消息时间
  });
});

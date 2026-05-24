/**
 * P3 commit #3 — tilly-llm-analyzer tests.
 *
 * Run:  pnpm vitest run test/tilly-llm-analyzer.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

async function freshImport() {
  vi.resetModules();
  return await import('../src/services/tilly-llm-analyzer.js');
}

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'tilly-llm-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

/** Build a fake codex shell script that writes a fixed JSON to the file
 *  passed to `--output-last-message <FILE>`. */
function makeFakeCodex(jsonStr: string, exitCode = 0): string {
  const fp = join(tempDir, 'fake-codex.sh');
  // Bash parse args, find --output-last-message, write JSON there
  const body = `#!/bin/bash
while [ $# -gt 0 ]; do
  case "$1" in
    --output-last-message)
      echo '${jsonStr.replace(/'/g, "'\\''")}' > "$2"; shift 2;;
    *) shift;;
  esac
done
exit ${exitCode}
`;
  writeFileSync(fp, body, 'utf-8');
  chmodSync(fp, 0o755);
  return fp;
}

describe('tilly-llm-analyzer (P3 commit #3)', () => {
  it('empty messages → empty digest, ok=true (skips codex)', async () => {
    const { analyzeMessages } = await freshImport();
    const r = await analyzeMessages([]);
    expect(r.ok).toBe(true);
    expect(r.inputMessageCount).toBe(0);
    expect(r.todos).toEqual([]);
  });

  it('dryRun → empty digest, ok=true (skips codex)', async () => {
    const { analyzeMessages } = await freshImport();
    const r = await analyzeMessages([
      { messageId: 'om_a', chatId: 'oc_x', chatName: 'X', chatType: 'group', senderId: 'u1', senderType: 'user', msgType: 'text', content: 'hi', createTime: '' },
    ], { dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.todos).toEqual([]);
  });

  it('codex returns valid 4-bucket JSON → parsed digest', async () => {
    const fakeCodex = makeFakeCodex(JSON.stringify({
      todos: [
        { summary: '回复 PRD 评论', sourceChatId: 'oc_x', sourceMessageId: 'om_msg1', priority: 'high' },
      ],
      progress: [
        { summary: 'P2 已合并', sourceChatId: 'oc_x', sourceMessageId: 'om_msg2' },
      ],
      blockers: [],
      noteworthy: [
        { summary: '有意思的 design pattern', sourceChatId: 'oc_x', sourceMessageId: 'om_msg3' },
      ],
    }));
    const { analyzeMessages } = await freshImport();
    const r = await analyzeMessages([
      { messageId: 'om_msg1', chatId: 'oc_x', chatName: '群X', chatType: 'group', senderId: 'u1', senderType: 'user', msgType: 'text', content: '请回复 PRD', createTime: '23:00' },
      { messageId: 'om_msg2', chatId: 'oc_x', chatName: '群X', chatType: 'group', senderId: 'u2', senderType: 'user', msgType: 'text', content: 'P2 合并了', createTime: '23:05' },
      { messageId: 'om_msg3', chatId: 'oc_x', chatName: '群X', chatType: 'group', senderId: 'u3', senderType: 'user', msgType: 'text', content: '有个 pattern...', createTime: '23:10' },
    ], { codexPath: fakeCodex });
    expect(r.ok).toBe(true);
    expect(r.todos).toHaveLength(1);
    expect(r.todos[0].summary).toBe('回复 PRD 评论');
    expect(r.todos[0].priority).toBe('high');
    expect(r.todos[0].sourceChatName).toBe('群X');  // enriched from messages
    expect(r.progress).toHaveLength(1);
    expect(r.blockers).toEqual([]);
    expect(r.noteworthy).toHaveLength(1);
  });

  it('codex exit non-zero → fallback empty digest, ok=false', async () => {
    const fakeCodex = makeFakeCodex('{}', 1);
    const { analyzeMessages } = await freshImport();
    const r = await analyzeMessages([
      { messageId: 'om_a', chatId: 'oc_x', chatName: 'X', chatType: 'group', senderId: 'u1', senderType: 'user', msgType: 'text', content: 'hi', createTime: '' },
    ], { codexPath: fakeCodex });
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
    expect(r.todos).toEqual([]);
  });

  it('codex output non-JSON → fallback ok=false', async () => {
    const fakeCodex = makeFakeCodex('this is not json at all', 0);
    const { analyzeMessages } = await freshImport();
    const r = await analyzeMessages([
      { messageId: 'om_a', chatId: 'oc_x', chatName: 'X', chatType: 'group', senderId: 'u1', senderType: 'user', msgType: 'text', content: 'hi', createTime: '' },
    ], { codexPath: fakeCodex });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/parse failed|no JSON/);
  });

  it('codex output JSON wrapped in markdown → extracts and parses', async () => {
    const fakeCodex = makeFakeCodex(
      'Here is the analysis:\n```json\n' + JSON.stringify({ todos: [], progress: [], blockers: [], noteworthy: [] }) + '\n```',
      0,
    );
    const { analyzeMessages } = await freshImport();
    const r = await analyzeMessages([
      { messageId: 'om_a', chatId: 'oc_x', chatName: 'X', chatType: 'group', senderId: 'u1', senderType: 'user', msgType: 'text', content: 'hi', createTime: '' },
    ], { codexPath: fakeCodex });
    expect(r.ok).toBe(true);
  });

  it('each category caps at 5 items even if LLM returns more', async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      summary: `todo ${i}`, sourceChatId: 'oc_x', sourceMessageId: `om_${i}`,
    }));
    const fakeCodex = makeFakeCodex(JSON.stringify({ todos: items, progress: [], blockers: [], noteworthy: [] }));
    const { analyzeMessages } = await freshImport();
    const r = await analyzeMessages(
      items.map(it => ({ messageId: it.sourceMessageId, chatId: 'oc_x', chatName: 'X', chatType: 'group', senderId: 'u1', senderType: 'user', msgType: 'text', content: '', createTime: '' })),
      { codexPath: fakeCodex },
    );
    expect(r.todos).toHaveLength(5);
  });

  it('items missing required fields are dropped', async () => {
    const fakeCodex = makeFakeCodex(JSON.stringify({
      todos: [
        { summary: 'ok', sourceChatId: 'oc_x', sourceMessageId: 'om_a' },
        { sourceChatId: 'oc_x', sourceMessageId: 'om_b' },     // missing summary
        { summary: 'ok2' },                                      // missing sourceMessageId
      ],
      progress: [], blockers: [], noteworthy: [],
    }));
    const { analyzeMessages } = await freshImport();
    const r = await analyzeMessages(
      [{ messageId: 'om_a', chatId: 'oc_x', chatName: 'X', chatType: 'group', senderId: 'u1', senderType: 'user', msgType: 'text', content: '', createTime: '' }],
      { codexPath: fakeCodex },
    );
    expect(r.todos).toHaveLength(1);
    expect(r.todos[0].summary).toBe('ok');
  });
});

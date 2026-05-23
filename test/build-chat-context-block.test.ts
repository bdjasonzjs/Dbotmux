/**
 * Unit tests for buildChatContextBlock — the P1 main-bot mode prompt
 * injection helper.
 *
 * Run:  pnpm vitest run test/build-chat-context-block.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const readSpy = vi.fn();
vi.mock('../src/services/chat-context-store.js', () => ({
  read: readSpy,
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

async function freshImport() {
  vi.resetModules();
  return await import('../src/core/session-manager.js');
}

beforeEach(() => {
  readSpy.mockReset();
});

describe('buildChatContextBlock', () => {
  it('returns empty string when no ChatContext exists', async () => {
    readSpy.mockReturnValue(null);
    const { buildChatContextBlock } = await freshImport();
    expect(buildChatContextBlock('oc_no')).toBe('');
  });

  it('builds chat_context block with purpose + origin_type only when minimal', async () => {
    readSpy.mockReturnValue({
      chatId: 'oc_m',
      purpose: 'discuss X',
      originType: 'bot_spawned',
      relatedRefs: [],
      participants: [],
      inheritedFrom: null,
      activeTodoRefs: [],
      rules: [],
      injectionPolicy: 'eager',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const { buildChatContextBlock } = await freshImport();
    const block = buildChatContextBlock('oc_m');
    expect(block).toContain('<chat_context>');
    expect(block).toContain('<chat_id>oc_m</chat_id>');
    expect(block).toContain('<purpose>discuss X</purpose>');
    expect(block).toContain('<origin_type>bot_spawned</origin_type>');
    expect(block).toContain('</chat_context>');
    // optional blocks absent
    expect(block).not.toContain('<parent_chat_id>');
    expect(block).not.toContain('<active_todo_refs>');
    expect(block).not.toContain('<rules>');
  });

  it('includes parent_chat_id and parent_digest when set', async () => {
    readSpy.mockReturnValue({
      chatId: 'oc_p',
      purpose: 'x',
      originType: 'bot_spawned',
      relatedRefs: [],
      participants: [],
      inheritedFrom: { parentChatId: 'oc_parent', parentDigest: 'previous summary' },
      activeTodoRefs: [],
      rules: [],
      injectionPolicy: 'eager',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const { buildChatContextBlock } = await freshImport();
    const block = buildChatContextBlock('oc_p');
    expect(block).toContain('<parent_chat_id>oc_parent</parent_chat_id>');
    expect(block).toContain('<parent_digest>previous summary</parent_digest>');
  });

  it('includes active_todo_refs joined by " / "', async () => {
    readSpy.mockReturnValue({
      chatId: 'oc_t',
      purpose: 'x',
      originType: 'bot_spawned',
      relatedRefs: [],
      participants: [],
      inheritedFrom: null,
      activeTodoRefs: ['N6', 'N8'],
      rules: [],
      injectionPolicy: 'eager',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const { buildChatContextBlock } = await freshImport();
    const block = buildChatContextBlock('oc_t');
    expect(block).toContain('<active_todo_refs>N6 / N8</active_todo_refs>');
  });

  it('includes rules as nested <rule> tags', async () => {
    readSpy.mockReturnValue({
      chatId: 'oc_r',
      purpose: 'x',
      originType: 'bot_spawned',
      relatedRefs: [],
      participants: [],
      inheritedFrom: null,
      activeTodoRefs: [],
      rules: ['rule one', 'rule two'],
      injectionPolicy: 'eager',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const { buildChatContextBlock } = await freshImport();
    const block = buildChatContextBlock('oc_r');
    expect(block).toContain('<rules>');
    expect(block).toContain('<rule>rule one</rule>');
    expect(block).toContain('<rule>rule two</rule>');
    expect(block).toContain('</rules>');
  });

  it('xml-escapes special characters in purpose/rules/digest', async () => {
    readSpy.mockReturnValue({
      chatId: 'oc_esc',
      purpose: 'has <angle> & "quotes"',
      originType: 'bot_spawned',
      relatedRefs: [],
      participants: [],
      inheritedFrom: { parentChatId: 'oc_p', parentDigest: 'a & b < c' },
      activeTodoRefs: [],
      rules: ['rule with <html>'],
      injectionPolicy: 'eager',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const { buildChatContextBlock } = await freshImport();
    const block = buildChatContextBlock('oc_esc');
    expect(block).toContain('&lt;angle&gt;');
    expect(block).toContain('&amp;');
    expect(block).not.toContain('<angle>');  // original < not preserved
  });

  it('returns empty string and logs on store throw', async () => {
    readSpy.mockImplementation(() => { throw new Error('disk read'); });
    const { buildChatContextBlock } = await freshImport();
    expect(buildChatContextBlock('oc_bad')).toBe('');
  });
});

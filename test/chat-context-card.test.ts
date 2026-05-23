/**
 * Unit tests for chat-context-card: renderContextCardMarkdown + sendContextCard.
 *
 * Run:  pnpm vitest run test/chat-context-card.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const readSpy = vi.fn();
const sendMessageSpy = vi.fn();

vi.mock('../src/services/chat-context-store.js', () => ({
  read: readSpy,
}));

vi.mock('../src/im/lark/client.js', () => ({
  sendMessage: sendMessageSpy,
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/config.js', () => ({
  config: { dashboard: { externalHost: 'localhost', port: 7891 } },
}));

const pinCreateSpy = vi.fn().mockResolvedValue({ code: 0 });
vi.mock('../src/bot-registry.js', () => ({
  getBot: (larkAppId: string) => ({
    client: {
      im: {
        v1: {
          pin: { create: pinCreateSpy },
        },
      },
    },
  }),
}));

async function freshImport() {
  vi.resetModules();
  return await import('../src/im/lark/chat-context-card.js');
}

beforeEach(() => {
  readSpy.mockReset();
  sendMessageSpy.mockReset();
  pinCreateSpy.mockReset();
  pinCreateSpy.mockResolvedValue({ code: 0 });
});

const baseCtx = {
  chatId: 'oc_test',
  purpose: '讨论 X 议题',
  originType: 'bot_spawned' as const,
  relatedRefs: [],
  participants: [],
  inheritedFrom: null,
  activeTodoRefs: [],
  rules: [],
  injectionPolicy: 'eager' as const,
  updatedAt: '2026-05-23T22:00:00Z',
};

describe('renderContextCardMarkdown', () => {
  it('renders purpose as header', async () => {
    const { renderContextCardMarkdown } = await freshImport();
    const md = renderContextCardMarkdown(baseCtx);
    expect(md).toContain('🛠 **讨论 X 议题**');
  });

  it('renders inheritedFrom.parentChatId when set', async () => {
    const { renderContextCardMarkdown } = await freshImport();
    const md = renderContextCardMarkdown({
      ...baseCtx,
      inheritedFrom: { parentChatId: 'oc_parent', parentDigest: 'last 24h foo' },
    });
    expect(md).toContain('`oc_parent`');
    expect(md).toContain('父群最近 24h 关键讨论摘要');
    expect(md).toContain('> last 24h foo');
  });

  it('shows "(无父群)" when inheritedFrom is null', async () => {
    const { renderContextCardMarkdown } = await freshImport();
    const md = renderContextCardMarkdown(baseCtx);
    expect(md).toContain('(无父群)');
  });

  it('renders originType', async () => {
    const { renderContextCardMarkdown } = await freshImport();
    expect(renderContextCardMarkdown({ ...baseCtx, originType: 'p2p' })).toContain('`p2p`');
    expect(renderContextCardMarkdown({ ...baseCtx, originType: 'human_created' })).toContain('`human_created`');
  });

  it('renders activeTodoRefs list when non-empty', async () => {
    const { renderContextCardMarkdown } = await freshImport();
    const md = renderContextCardMarkdown({ ...baseCtx, activeTodoRefs: ['N6', 'N8'] });
    expect(md).toContain('N6 / N8');
  });

  it('renders participants with truncated open_ids', async () => {
    const { renderContextCardMarkdown } = await freshImport();
    const md = renderContextCardMarkdown({
      ...baseCtx,
      participants: [{ openId: 'ou_abcdef123456789', role: 'owner' }, { openId: 'ou_xyz', role: 'bot' }],
    });
    expect(md).toContain('owner(`ou_abcdef123…`)');
    expect(md).toContain('bot(`ou_xyz…`)');
  });

  it('renders rules when non-empty', async () => {
    const { renderContextCardMarkdown } = await freshImport();
    const md = renderContextCardMarkdown({ ...baseCtx, rules: ['不公开伴侣标签', '只松松能写'] });
    expect(md).toContain('不公开伴侣标签 / 只松松能写');
  });

  it('renders multi-line parentDigest as quote block', async () => {
    const { renderContextCardMarkdown } = await freshImport();
    const md = renderContextCardMarkdown({
      ...baseCtx,
      inheritedFrom: { parentChatId: 'p', parentDigest: 'line1\n\nline2\nline3' },
    });
    expect(md).toContain('> line1');
    expect(md).toContain('> line2');
    expect(md).toContain('> line3');
  });

  it('includes timestamp footer', async () => {
    const { renderContextCardMarkdown } = await freshImport();
    const md = renderContextCardMarkdown(baseCtx);
    expect(md).toContain('2026-05-23T22:00:00Z');
  });

  it('includes dashboard topology link with chatId fragment', async () => {
    const { renderContextCardMarkdown } = await freshImport();
    const md = renderContextCardMarkdown(baseCtx);
    expect(md).toContain('Dashboard 拓扑节点');
    expect(md).toContain('http://localhost:7891/#/topology?chat=oc_test');
  });
});

describe('buildDashboardChatUrl', () => {
  it('builds URL with chat fragment and url-encodes chatId', async () => {
    const { buildDashboardChatUrl } = await freshImport();
    expect(buildDashboardChatUrl('oc_abc')).toBe('http://localhost:7891/#/topology?chat=oc_abc');
  });
});

describe('renderContextCard', () => {
  it('returns a valid JSON string with body.elements', async () => {
    const { renderContextCard } = await freshImport();
    const json = renderContextCard(baseCtx);
    const parsed = JSON.parse(json);
    expect(parsed.schema).toBe('2.0');
    expect(parsed.body.direction).toBe('vertical');
    expect(Array.isArray(parsed.body.elements)).toBe(true);
    expect(parsed.body.elements.length).toBeGreaterThan(0);
  });
});

describe('sendContextCard', () => {
  it('sends interactive card via sendMessage when ChatContext exists + eager', async () => {
    readSpy.mockReturnValue(baseCtx);
    sendMessageSpy.mockResolvedValue('msg_123');
    const { sendContextCard } = await freshImport();
    const result = await sendContextCard('app_a', 'oc_test');
    expect(result).toBe('msg_123');
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    const [appId, chatId, content, msgType] = sendMessageSpy.mock.calls[0];
    expect(appId).toBe('app_a');
    expect(chatId).toBe('oc_test');
    expect(msgType).toBe('interactive');
    // content should be valid JSON (the card)
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it('returns null and skips send when no ChatContext', async () => {
    readSpy.mockReturnValue(null);
    const { sendContextCard } = await freshImport();
    expect(await sendContextCard('app_a', 'oc_missing')).toBeNull();
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('returns null and skips when injectionPolicy != eager', async () => {
    readSpy.mockReturnValue({ ...baseCtx, injectionPolicy: 'manual' });
    const { sendContextCard } = await freshImport();
    expect(await sendContextCard('app_a', 'oc_test')).toBeNull();
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('on_first_mention also skips eager auto-send', async () => {
    readSpy.mockReturnValue({ ...baseCtx, injectionPolicy: 'on_first_mention' });
    const { sendContextCard } = await freshImport();
    expect(await sendContextCard('app_a', 'oc_test')).toBeNull();
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('returns null and logs (no throw) when sendMessage rejects', async () => {
    readSpy.mockReturnValue(baseCtx);
    sendMessageSpy.mockRejectedValue(new Error('Lark API 503'));
    const { sendContextCard } = await freshImport();
    expect(await sendContextCard('app_a', 'oc_test')).toBeNull();
    expect(pinCreateSpy).not.toHaveBeenCalled();
  });

  it('pins the context card after sending (P0.5 dashboard pin)', async () => {
    readSpy.mockReturnValue(baseCtx);
    sendMessageSpy.mockResolvedValue('msg_42');
    const { sendContextCard } = await freshImport();
    const result = await sendContextCard('app_a', 'oc_test');
    expect(result).toBe('msg_42');
    expect(pinCreateSpy).toHaveBeenCalledTimes(1);
    expect(pinCreateSpy).toHaveBeenCalledWith({ data: { message_id: 'msg_42' } });
  });

  it('still returns messageId even if pin fails (best-effort)', async () => {
    readSpy.mockReturnValue(baseCtx);
    sendMessageSpy.mockResolvedValue('msg_77');
    pinCreateSpy.mockRejectedValue(new Error('pin 403'));
    const { sendContextCard } = await freshImport();
    expect(await sendContextCard('app_a', 'oc_test')).toBe('msg_77');
  });

  it('logs warn (no throw) when pin returns non-zero code', async () => {
    readSpy.mockReturnValue(baseCtx);
    sendMessageSpy.mockResolvedValue('msg_88');
    pinCreateSpy.mockResolvedValue({ code: 230009, msg: 'already pinned' });
    const { sendContextCard } = await freshImport();
    expect(await sendContextCard('app_a', 'oc_test')).toBe('msg_88');
  });
});

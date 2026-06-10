/**
 * 集成测试：验证 chat 模式 gate 真的作用在注入函数上，且新旧场景都不被影响。
 * - 旧场景（work / 缺省）：buildNewTopicPrompt + buildFollowUpContent **仍**注入 <output_discipline>。
 * - 新场景（chat）：两个注入点都**不**注入 <output_discipline>。
 * Run: pnpm vitest run test/chat-mode-injection.test.ts
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execSync: vi.fn(() => ''), execFileSync: vi.fn(() => '') }));
vi.mock('node:fs', async () => { const memfs = await import('memfs'); return memfs.fs; });
vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'pty', cliId: 'claude-code' },
  },
}));
vi.mock('../src/im/lark/client.js', () => ({
  downloadMessageResource: vi.fn(), listChatBotMembers: vi.fn(async () => []),
}));
vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({ config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' } })),
  getAllBots: vi.fn(() => []),
}));
vi.mock('../src/services/session-store.js', () => ({ createSession: vi.fn(), updateSession: vi.fn() }));
vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: vi.fn(), killStalePids: vi.fn(), getCurrentCliVersion: vi.fn(() => '1.0.0'),
}));
// 关键：只有 oc_chat 是闲聊群，其它（含 undefined）都 work。
vi.mock('../src/services/chat-mode-store.js', () => ({
  getChatMode: (id?: string) => (id === 'oc_chat' ? 'chat' : 'work'),
}));

import { buildNewTopicPrompt, buildFollowUpContent } from '../src/core/session-manager.js';

const SID = 'sess_test';
const DISC = '<output_discipline>';

describe('chat 模式 gate · 新旧场景注入对比', () => {
  describe('buildFollowUpContent（后续每轮）', () => {
    it('旧场景 work 群 → 仍注入 output_discipline', () => {
      expect(buildFollowUpContent('hi', SID, { chatId: 'oc_work' })).toContain(DISC);
    });
    it('缺省（无 chatId）→ 默认 work，仍注入', () => {
      expect(buildFollowUpContent('hi', SID, {})).toContain(DISC);
    });
    it('新场景 chat 群 → 不注入 output_discipline', () => {
      expect(buildFollowUpContent('hi', SID, { chatId: 'oc_chat' })).not.toContain(DISC);
    });
  });

  describe('buildNewTopicPrompt（建群首轮）', () => {
    const tail = (chatId?: string) =>
      buildNewTopicPrompt('hi', SID, 'claude-code', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, chatId);
    it('旧场景 work 群 → 仍注入 output_discipline', () => {
      expect(tail('oc_work')).toContain(DISC);
    });
    it('缺省（无 chatId）→ 默认 work，仍注入', () => {
      expect(tail(undefined)).toContain(DISC);
    });
    it('新场景 chat 群 → 不注入 output_discipline', () => {
      expect(tail('oc_chat')).not.toContain(DISC);
    });
  });
});

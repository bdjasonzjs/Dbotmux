/**
 * 块 5 注入测试：buildSubtaskMemberBlock 的「裂变授权（双帽角色重述）」变体。
 * - spawnable !== true（含全部存量任务）→ 输出**逐字**不含裂变段（钉死存量行为）。
 * - spawnable === true 且本 bot 是执行者(main) → 注入裂变段（depth 余量正确）。
 * - spawnable === true 但本 bot 是 reviewer → 不注入（授权只给执行者）。
 * Run: pnpm vitest run test/subtask-spawnable-injection.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({ execSync: vi.fn(() => ''), execFileSync: vi.fn(() => '') }));
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
const mockGetBot = vi.fn();
vi.mock('../src/bot-registry.js', () => ({
  getBot: (...a: any[]) => mockGetBot(...a),
  getAllBots: vi.fn(() => []),
}));
vi.mock('../src/services/session-store.js', () => ({ createSession: vi.fn(), updateSession: vi.fn() }));
vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: vi.fn(), killStalePids: vi.fn(), getCurrentCliVersion: vi.fn(() => '1.0.0'),
}));
const mockGetByChatId = vi.fn();
vi.mock('../src/services/subtask-store.js', () => ({ getByChatId: (...a: any[]) => mockGetByChatId(...a) }));

import { buildSubtaskMemberBlock } from '../src/core/session-manager.js';

const FISSION = '【裂变授权（spawnable）】';
const BOTS = [
  { openId: 'ou_claude', name: '克劳德', role: 'main' },
  { openId: 'ou_codex', name: '蔻黛克斯', role: 'collab' },
  { openId: 'ou_coco', name: '缇蕾', role: 'observer' },
];
function mkTask(over: Record<string, unknown> = {}) {
  return {
    taskId: 'st_1', chatId: 'oc_sub', parentChatId: 'oc_main', goal: '修 bug', acceptance: null,
    bots: BOTS, status: 'observing', ...over,
  };
}
function asClaude() {
  mockGetBot.mockReturnValue({ botOpenId: 'ou_claude', config: { cliId: 'claude-code', larkAppId: 'app_claude' } });
}
function asCodex() {
  mockGetBot.mockReturnValue({ botOpenId: 'ou_codex', config: { cliId: 'codex', larkAppId: 'app_codex' } });
}

afterEach(() => vi.unstubAllEnvs());

describe('buildSubtaskMemberBlock · 裂变授权变体', () => {
  it('spawnable 缺省（存量任务）→ 不含裂变段，结构与原版一致', () => {
    asClaude();
    mockGetByChatId.mockReturnValue(mkTask());
    const block = buildSubtaskMemberBlock('oc_sub', 'app_claude');
    expect(block).toContain('<subtask_member_routing>');
    expect(block).toContain('【你的角色】');
    expect(block).not.toContain(FISSION);
    // 裂变段插在【你的角色】与【群里其他成员】之间——无裂变时两段紧邻（逐字回归锚点）
    expect(block).toMatch(/【你的角色】[^\n]*\n\n【群里其他成员】/);
  });

  it('spawnable=false 显式 → 同样不含', () => {
    asClaude();
    mockGetByChatId.mockReturnValue(mkTask({ spawnable: false }));
    expect(buildSubtaskMemberBlock('oc_sub', 'app_claude')).not.toContain(FISSION);
  });

  it('spawnable=true + 执行者(main) → 注入裂变段，depth 余量正确', () => {
    asClaude();
    mockGetByChatId.mockReturnValue(mkTask({ spawnable: true, depth: 1 }));
    const block = buildSubtaskMemberBlock('oc_sub', 'app_claude');
    expect(block).toContain(FISSION);
    expect(block).toContain('当前深度 1/2');
    expect(block).toContain('还能开 1 层');
    expect(block).toContain('subtask-query');           // 对下职责：query+ack
    expect(block).toContain('不许拿到任务转手即裂');
  });

  it('spawnable=true 但本 bot 是 reviewer(codex) → 不注入（授权只给执行者）', () => {
    asCodex();
    mockGetByChatId.mockReturnValue(mkTask({ spawnable: true, depth: 1 }));
    expect(buildSubtaskMemberBlock('oc_sub', 'app_codex')).not.toContain(FISSION);
  });

  it('depth 触顶（depth=2, max=2）→ 余量显示 0 层', () => {
    asClaude();
    mockGetByChatId.mockReturnValue(mkTask({ spawnable: true, depth: 2 }));
    const block = buildSubtaskMemberBlock('oc_sub', 'app_claude');
    expect(block).toContain('当前深度 2/2');
    expect(block).toContain('还能开 0 层');
  });
});

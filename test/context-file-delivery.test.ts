/**
 * 上下文注入「文件引用化」（context file delivery）测试。
 * 设计: Dbotmux-task-notes/design-context-file-delivery.md
 *
 * 覆盖（对应验收标准 ①②③④⑤）:
 *   - inline 模式（默认）: 行为与现状一致——四个半静态块照旧全文注入、无 <context_ref>（③）
 *   - file 模式: 消息体只含 user_message + 动态小块 + <context_ref> stub；块全文进本地文件（①）
 *   - 内容变化（chat_context 更新 / 子任务 finished）→ version 变化 + 文件更新（②）
 *   - 内容不变 → 零 IO（不重写文件）
 *   - 写失败 → 整轮回落 inline 全量注入
 *   - adopt 路径 / 未知 cliId → 保守 inline（④）
 *   - stub 内保留红线速记 inline（⑤）
 *   - context-delivery-store: per-chat 覆盖 > 全局默认 > inline；坏配置回 inline
 *
 * Run: pnpm vitest run test/context-file-delivery.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// ─── Mocks（照 prompt-builder / chat-mode-injection 的配方） ─────────────────

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
  getBot: vi.fn(() => ({ config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' }, botName: '克劳德', botOpenId: 'ou_self' })),
  getAllBots: vi.fn(() => []),
}));
vi.mock('../src/services/session-store.js', () => ({ createSession: vi.fn(), updateSession: vi.fn() }));
vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: vi.fn(), killStalePids: vi.fn(), getCurrentCliVersion: vi.fn(() => '1.0.0'),
}));

// 子任务 store：可变 holder，测「finished → 块消失 → version 变化」
const subtaskState = vi.hoisted(() => ({ task: null as any }));
vi.mock('../src/services/subtask-store.js', () => ({
  getByChatId: (chatId: string) => (subtaskState.task && subtaskState.task.chatId === chatId ? subtaskState.task : null),
}));

import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { buildNewTopicPrompt, buildFollowUpContent } from '../src/core/session-manager.js';
import { buildContextBlocks, buildOutputDisciplineBlock, renderContextRefStub } from '../src/core/context-providers.js';
import {
  getContextDelivery, getContextDeliveryWithSource, setContextDelivery, setGlobalContextDelivery, clearContextDelivery,
} from '../src/services/context-delivery-store.js';
import { materializeContextFile, contextFilePath, __resetContextFileCacheForTesting } from '../src/services/context-file-manager.js';

const SID = 'sess_cfd';
const APP = 'app_test';
const CTX_ROOT = '/tmp/ctx-root';
const DATA = '/tmp/test-sessions';

function writeChatContextFixture(chatId: string, purpose: string): void {
  mkdirSync(`${DATA}/chat-contexts`, { recursive: true });
  writeFileSync(`${DATA}/chat-contexts/${chatId}.json`, JSON.stringify({
    chatId, purpose, originType: 'bot_spawned',
    relatedRefs: [], participants: [], inheritedFrom: null,
    activeTodoRefs: [], rules: ['规则一'], injectionPolicy: 'eager',
  }), 'utf-8');
}

function rmrf(p: string): void {
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

function stubVersion(prompt: string): string | null {
  return prompt.match(/<context_ref path="[^"]+" version="([0-9a-f]{8})">/)?.[1] ?? null;
}

beforeAll(() => {
  process.env.BOTMUX_CONTEXT_DIR = CTX_ROOT;
});

beforeEach(() => {
  __resetContextFileCacheForTesting();
  subtaskState.task = null;
  rmrf(CTX_ROOT);
  rmrf(`${DATA}/context-delivery`);
  rmrf(`${DATA}/chat-contexts`);
  rmrf(`${DATA}/chat-modes`);
});

// ─── context-delivery-store ──────────────────────────────────────────────────

describe('context-delivery-store（灰度开关解析）', () => {
  it('默认 inline（无任何配置）', () => {
    expect(getContextDelivery('oc_any')).toBe('inline');
    expect(getContextDeliveryWithSource('oc_any')).toEqual({ mode: 'inline', source: 'default' });
  });

  it('per-chat 覆盖生效', () => {
    setContextDelivery('oc_a', 'file');
    expect(getContextDelivery('oc_a')).toBe('file');
    expect(getContextDelivery('oc_b')).toBe('inline'); // 别的群不受影响
  });

  it('全局默认 file + per-chat inline 覆盖：per-chat 优先', () => {
    setGlobalContextDelivery('file');
    expect(getContextDelivery('oc_x')).toBe('file');
    expect(getContextDeliveryWithSource('oc_x').source).toBe('global');
    setContextDelivery('oc_x', 'inline');
    expect(getContextDelivery('oc_x')).toBe('inline');
    expect(getContextDeliveryWithSource('oc_x').source).toBe('chat');
  });

  it('清除 per-chat 覆盖回到全局默认', () => {
    setGlobalContextDelivery('file');
    setContextDelivery('oc_c', 'inline');
    expect(getContextDelivery('oc_c')).toBe('inline');
    expect(clearContextDelivery('oc_c')).toBe(true);
    expect(getContextDelivery('oc_c')).toBe('file');
    expect(clearContextDelivery('oc_c')).toBe(false); // 幂等
  });

  it('配置损坏 → 当 unset 处理（绝不误切 file）', () => {
    mkdirSync(`${DATA}/context-delivery`, { recursive: true });
    writeFileSync(`${DATA}/context-delivery/oc_bad.json`, '{{{not json', 'utf-8');
    expect(getContextDelivery('oc_bad')).toBe('inline');
  });
});

// ─── context-file-manager ────────────────────────────────────────────────────

describe('context-file-manager（物化 + 版本 + 零 IO）', () => {
  const SECTIONS = [{ id: 'output_discipline', text: '<output_discipline>\nX\n</output_discipline>' }];

  it('写文件 + 返回 8 位 hash version；文件含分节与 provider 标记', () => {
    const mat = materializeContextFile('oc_m', APP, SECTIONS);
    expect(mat).not.toBeNull();
    expect(mat!.path).toBe(contextFilePath('oc_m', APP));
    expect(mat!.version).toMatch(/^[0-9a-f]{8}$/);
    const content = readFileSync(mat!.path, 'utf-8');
    expect(content).toContain('<!-- provider: output_discipline -->');
    expect(content).toContain('<output_discipline>');
  });

  it('内容不变且文件仍在 → 零写 IO（不触碰文件内容），version 稳定', () => {
    const m1 = materializeContextFile('oc_m', APP, SECTIONS)!;
    // 手动把文件内容改成 sentinel：若第二次调用发生重写，sentinel 会被覆盖
    writeFileSync(m1.path, 'SENTINEL-no-rewrite', 'utf-8');
    const m2 = materializeContextFile('oc_m', APP, SECTIONS)!;
    expect(m2.version).toBe(m1.version);
    expect(readFileSync(m1.path, 'utf-8')).toBe('SENTINEL-no-rewrite'); // 缓存命中未重写
  });

  it('缓存命中但文件被外部删除 → 自动补写（stub 绝不指向不存在的文件，review P1）', () => {
    const m1 = materializeContextFile('oc_m', APP, SECTIONS)!;
    rmSync(m1.path); // 模拟人工清理 / 其它 daemon GC 误删
    const m2 = materializeContextFile('oc_m', APP, SECTIONS)!;
    expect(m2).not.toBeNull();
    expect(m2!.version).toBe(m1.version);
    expect(existsSync(m1.path)).toBe(true); // 文件已补写回来
    expect(readFileSync(m1.path, 'utf-8')).toContain('<output_discipline>');
  });

  it('进程重启（缓存清空）后内容不变 → 读现有文件比对，不重写', () => {
    const m1 = materializeContextFile('oc_m', APP, SECTIONS)!;
    __resetContextFileCacheForTesting(); // 模拟 daemon 重启
    const m2 = materializeContextFile('oc_m', APP, SECTIONS)!;
    expect(m2.version).toBe(m1.version);
  });

  it('内容变化 → version 变化 + 文件更新（验收②机制）', () => {
    const m1 = materializeContextFile('oc_m', APP, SECTIONS)!;
    const m2 = materializeContextFile('oc_m', APP, [{ id: 'output_discipline', text: '<output_discipline>\nY\n</output_discipline>' }])!;
    expect(m2.version).not.toBe(m1.version);
    expect(readFileSync(m2.path, 'utf-8')).toContain('Y');
  });

  it('写失败（根路径被文件占位）→ 返回 null 不抛', () => {
    mkdirSync('/tmp', { recursive: true });
    process.env.BOTMUX_CONTEXT_DIR = '/tmp/ctx-blocked';
    try {
      writeFileSync('/tmp/ctx-blocked', 'not a dir', 'utf-8');
      expect(materializeContextFile('oc_m', APP, SECTIONS)).toBeNull();
    } finally {
      process.env.BOTMUX_CONTEXT_DIR = CTX_ROOT;
      rmrf('/tmp/ctx-blocked');
    }
  });
});

// ─── buildContextBlocks：inline（默认）回归 ──────────────────────────────────

describe('inline 模式（默认）——行为与现状一致（验收③）', () => {
  it('无配置时注入全文块、无 <context_ref>', () => {
    writeChatContextFixture('oc_reg', '回归测试群');
    const prompt = buildNewTopicPrompt('hi', SID, 'claude-code',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      'oc_reg', APP);
    expect(prompt).toContain('<chat_context>');
    expect(prompt).toContain('回归测试群');
    expect(prompt).toContain('<output_discipline>');
    expect(prompt).not.toContain('<context_ref');
  });

  it('follow_up 轮不注入 chat_context（历史行为：仅首轮）', () => {
    writeChatContextFixture('oc_reg', '回归测试群');
    const content = buildFollowUpContent('hi', SID, { chatId: 'oc_reg', larkAppId: APP, cliId: 'claude-code' });
    expect(content).not.toContain('<chat_context>');
    expect(content).toContain('<output_discipline>');
  });

  it('buildContextBlocks(inline) 输出 == 各 legacy builder 输出原文（逐字节）', () => {
    writeChatContextFixture('oc_reg', '回归测试群');
    const blocks = buildContextBlocks({ chatId: 'oc_reg', larkAppId: APP, round: 'new_topic', cliId: 'claude-code' });
    // 本场景命中 chat_context + output_discipline（非主话题、非子任务群）
    expect(blocks).toHaveLength(2);
    expect(blocks[0].startsWith('<chat_context>')).toBe(true);
    expect(blocks[1]).toBe(buildOutputDisciplineBlock());
  });
});

// ─── buildContextBlocks：file 模式 ───────────────────────────────────────────

describe('file 模式（验收①②⑤）', () => {
  const CHAT = 'oc_file';

  function activeTask(status = 'active'): any {
    return {
      taskId: 'st_test', chatId: CHAT, status,
      goal: '测试目标·文件引用化', acceptance: '验收·全绿',
      bots: [
        { name: '克劳德', openId: 'ou_self', role: 'main' },
        { name: '蔻黛克斯', openId: 'ou_reviewer', role: 'collab' },
      ],
    };
  }

  it('消息体只带 stub（含红线速记），块全文进本地文件', () => {
    setContextDelivery(CHAT, 'file');
    writeChatContextFixture(CHAT, '文件模式测试群');
    subtaskState.task = activeTask();

    const prompt = buildNewTopicPrompt('hello file mode', SID, 'claude-code',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { openId: 'ou_sender', type: 'user', name: '张三' },
      CHAT, APP);

    // 消息体：user_message + 动态小块 + stub
    expect(prompt).toContain('<user_message>\nhello file mode\n</user_message>');
    expect(prompt).toContain('<sender type="user"');
    const version = stubVersion(prompt);
    expect(version).not.toBeNull();
    // 红线速记保留 inline（验收⑤）
    expect(prompt).toContain('红线速记');
    // 大块全文不再出现在消息体
    expect(prompt).not.toContain('<output_discipline>');
    expect(prompt).not.toContain('<chat_context>');
    expect(prompt).not.toContain('<subtask_member_routing>');

    // 块全文进文件（按 provider 分节）
    const file = readFileSync(contextFilePath(CHAT, APP), 'utf-8');
    expect(file).toContain('<chat_context>');
    expect(file).toContain('文件模式测试群');
    expect(file).toContain('<subtask_member_routing>');
    expect(file).toContain('测试目标·文件引用化');
    expect(file).toContain('<subtask_escalation_protocol>');
    expect(file).toContain('<output_discipline>');
  });

  it('内容没变 → 两轮 version 一致；chat_context 更新 → version 变化 + 文件更新（验收②）', () => {
    setContextDelivery(CHAT, 'file');
    writeChatContextFixture(CHAT, '初版 purpose');
    const p1 = buildNewTopicPrompt('r1', SID, 'claude-code', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, CHAT, APP);
    const p2 = buildFollowUpContent('r2', SID, { chatId: CHAT, larkAppId: APP, cliId: 'claude-code' });
    const v1 = stubVersion(p1)!;
    expect(stubVersion(p2)).toBe(v1);

    writeChatContextFixture(CHAT, '更新后的 purpose');
    const p3 = buildFollowUpContent('r3', SID, { chatId: CHAT, larkAppId: APP, cliId: 'claude-code' });
    const v3 = stubVersion(p3)!;
    expect(v3).not.toBe(v1);
    expect(readFileSync(contextFilePath(CHAT, APP), 'utf-8')).toContain('更新后的 purpose');
  });

  it('follow_up 轮 file 文件里也含 chat_context（file 运载不受「仅首轮」限制）', () => {
    setContextDelivery(CHAT, 'file');
    writeChatContextFixture(CHAT, '后续轮也要在文件里');
    const content = buildFollowUpContent('hi', SID, { chatId: CHAT, larkAppId: APP, cliId: 'claude-code' });
    expect(stubVersion(content)).not.toBeNull();
    expect(readFileSync(contextFilePath(CHAT, APP), 'utf-8')).toContain('后续轮也要在文件里');
  });

  it('任务 finished → subtask 分节消失 → version 变化（「不再注入」语义，验收②）', () => {
    setContextDelivery(CHAT, 'file');
    subtaskState.task = activeTask('active');
    const p1 = buildFollowUpContent('r1', SID, { chatId: CHAT, larkAppId: APP, cliId: 'claude-code' });
    const v1 = stubVersion(p1)!;
    expect(readFileSync(contextFilePath(CHAT, APP), 'utf-8')).toContain('<subtask_member_routing>');

    subtaskState.task = activeTask('finished');
    const p2 = buildFollowUpContent('r2', SID, { chatId: CHAT, larkAppId: APP, cliId: 'claude-code' });
    const v2 = stubVersion(p2)!;
    expect(v2).not.toBe(v1);
    expect(readFileSync(contextFilePath(CHAT, APP), 'utf-8')).not.toContain('<subtask_member_routing>');
  });

  it('写失败 → 整轮回落 inline 全量注入（绝不丢上下文）', () => {
    setContextDelivery(CHAT, 'file');
    writeChatContextFixture(CHAT, '回落测试');
    process.env.BOTMUX_CONTEXT_DIR = '/tmp/ctx-blocked2';
    try {
      writeFileSync('/tmp/ctx-blocked2', 'not a dir', 'utf-8');
      const prompt = buildNewTopicPrompt('hi', SID, 'claude-code', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, CHAT, APP);
      expect(prompt).not.toContain('<context_ref');
      expect(prompt).toContain('<chat_context>');
      expect(prompt).toContain('<output_discipline>');
    } finally {
      process.env.BOTMUX_CONTEXT_DIR = CTX_ROOT;
      rmrf('/tmp/ctx-blocked2');
    }
  });

  it('闲聊群（mode=chat）在 file 模式下 output_discipline 同样不进文件', () => {
    setContextDelivery(CHAT, 'file');
    mkdirSync(`${DATA}/chat-modes`, { recursive: true });
    writeFileSync(`${DATA}/chat-modes/${CHAT}.json`, JSON.stringify({ chatId: CHAT, mode: 'chat', since: 'x' }), 'utf-8');
    writeChatContextFixture(CHAT, '闲聊群但有 chat_context');
    const prompt = buildNewTopicPrompt('hi', SID, 'claude-code', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, CHAT, APP);
    expect(stubVersion(prompt)).not.toBeNull();
    expect(readFileSync(contextFilePath(CHAT, APP), 'utf-8')).not.toContain('<output_discipline>');
  });
});

// ─── 保守回落 gate（验收④相关） ─────────────────────────────────────────────

describe('能力 gate：adopt / 未知 cliId → 保守 inline', () => {
  const CHAT = 'oc_gate';

  it('adopt 会话即使配了 file 也走 inline（bridge 根本不经过装配器）', () => {
    setContextDelivery(CHAT, 'file');
    const content = buildFollowUpContent('hi', SID, { chatId: CHAT, larkAppId: APP, cliId: 'claude-code', isAdoptMode: true });
    expect(content).not.toContain('<context_ref');
    expect(content).toContain('<output_discipline>');
  });

  it('缺 cliId（引擎未知）→ inline', () => {
    setContextDelivery(CHAT, 'file');
    const blocks = buildContextBlocks({ chatId: CHAT, larkAppId: APP, round: 'follow_up' });
    expect(blocks.join('\n')).not.toContain('<context_ref');
    expect(blocks.join('\n')).toContain('<output_discipline>');
  });

  it('缺 chatId / larkAppId → inline', () => {
    setGlobalContextDelivery('file');
    const blocks = buildContextBlocks({ round: 'follow_up', cliId: 'claude-code' });
    expect(blocks.join('\n')).not.toContain('<context_ref');
  });
});

// ─── stub 渲染 ───────────────────────────────────────────────────────────────

describe('renderContextRefStub', () => {
  it('含 path/version 属性 + 重读指引 + 红线速记；path 做 XML 转义', () => {
    const stub = renderContextRefStub('/a/b "c".md', 'ab12cd34');
    expect(stub).toContain('path="/a/b &quot;c&quot;.md"');
    expect(stub).toContain('version="ab12cd34"');
    expect(stub).toContain('必须先 Read 该文件');
    expect(stub).toContain('红线速记');
    expect(stub).toContain('未经显式授权不 commit/push/deploy');
  });
});

/**
 * P1 commit #8 — main-bot prompt injection + worker env contract tests (PR-1~5).
 *
 * Run:  pnpm vitest run test/main-bot-prompt-injection.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let fakeMainTopic: string | undefined;
const fakeBotsByAppId = new Map<string, { config: { cliId: string } }>();

vi.mock('../src/services/main-topic-config.js', () => ({
  getMainTopicChatId: () => fakeMainTopic,
  isTillyMainTopicConversationDenied: () => false,
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: (appId: string) => {
    const b = fakeBotsByAppId.get(appId);
    if (!b) throw new Error(`bot not found: ${appId}`);
    return b;
  },
  getAllBots: () => [...fakeBotsByAppId.values()],
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

async function freshImport() {
  vi.resetModules();
  return await import('../src/core/session-manager.js');
}

beforeEach(() => {
  fakeMainTopic = undefined;
  fakeBotsByAppId.clear();
  fakeBotsByAppId.set('cli_claude', { config: { cliId: 'claude-code' } });
  fakeBotsByAppId.set('cli_codex',  { config: { cliId: 'codex' } });
});

describe('buildMainBotPromptBlock (P1 commit #8)', () => {
  describe('PR-1 — mainTopic + Claude → block rendered', () => {
    it('emits <main_bot_routing> when chatId === mainTopic AND larkAppId is Claude', async () => {
      fakeMainTopic = 'oc_flumy';
      const { buildMainBotPromptBlock } = await freshImport();
      const block = buildMainBotPromptBlock('oc_flumy', 'cli_claude');
      expect(block).toContain('<main_bot_routing>');
      expect(block).toContain('Flumy 主话题');
      expect(block).toContain('botmux subtask-start');
    });
  });

  describe('PR-2 — non-mainTopic chat → block omitted', () => {
    it('returns empty string when chatId is not the mainTopic', async () => {
      fakeMainTopic = 'oc_flumy';
      const { buildMainBotPromptBlock } = await freshImport();
      expect(buildMainBotPromptBlock('oc_other_chat', 'cli_claude')).toBe('');
    });
    it('returns empty string when mainTopic is unset', async () => {
      fakeMainTopic = undefined;
      const { buildMainBotPromptBlock } = await freshImport();
      expect(buildMainBotPromptBlock('oc_anything', 'cli_claude')).toBe('');
    });
  });

  describe('PR-3 — non-Claude bot in mainTopic → block omitted', () => {
    it('returns empty string when larkAppId is Codex / tilly / any non-claude-code', async () => {
      fakeMainTopic = 'oc_flumy';
      const { buildMainBotPromptBlock } = await freshImport();
      expect(buildMainBotPromptBlock('oc_flumy', 'cli_codex')).toBe('');
    });
    it('returns empty string when larkAppId is undefined', async () => {
      fakeMainTopic = 'oc_flumy';
      const { buildMainBotPromptBlock } = await freshImport();
      expect(buildMainBotPromptBlock('oc_flumy', undefined)).toBe('');
    });
    it('returns empty string when larkAppId is unknown to bot-registry', async () => {
      fakeMainTopic = 'oc_flumy';
      const { buildMainBotPromptBlock } = await freshImport();
      expect(buildMainBotPromptBlock('oc_flumy', 'cli_unknown')).toBe('');
    });
  });
});

describe('PR-4 — worker-pool env injection contract', () => {
  it('worker-pool.ts fork() calls inject BOTMUX_SESSION_ID into env', () => {
    const src = readFileSync(
      join(__dirname, '..', 'src', 'core', 'worker-pool.ts'),
      'utf-8',
    );
    // Both fork() blocks must include BOTMUX_SESSION_ID. Count both.
    const matches = src.match(/BOTMUX_SESSION_ID:\s*ds\.session\.sessionId/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);  // 2 known fork sites
  });
});

describe('PR-6 — main-bot routing injected per-round (follow-up path too)', () => {
  // 主话题主 bot 多轮对话后会丢 <main_bot_routing>（只首轮注入）→ 复杂任务不再拉子群。
  // 契约：buildFollowUpContent 也必须调用 buildMainBotPromptBlock（gate 自带，只对主 bot 生效）。
  it('buildFollowUpContent calls buildMainBotPromptBlock (so the block is re-injected each round)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'core', 'session-manager.ts'), 'utf-8');
    const fnStart = src.indexOf('export function buildFollowUpContent');
    expect(fnStart).toBeGreaterThan(-1);
    // 取该函数体到下一个 top-level export 之前，确认注入点在 follow-up 函数内部。
    const after = src.slice(fnStart);
    const nextExport = after.indexOf('\nexport ', 1);
    const body = nextExport > -1 ? after.slice(0, nextExport) : after;
    expect(body).toContain('buildMainBotPromptBlock(');
  });
});

describe('PR-5 — architecture contract: no ad-hoc worker fork outside worker-pool', () => {
  it('no other src/ file calls child_process.fork to spawn the worker', () => {
    const { readdirSync, statSync } = require('node:fs');
    const srcDir = join(__dirname, '..', 'src');
    // Whitelist files allowed to fork workers (real spawner + tests in test/).
    // worker-pool.ts is THE spawner; workflows/daemon-spawn.ts spawns daemons,
    // not worker processes, so it's also allowed but should not inject
    // BOTMUX_SESSION_ID (different env contract).
    const allow = new Set([
      'worker-pool.ts',
      'daemon-spawn.ts',
    ]);
    const offenders: string[] = [];
    function walk(dir: string): void {
      for (const f of readdirSync(dir)) {
        const fp = join(dir, f);
        const st = statSync(fp);
        if (st.isDirectory()) { walk(fp); continue; }
        if (!fp.endsWith('.ts')) continue;
        if (allow.has(f)) continue;
        const src = readFileSync(fp, 'utf-8');
        // Look for `fork(` from 'node:child_process' (not unrelated fork
        // method names like git.fork or whatever). We grep narrowly.
        if (/import\s*\{[^}]*\bfork\b[^}]*\}\s*from\s*['"]node:child_process['"]/.test(src) ||
            /from\s*['"]child_process['"][^;]*fork\b/.test(src)) {
          offenders.push(fp);
        }
      }
    }
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});

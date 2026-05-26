/**
 * P1 commit #2 — main-topic config reader / writer tests (CFG-1-4).
 *
 * Run:  pnpm vitest run test/config-main-topic.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each test gets a fresh fake home so config.json and chat-topology.json
// don't leak across tests / pollute the real ~/.botmux.
let fakeHome: string;
let fakeDataDir: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => fakeHome,
  };
});

vi.mock('../src/config.js', () => ({
  config: {
    get session() { return { dataDir: fakeDataDir }; },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

async function freshImport() {
  vi.resetModules();
  return {
    cfg: await import('../src/services/main-topic-config.js'),
    topo: await import('../src/services/chat-topology-store.js'),
  };
}

describe('main-topic-config (P1 commit #2)', () => {
  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'mtc-home-'));
    fakeDataDir = mkdtempSync(join(tmpdir(), 'mtc-data-'));
    delete process.env.BOTMUX_MAIN_TOPIC_CHAT_ID;
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(fakeDataDir, { recursive: true, force: true });
    delete process.env.BOTMUX_MAIN_TOPIC_CHAT_ID;
  });

  describe('CFG-1 — env override beats file', () => {
    it('env BOTMUX_MAIN_TOPIC_CHAT_ID wins over config file', async () => {
      const { cfg } = await freshImport();
      cfg.setMainTopicChatId('oc_from_file');         // file = oc_from_file
      process.env.BOTMUX_MAIN_TOPIC_CHAT_ID = 'oc_from_env';
      expect(cfg.getMainTopicChatId()).toBe('oc_from_env');
    });
    it('whitespace-only env is treated as unset (falls back to file)', async () => {
      const { cfg } = await freshImport();
      cfg.setMainTopicChatId('oc_from_file');
      process.env.BOTMUX_MAIN_TOPIC_CHAT_ID = '   ';
      expect(cfg.getMainTopicChatId()).toBe('oc_from_file');
    });
  });

  describe('CFG-2 — file write/read round-trip', () => {
    it('setMainTopicChatId then getMainTopicChatId returns set value', async () => {
      const { cfg } = await freshImport();
      cfg.setMainTopicChatId('oc_flumy');
      expect(cfg.getMainTopicChatId()).toBe('oc_flumy');
    });
    it('persists across freshImport (file actually written, not cached)', async () => {
      {
        const { cfg } = await freshImport();
        cfg.setMainTopicChatId('oc_persisted');
      }
      const { cfg } = await freshImport();
      expect(cfg.getMainTopicChatId()).toBe('oc_persisted');
    });
    it('setMainTopicChatId(null) clears the file entry', async () => {
      const { cfg } = await freshImport();
      cfg.setMainTopicChatId('oc_x');
      cfg.setMainTopicChatId(null);
      expect(cfg.getMainTopicChatId()).toBeUndefined();
    });
  });

  describe('CFG-3 — neither set', () => {
    it('returns undefined when neither env nor file is set', async () => {
      const { cfg } = await freshImport();
      expect(cfg.getMainTopicChatId()).toBeUndefined();
    });
    it('returns undefined when config file is corrupt', async () => {
      const { cfg } = await freshImport();
      // Write corrupt config
      const fp = join(fakeHome, '.botmux', 'config.json');
      // mkdir + write garbage
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(join(fakeHome, '.botmux'), { recursive: true });
      writeFileSync(fp, '{{not json', 'utf-8');
      expect(cfg.getMainTopicChatId()).toBeUndefined();
    });
  });

  describe('CFG-4 — writer syncs ChatTopology.rootChatId', () => {
    it('setMainTopicChatId(X) → ChatTopology.rootChatId === X', async () => {
      const { cfg, topo } = await freshImport();
      cfg.setMainTopicChatId('oc_synced');
      expect(topo.readTopology().rootChatId).toBe('oc_synced');
    });
    it('setMainTopicChatId(null) → ChatTopology.rootChatId === ""', async () => {
      const { cfg, topo } = await freshImport();
      cfg.setMainTopicChatId('oc_first');
      cfg.setMainTopicChatId(null);
      expect(topo.readTopology().rootChatId).toBe('');
    });
    it('syncRootChatIdFromConfig() re-derives rootChatId from env', async () => {
      const { cfg, topo } = await freshImport();
      process.env.BOTMUX_MAIN_TOPIC_CHAT_ID = 'oc_envroot';
      cfg.syncRootChatIdFromConfig();
      expect(topo.readTopology().rootChatId).toBe('oc_envroot');
    });
    it('setRootChatId is idempotent (no-op when value unchanged)', async () => {
      const { cfg, topo } = await freshImport();
      cfg.setMainTopicChatId('oc_x');
      const t1 = topo.readTopology();
      cfg.setMainTopicChatId('oc_x');                     // same value
      const t2 = topo.readTopology();
      // updatedAt should NOT bump because setRootChatId returns early
      expect(t2.updatedAt).toBe(t1.updatedAt);
    });
  });

  describe('CFG-5 — isTillyMainTopicConversationDenied', () => {
    it('returns true only for coco in configured mainTopic', async () => {
      const { cfg } = await freshImport();
      cfg.setMainTopicChatId('oc_main');
      expect(cfg.isTillyMainTopicConversationDenied('coco', 'oc_main')).toBe(true);
      expect(cfg.isTillyMainTopicConversationDenied('claude-code', 'oc_main')).toBe(false);
      expect(cfg.isTillyMainTopicConversationDenied('coco', 'oc_other')).toBe(false);
    });

    it('escape hatch env disables the denial', async () => {
      const { cfg } = await freshImport();
      cfg.setMainTopicChatId('oc_main');
      process.env.BOTMUX_TILLY_ALLOW_MAIN_TOPIC_CHAT = '1';
      expect(cfg.isTillyMainTopicConversationDenied('coco', 'oc_main')).toBe(false);
      delete process.env.BOTMUX_TILLY_ALLOW_MAIN_TOPIC_CHAT;
    });
  });
});

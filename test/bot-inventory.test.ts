import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countBotsByCli, defaultBotsJsonPath, listBots, listBotsByCli } from '../src/services/bot-inventory.js';

const tmps: string[] = [];
function fixture(bots: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'bot-inv-'));
  tmps.push(dir);
  const p = join(dir, 'bots.json');
  writeFileSync(p, JSON.stringify(bots));
  return p;
}
afterEach(() => {
  while (tmps.length) {
    try { rmSync(tmps.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('bot-inventory', () => {
  it('listBots maps entries with index and defaults missing cliId to claude-code', () => {
    const p = fixture([
      { larkAppId: 'a', cliId: 'claude-code', name: 'main' },
      { larkAppId: 'b', cliId: 'codex' },
      { larkAppId: 'c' }, // missing cliId → claude-code
    ]);
    expect(listBots(p)).toEqual([
      { larkAppId: 'a', cliId: 'claude-code', name: 'main', index: 0 },
      { larkAppId: 'b', cliId: 'codex', name: undefined, index: 1 },
      { larkAppId: 'c', cliId: 'claude-code', name: undefined, index: 2 },
    ]);
  });

  it('listBotsByCli / countBotsByCli filter by cliId (clone-count use case)', () => {
    const p = fixture([
      { larkAppId: 'a', cliId: 'claude-code' },
      { larkAppId: 'b', cliId: 'codex' },
      { larkAppId: 'c', cliId: 'claude-code' },
      { larkAppId: 'd' }, // defaults to claude-code
    ]);
    expect(countBotsByCli('claude-code', p)).toBe(3);
    expect(countBotsByCli('codex', p)).toBe(1);
    expect(countBotsByCli('coco', p)).toBe(0);
    expect(listBotsByCli('claude-code', p).map(b => b.larkAppId)).toEqual(['a', 'c', 'd']);
  });

  it('missing bots.json → empty inventory (no throw)', () => {
    const missing = join(tmpdir(), 'definitely-absent-bots.json');
    expect(listBots(missing)).toEqual([]);
    expect(countBotsByCli('claude-code', missing)).toBe(0);
  });

  describe('defaultBotsJsonPath honours BOTS_CONFIG (matches bot-registry priority)', () => {
    const saved = process.env.BOTS_CONFIG;
    afterEach(() => {
      if (saved === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = saved;
    });

    it('BOTS_CONFIG env overrides the ~/.botmux default and is what the no-arg API reads', () => {
      const p = fixture([
        { larkAppId: 'a', cliId: 'claude-code' },
        { larkAppId: 'b', cliId: 'claude-code' },
        { larkAppId: 'c', cliId: 'codex' },
      ]);
      process.env.BOTS_CONFIG = p;
      // defaultBotsJsonPath resolves to the env path, and the no-arg helpers
      // therefore count the BOTS_CONFIG registry, not ~/.botmux/bots.json.
      expect(defaultBotsJsonPath()).toBe(p);
      expect(countBotsByCli('claude-code')).toBe(2);
      expect(listBotsByCli('codex').map(b => b.larkAppId)).toEqual(['c']);
    });

    it('falls back to ~/.botmux/bots.json when BOTS_CONFIG is unset/blank', () => {
      delete process.env.BOTS_CONFIG;
      expect(defaultBotsJsonPath()).toMatch(/\.botmux[/\\]bots\.json$/);
      process.env.BOTS_CONFIG = '   ';
      expect(defaultBotsJsonPath()).toMatch(/\.botmux[/\\]bots\.json$/);
    });
  });
});

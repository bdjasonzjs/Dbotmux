import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countBotsByCli, defaultBotsJsonPath, listAuthoritativeBots, listBots, listBotsByCli } from '../src/services/bot-inventory.js';

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
      { larkAppId: 'a', cliId: 'claude-code', name: 'main', displayName: 'Main Bot' },
      { larkAppId: 'b', cliId: 'codex' },
      { larkAppId: 'c' }, // missing cliId → claude-code
    ]);
    expect(listBots(p)).toEqual([
      { larkAppId: 'a', cliId: 'claude-code', name: 'main', displayName: 'Main Bot', index: 0 },
      { larkAppId: 'b', cliId: 'codex', name: undefined, displayName: undefined, index: 1 },
      { larkAppId: 'c', cliId: 'claude-code', name: undefined, displayName: undefined, index: 2 },
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

  it('listAuthoritativeBots merges configured bots with clone dirs and maps engine / pm2 status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot-inv-full-'));
    tmps.push(dir);
    const configDir = join(dir, 'botmux');
    const dataDir = join(configDir, 'data');
    const clonesDir = join(configDir, 'clones');
    mkdirSync(join(clonesDir, 'app_clone_registered', '.codex'), { recursive: true });
    mkdirSync(join(clonesDir, 'app_clone_dir_only', '.claude'), { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    const botsJsonPath = join(configDir, 'bots.json');
    writeFileSync(botsJsonPath, JSON.stringify([
      { larkAppId: 'app_main', cliId: 'claude-code' },
      {
        larkAppId: 'app_clone_registered',
        cliId: 'codex',
        name: 'codex-clone',
        displayName: '蔻黛克斯（初号机）',
        claudeConfigDir: join(clonesDir, 'app_clone_registered', '.codex'),
      },
    ]));
    writeFileSync(join(dataDir, 'bots-info.json'), JSON.stringify([
      { larkAppId: 'app_main', botOpenId: 'ou_main', botName: '克劳德', cliId: 'claude-code' },
      { larkAppId: 'app_clone_dir_only', botOpenId: 'ou_clone', botName: '克劳德初号机', cliId: 'claude-code' },
    ]));

    const rows = listAuthoritativeBots({
      botsJsonPath,
      configDir,
      dataDir,
      clonesDir,
      pm2Statuses: {
        'botmux-0': 'online',
        'botmux-codex-clone': 'stopped',
      },
    });

    expect(rows.map(r => r.larkAppId)).toEqual(['app_main', 'app_clone_registered', 'app_clone_dir_only']);
    expect(rows[0]).toMatchObject({
      larkAppId: 'app_main',
      cloneName: '克劳德',
      cliId: 'claude-code',
      engine: 'claude',
      isClone: false,
      pm2Name: 'botmux-0',
      pm2Status: 'online',
    });
    expect(rows[1]).toMatchObject({
      larkAppId: 'app_clone_registered',
      cloneName: '蔻黛克斯（初号机）',
      cliId: 'codex',
      engine: 'codex',
      source: 'configured',
      isClone: true,
      pm2Name: 'botmux-codex-clone',
      pm2Status: 'stopped',
    });
    expect(rows[2]).toMatchObject({
      larkAppId: 'app_clone_dir_only',
      cloneName: '克劳德初号机',
      cliId: 'claude-code',
      engine: 'claude',
      source: 'clone-dir',
      isClone: true,
      pm2Name: null,
      pm2Status: 'unknown',
      statusNote: 'clone_not_registered_in_bots_json',
    });
  });

  it('marks configured bot status unknown when PM2 status cannot be read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot-inv-pm2-fail-'));
    tmps.push(dir);
    const configDir = join(dir, 'botmux');
    const dataDir = join(configDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    const botsJsonPath = join(configDir, 'bots.json');
    writeFileSync(botsJsonPath, JSON.stringify([
      { larkAppId: 'app_main', cliId: 'claude-code' },
    ]));

    const rows = listAuthoritativeBots({
      botsJsonPath,
      configDir,
      dataDir,
      pm2Statuses: {},
      pm2StatusAvailable: false,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      larkAppId: 'app_main',
      pm2Name: 'botmux-0',
      pm2Status: 'unknown',
      statusNote: 'pm2_status_unavailable',
    });
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

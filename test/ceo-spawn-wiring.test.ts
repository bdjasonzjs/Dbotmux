import { describe, it, expect } from 'vitest';
import {
  resolveReady, activationApproved, parseSeats, resolveCeoOwner, hotRegisterClone, resolveAutoTarget,
  type ReadySnapshot, type ActivationApprovalCheck, type AutoTargetResolveDeps,
} from '../src/services/ceo-spawn-wiring.js';
import { parseCeoSpawnArgs } from '../src/cli/bot-clone.js';

const snap = (over: Partial<ReadySnapshot> = {}): ReadySnapshot => ({
  // index 0 = cli_main → pm2 app 'botmux-0'; index 1 = cli_clone → 'botmux-1'
  bots: [{ larkAppId: 'cli_main' }, { larkAppId: 'cli_clone' }],
  botsInfo: [{ larkAppId: 'cli_main', botOpenId: 'ou_main' }, { larkAppId: 'cli_clone', botOpenId: 'ou_clone' }],
  pidsByApp: { 'botmux-0': 100, 'botmux-1': 200 },
  pm2Name: 'botmux',
  ...over,
});

describe('resolveReady (design pt1: pm2 online AND open_id persisted)', () => {
  it('both present → ready, returns open_id', () => {
    expect(resolveReady('cli_clone', snap())).toBe('ou_clone');
  });

  it('pm2 online but NO open_id in bots-info → not ready', () => {
    expect(resolveReady('cli_clone', snap({
      botsInfo: [{ larkAppId: 'cli_clone', botOpenId: '' }],
    }))).toBeUndefined();
  });

  it('has open_id but pm2 app OFFLINE → not ready (stale file guard)', () => {
    expect(resolveReady('cli_clone', snap({
      pidsByApp: { 'botmux-0': 100 }, // botmux-1 missing → offline
    }))).toBeUndefined();
  });

  it('appId absent from bots.json → not ready', () => {
    expect(resolveReady('cli_ghost', snap())).toBeUndefined();
  });

  it('pid present but <=0 → not ready', () => {
    expect(resolveReady('cli_clone', snap({ pidsByApp: { 'botmux-1': 0 } }))).toBeUndefined();
  });
});

describe('activationApproved (design pt2: explicit owner-scope, not just a flag)', () => {
  const good = (): ActivationApprovalCheck => ({
    approvedAppId: 'cli_new', senderOpenId: 'ou_owner', ownerOpenId: 'ou_owner',
    callerAppId: 'cli_main', claudeAppId: 'cli_main', pendingAppId: 'cli_new', pendingIsClone: true,
  });

  it('all conditions satisfied → true', () => {
    expect(activationApproved(good())).toBe(true);
  });
  it('no approved appId → false', () => {
    expect(activationApproved({ ...good(), approvedAppId: undefined })).toBe(false);
  });
  it('sender is not the owner → false', () => {
    expect(activationApproved({ ...good(), senderOpenId: 'ou_intruder' })).toBe(false);
  });
  it('caller is not the main/CEO bot → false', () => {
    expect(activationApproved({ ...good(), callerAppId: 'cli_other' })).toBe(false);
  });
  it('approved appId != pending clone → false', () => {
    expect(activationApproved({ ...good(), approvedAppId: 'cli_someoneelse' })).toBe(false);
  });
  it('pending bot is not a clone → false', () => {
    expect(activationApproved({ ...good(), pendingIsClone: false })).toBe(false);
  });
  // blocker 2: no reliable sender (service passes undefined when lastCallerOpenId
  // is absent — no ownerOpenId fallback) → deploy gate must deny.
  it('sender undefined (unreliable caller) → false', () => {
    expect(activationApproved({ ...good(), senderOpenId: undefined })).toBe(false);
  });
});

describe('parseCeoSpawnArgs (CLI↔service field contract)', () => {
  // blocker 1: --activation-approved must map to the field ceoSpawn reads.
  it('--activation-approved <appId> → activationApprovedAppId (not auto-camelCased)', () => {
    const body = parseCeoSpawnArgs(['--goal', 'push X', '--activation-approved', 'cli_new']);
    expect(body.activationApprovedAppId).toBe('cli_new');
    expect(body.activationApproved).toBeUndefined();
  });
  it('--seats → array; --goal/--session-id passthrough', () => {
    const body = parseCeoSpawnArgs(['--goal', 'g', '--seats', 'auto:main,codex:collab', '--session-id', 's1']);
    expect(body.goal).toBe('g');
    expect(body.seats).toEqual(['auto:main', 'codex:collab']);
    expect(body.sessionId).toBe('s1');
  });
  it('--source-description passthroughs trusted clone description source', () => {
    const body = parseCeoSpawnArgs(['--goal', 'g', '--source-description', '本体描述']);
    expect(body.sourceDescription).toBe('本体描述');
  });
  it('missing value → throws', () => {
    expect(() => parseCeoSpawnArgs(['--goal'])).toThrow(/missing value/);
  });
});

describe('hotRegisterClone (round-3 追加: fail-closed clone-only register)', () => {
  const cloneCfg = { larkAppId: 'cli_new', claudeConfigDir: '/c/cli_new/.claude' };
  const bentiCfg = { larkAppId: 'cli_main' }; // 本体: no claudeConfigDir
  it('clone found → registerBot called, ok', () => {
    const registered: any[] = [];
    const r = hotRegisterClone('cli_new', { loadBotConfigs: () => [bentiCfg, cloneCfg], registerBot: (c) => registered.push(c) });
    expect(r.ok).toBe(true);
    expect(registered).toEqual([cloneCfg]);
  });
  it('appId not in bots.json → not_in_bots_json, registerBot NOT called', () => {
    let called = false;
    const r = hotRegisterClone('cli_ghost', { loadBotConfigs: () => [bentiCfg, cloneCfg], registerBot: () => { called = true; } });
    expect(r).toEqual({ ok: false, error: 'not_in_bots_json' });
    expect(called).toBe(false);
  });
  it('本体 (no claudeConfigDir) → not_a_clone, registerBot NOT called (never register 本体)', () => {
    let called = false;
    const r = hotRegisterClone('cli_main', { loadBotConfigs: () => [bentiCfg], registerBot: () => { called = true; } });
    expect(r).toEqual({ ok: false, error: 'not_a_clone' });
    expect(called).toBe(false);
  });
  it('registerBot throws → {ok:false} with error (caught, not propagated)', () => {
    const r = hotRegisterClone('cli_new', { loadBotConfigs: () => [cloneCfg], registerBot: () => { throw new Error('client init boom'); } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/client init boom/);
  });
});

describe('resolveCeoOwner (真机 owner-fix #1: allowedUsers ?? session owner)', () => {
  it('config owner present → use it (even if session owner differs)', () => {
    expect(resolveCeoOwner('ou_cfg', 'ou_sess')).toBe('ou_cfg');
  });
  it('config owner undefined (empty allowedUsers) → fall back to session owner', () => {
    expect(resolveCeoOwner(undefined, 'ou_sess')).toBe('ou_sess');
  });
  it('both undefined → undefined (gate fails closed)', () => {
    expect(resolveCeoOwner(undefined, undefined)).toBeUndefined();
  });
});

describe('resolveAutoTarget (Round-4 Blocker2: open_id-decoupled, priority appId>alias>name>cliId)', () => {
  const rad = (over: Partial<AutoTargetResolveDeps> = {}): AutoTargetResolveDeps => ({
    bots: [
      { larkAppId: 'cli_claude', cliId: 'claude-code' },
      { larkAppId: 'cli_codex', cliId: 'codex' },
      { larkAppId: 'cli_gem', cliId: 'gemini' },
      { larkAppId: 'cli_cxclone', cliId: 'codex', claudeConfigDir: '/c/cxclone' }, // a clone
    ],
    names: [{ larkAppId: 'cli_codex', botName: '寇黛克斯' }],
    aliasToCliId: { claude: 'claude-code', c: 'claude-code', codex: 'codex', k: 'codex', tilly: 'coco', t: 'coco' },
    ceoCliId: 'claude-code',
    ...over,
  });

  it('undefined → CEO engine 本体', () => {
    expect(resolveAutoTarget(undefined, rad())).toEqual({ cliId: 'claude-code', bentiAppId: 'cli_claude' });
  });
  it('exact appId resolves WITHOUT any open_id / names (Blocker2)', () => {
    expect(resolveAutoTarget('cli_codex', rad({ names: [] }))).toEqual({ cliId: 'codex', bentiAppId: 'cli_codex' });
  });
  it('built-in alias (k → codex)', () => {
    expect(resolveAutoTarget('k', rad())).toEqual({ cliId: 'codex', bentiAppId: 'cli_codex' });
  });
  it('botName match needs NO open_id (Blocker2)', () => {
    expect(resolveAutoTarget('寇黛克斯', rad())).toEqual({ cliId: 'codex', bentiAppId: 'cli_codex' });
  });
  it('raw cliId only when not appId/alias/name (gemini has no alias)', () => {
    expect(resolveAutoTarget('gemini', rad())).toEqual({ cliId: 'gemini', bentiAppId: 'cli_gem' });
  });
  it('case-insensitive + trim for alias/name/cliId', () => {
    expect(resolveAutoTarget('  Gemini ', rad())).toEqual({ cliId: 'gemini', bentiAppId: 'cli_gem' });
    expect(resolveAutoTarget('CODEX', rad())).toEqual({ cliId: 'codex', bentiAppId: 'cli_codex' });
  });
  it('本体 = non-clone of the cliId (skips the clone entry)', () => {
    // codex 本体 is cli_codex, never the cli_cxclone clone.
    expect(resolveAutoTarget('codex', rad()).bentiAppId).toBe('cli_codex');
  });
  it('unknown ref → error', () => {
    expect(resolveAutoTarget('nope', rad())).toEqual({ error: '未知的 bot/引擎 "nope"' });
  });
  it('cliId exists but only as a clone (no 本体) → error', () => {
    const r = resolveAutoTarget('codex', rad({ bots: [{ larkAppId: 'cli_cxclone', cliId: 'codex', claudeConfigDir: '/c/x' }] }));
    expect(r).toHaveProperty('error');
  });
});

describe('parseSeats (Round-4: bot-agnostic auto seats)', () => {
  it('auto:role / bare role → auto seat, default target (no autoTarget)', () => {
    expect(parseSeats(['auto:main', 'collab'])).toEqual([
      { auto: true, role: 'main' }, { auto: true, role: 'collab' },
    ]);
  });
  it('auto@<ref>:role → auto seat targeting a bot/engine', () => {
    expect(parseSeats(['auto@codex:collab', 'auto@缇蕾:observer'])).toEqual([
      { auto: true, autoTarget: 'codex', role: 'collab' },
      { auto: true, autoTarget: '缇蕾', role: 'observer' },
    ]);
  });
  it('<ref>:role → explicit already-registered bot (no clone)', () => {
    expect(parseSeats(['codex:main', '克隆2:observer'])).toEqual([
      { ref: 'codex', role: 'main' }, { ref: '克隆2', role: 'observer' },
    ]);
  });
  it('mixed auto + auto@ + explicit', () => {
    expect(parseSeats(['auto:main', 'auto@codex:collab', 'tilly:observer'])).toEqual([
      { auto: true, role: 'main' },
      { auto: true, autoTarget: 'codex', role: 'collab' },
      { ref: 'tilly', role: 'observer' },
    ]);
  });
  it('invalid role → throws', () => {
    expect(() => parseSeats(['auto:boss'])).toThrow(/invalid role/);
  });
  it('empty auto@ target → throws', () => {
    expect(() => parseSeats(['auto@:collab'])).toThrow(/auto@ requires a target/);
  });

  // ── 块8: optional 3rd segment = custom cloneName ──
  it('auto@<ref>:role:cloneName → auto seat with cloneName', () => {
    expect(parseSeats(['auto@codex:collab:评审甲'])).toEqual([
      { auto: true, autoTarget: 'codex', role: 'collab', cloneName: '评审甲' },
    ]);
  });
  it('auto:role:cloneName → default-target auto seat with cloneName', () => {
    expect(parseSeats(['auto:main:队长'])).toEqual([
      { auto: true, role: 'main', cloneName: '队长' },
    ]);
  });
  it('no 3rd segment → no cloneName key (zero regression)', () => {
    expect(parseSeats(['auto@codex:collab'])).toEqual([
      { auto: true, autoTarget: 'codex', role: 'collab' },
    ]);
  });
  it('cloneName on an explicit <ref> seat → throws (registered bots not renamable)', () => {
    expect(() => parseSeats(['codex:main:别名'])).toThrow(/custom name not allowed/);
  });
  it('invalid cloneName (too long) → throws at parse time', () => {
    expect(() => parseSeats(['auto@codex:collab:' + 'x'.repeat(21)])).toThrow(/invalid clone name/);
  });
  it('cloneName ending in（…号机）→ throws (namespace guard)', () => {
    expect(() => parseSeats(['auto@codex:collab:克劳德（初号机）'])).toThrow(/invalid clone name/);
  });
});

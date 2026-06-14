import { describe, it, expect } from 'vitest';
import {
  resolveReady, activationApproved, parseSeats, resolveCeoOwner, hotRegisterClone,
  type ReadySnapshot, type ActivationApprovalCheck,
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

describe('parseSeats', () => {
  it('auto:role → claude-auto (ref-less)', () => {
    expect(parseSeats(['auto:main', 'auto:collab'])).toEqual([{ role: 'main' }, { role: 'collab' }]);
  });
  it('bare role → claude-auto (ref-less)', () => {
    expect(parseSeats(['main', 'collab'])).toEqual([{ role: 'main' }, { role: 'collab' }]);
  });
  it('ref:role → specific bot', () => {
    expect(parseSeats(['codex:collab', '克隆2:observer'])).toEqual([
      { ref: 'codex', role: 'collab' }, { ref: '克隆2', role: 'observer' },
    ]);
  });
  it('mixed auto + specific', () => {
    expect(parseSeats(['auto:main', 'codex:collab'])).toEqual([
      { role: 'main' }, { ref: 'codex', role: 'collab' },
    ]);
  });
  it('invalid role → throws', () => {
    expect(() => parseSeats(['auto:boss'])).toThrow(/invalid role/);
  });
});

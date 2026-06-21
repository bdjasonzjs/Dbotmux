import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/config.js', () => ({ config: { get session() { return { dataDir: '/tmp/tt-onboard' }; } } }));
vi.mock('../src/utils/logger.js', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }));

import { planOnboarding, runOnboarding } from '../src/services/taskteam-onboard.js';
import type { OnboardingDeps } from '../src/services/taskteam-onboard.js';
import type { TaskTeamConfigFile, TaskTeamInstance } from '../src/services/taskteam-schema.js';

const emptyConfig = { version: 1, roles: [], rules: [], teamTypes: [], orgStructures: [], orgRuntimeBindings: [], updatedAt: 't' } as TaskTeamConfigFile;

describe('planOnboarding (§9 onboarding skeleton + bot gap)', () => {
  it('uses seed two-layer type; enough bots → ready, all seats assigned, short 0', () => {
    const bots = [
      { larkAppId: 'cli_dev', botName: 'claude', botOpenId: 'ou_dev' },
      { larkAppId: 'cli_arch', botName: 'claude2', botOpenId: 'ou_arch' },
      { larkAppId: 'cli_det', botName: 'codex', botOpenId: 'ou_det' },
      { larkAppId: 'cli_obs', botName: 'coco', botOpenId: 'ou_obs' },
    ];
    const plan = planOnboarding({ config: emptyConfig, availableBots: bots });
    expect(plan.seats.length).toBe(4); // developer / architect / detail / observer
    expect(plan.ready).toBe(true);
    expect(plan.botGap).toEqual({ needed: 4, available: 4, short: 0 });
    expect(plan.seats.every(s => !!s.assignedBot)).toBe(true);
    expect(plan.companyName).toBe('一人公司');
  });

  it('short bots → not ready, gap reports 已X还差Y', () => {
    const plan = planOnboarding({ config: emptyConfig, availableBots: [{ larkAppId: 'cli_1', botName: 'claude', botOpenId: 'ou_1' }] });
    expect(plan.ready).toBe(false);
    expect(plan.botGap).toMatchObject({ needed: 4, available: 1, short: 3 });
    expect(plan.steps.find(s => s.id === 'bot-gap')?.label).toContain('还差 3');
    expect(plan.steps.find(s => s.id === 'sample-team')?.status).toBe('needs-bots');
  });

  it('observer seat gets a cheap-engine bot regardless of position', () => {
    const bots = [
      { larkAppId: 'cli_cheap', botName: 'coco-tilly', botOpenId: 'ou_cheap' }, // cheap engine, intentionally first
      { larkAppId: 'cli_a', botName: 'claude', botOpenId: 'ou_a' },
      { larkAppId: 'cli_b', botName: 'claude2', botOpenId: 'ou_b' },
      { larkAppId: 'cli_c', botName: 'codex', botOpenId: 'ou_c' },
    ];
    const plan = planOnboarding({ config: emptyConfig, availableBots: bots });
    const obs = plan.seats.find(s => s.observer);
    expect(obs?.assignedBot?.botName).toBe('coco-tilly');
    // 非 observer 席不会拿到便宜 bot
    expect(plan.seats.filter(s => !s.observer).every(s => s.assignedBot?.botName !== 'coco-tilly')).toBe(true);
  });

  it('malformed bots (missing larkAppId/botOpenId) are not counted usable → not ready (P1)', () => {
    const plan = planOnboarding({ config: emptyConfig, availableBots: [1, 2, 3, 4].map(i => ({ botName: `b${i}` })) as never });
    expect(plan.ready).toBe(false);
    expect(plan.botGap).toMatchObject({ needed: 4, available: 0, short: 4 });
  });
});

describe('runOnboarding bot-identity boundary (P1)', () => {
  const baseDeps = (createSampleTeam: OnboardingDeps['createSampleTeam']): OnboardingDeps => ({
    ensureSeed: async () => {},
    getConfig: () => emptyConfig,
    createSampleTeam,
  });
  const usableBots = [
    { larkAppId: 'cli_d', botName: 'claude', botOpenId: 'ou_d' },
    { larkAppId: 'cli_a', botName: 'claude2', botOpenId: 'ou_a' },
    { larkAppId: 'cli_de', botName: 'codex', botOpenId: 'ou_de' },
    { larkAppId: 'cli_o', botName: 'coco', botOpenId: 'ou_o' },
  ];

  it('enough count but malformed bots → does NOT call createSampleTeam', async () => {
    let calls = 0;
    const deps = baseDeps(async () => { calls += 1; return {} as TaskTeamInstance; });
    const bad = [1, 2, 3, 4].map(i => ({ botName: `b${i}` })) as never; // 缺 larkAppId/botOpenId
    const res = await runOnboarding(deps, { availableBots: bad, creatorLarkAppId: 'cli_creator' });
    expect(res.plan.ready).toBe(false);
    expect(res.created).toBeNull();
    expect(calls).toBe(0);
    expect(res.plan.botGap.short).toBe(4);
  });

  it('missing botOpenId is not substituted by larkAppId — bot不可用、计入缺口', async () => {
    let calls = 0;
    const deps = baseDeps(async () => { calls += 1; return {} as TaskTeamInstance; });
    // 4 个 bot 但都缺 botOpenId（只有 larkAppId+botName）
    const noOpenId = usableBots.map(b => ({ larkAppId: b.larkAppId, botName: b.botName })) as never;
    const res = await runOnboarding(deps, { availableBots: noOpenId, creatorLarkAppId: 'cli_creator' });
    expect(res.plan.ready).toBe(false);
    expect(res.created).toBeNull();
    expect(calls).toBe(0);
  });

  it('usable bots → creates sample team with real botOpenId (no cli_* substitution)', async () => {
    let captured: { roleInstances: TaskTeamInstance['roleInstances'] } | null = null;
    const deps = baseDeps(async params => { captured = params; return { teamId: 'tt_team_x' } as TaskTeamInstance; });
    const res = await runOnboarding(deps, { availableBots: usableBots, creatorLarkAppId: 'cli_creator' });
    expect(res.created).not.toBeNull();
    expect(captured!.roleInstances.every(ri => ri.binding!.botOpenId.startsWith('ou_'))).toBe(true);
    expect(captured!.roleInstances.some(ri => ri.binding!.botOpenId.startsWith('cli_'))).toBe(false);
  });
});

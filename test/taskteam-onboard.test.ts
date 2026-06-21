import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/config.js', () => ({ config: { get session() { return { dataDir: '/tmp/tt-onboard' }; } } }));
vi.mock('../src/utils/logger.js', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }));

import { planOnboarding } from '../src/services/taskteam-onboard.js';
import type { TaskTeamConfigFile } from '../src/services/taskteam-schema.js';

const emptyConfig = { version: 1, roles: [], rules: [], teamTypes: [], orgStructures: [], orgRuntimeBindings: [], updatedAt: 't' } as TaskTeamConfigFile;

describe('planOnboarding (§9 onboarding skeleton + bot gap)', () => {
  it('uses seed two-layer type; enough bots → ready, all seats assigned, short 0', () => {
    const bots = [
      { larkAppId: 'cli_dev', botName: 'claude' },
      { larkAppId: 'cli_arch', botName: 'claude2' },
      { larkAppId: 'cli_det', botName: 'codex' },
      { larkAppId: 'cli_obs', botName: 'coco' },
    ];
    const plan = planOnboarding({ config: emptyConfig, availableBots: bots });
    expect(plan.seats.length).toBe(4); // developer / architect / detail / observer
    expect(plan.ready).toBe(true);
    expect(plan.botGap).toEqual({ needed: 4, available: 4, short: 0 });
    expect(plan.seats.every(s => !!s.assignedBot)).toBe(true);
    expect(plan.companyName).toBe('一人公司');
  });

  it('short bots → not ready, gap reports 已X还差Y', () => {
    const plan = planOnboarding({ config: emptyConfig, availableBots: [{ larkAppId: 'cli_1', botName: 'claude' }] });
    expect(plan.ready).toBe(false);
    expect(plan.botGap).toMatchObject({ needed: 4, available: 1, short: 3 });
    expect(plan.steps.find(s => s.id === 'bot-gap')?.label).toContain('还差 3');
    expect(plan.steps.find(s => s.id === 'sample-team')?.status).toBe('needs-bots');
  });

  it('observer seat gets a cheap-engine bot regardless of position', () => {
    const bots = [
      { larkAppId: 'cli_cheap', botName: 'coco-tilly' }, // cheap engine, intentionally first
      { larkAppId: 'cli_a', botName: 'claude' },
      { larkAppId: 'cli_b', botName: 'claude2' },
      { larkAppId: 'cli_c', botName: 'codex' },
    ];
    const plan = planOnboarding({ config: emptyConfig, availableBots: bots });
    const obs = plan.seats.find(s => s.observer);
    expect(obs?.assignedBot?.botName).toBe('coco-tilly');
    // 非 observer 席不会拿到便宜 bot
    expect(plan.seats.filter(s => !s.observer).every(s => s.assignedBot?.botName !== 'coco-tilly')).toBe(true);
  });
});

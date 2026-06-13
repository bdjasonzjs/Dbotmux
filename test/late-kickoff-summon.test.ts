import { describe, it, expect } from 'vitest';
import { parentToChildSummon } from '../src/services/outbox-dispatcher-executors.js';

// Minimal task: main(本体) + a late-joined clone collab.
const task: any = {
  taskId: 'st_1', goal: 'push X', acceptance: null, spawnable: false,
  bots: [
    { openId: 'ou_main', name: '克劳德', role: 'main' },
    { openId: 'ou_new', name: '克劳德（初号机）', role: 'collab', larkAppId: 'cli_new' },
  ],
};
const kickoff = (payload: any = {}): any => ({ commandType: 'kickoff', payload });
const summonNames = (s: string): string => s.match(/【([^】]+)】/)![1];

describe('late-kickoff targeted summon (#5 blocker3: only the clone, never main)', () => {
  it('targetSummonName → summon names ONLY that clone', () => {
    const s = parentToChildSummon(kickoff({ targetSummonName: '克劳德（初号机）' }), task);
    expect(summonNames(s)).toBe('克劳德（初号机）'); // not 克劳德 (main)
  });

  it('plain kickoff (no targetSummonName) still wakes main only — no regression', () => {
    const s = parentToChildSummon(kickoff(), task);
    expect(summonNames(s)).toBe('克劳德');
  });
});

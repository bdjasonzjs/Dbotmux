import { describe, expect, it } from 'vitest';
import { buildManagerRecoverPrompt, planManagerAutoRecover } from '../src/services/manager-auto-recover.js';

describe('manager auto recover decision', () => {
  const now = new Date('2026-06-25T00:00:00Z');

  it('默认 opt-in 关闭 → 不 recover', () => {
    expect(planManagerAutoRecover({ optIn: false, doubleCheck: true, sessionId: 's1', now }))
      .toEqual({ kind: 'none', reason: 'opt_in_disabled' });
  });

  it('double-check 未通过 → 不 recover，防误杀', () => {
    expect(planManagerAutoRecover({ optIn: true, doubleCheck: false, sessionId: 's1', now }))
      .toEqual({ kind: 'none', reason: 'double_check_failed' });
  });

  it('找不到 active session → 不 recover', () => {
    expect(planManagerAutoRecover({ optIn: true, doubleCheck: true, sessionId: null, now }))
      .toEqual({ kind: 'none', reason: 'no_session' });
  });

  it('cooldown 内 → 不重复 recover', () => {
    expect(planManagerAutoRecover({
      optIn: true,
      doubleCheck: true,
      sessionId: 's1',
      lastRecoveredAt: '2026-06-24T23:45:00Z',
      now,
      cooldownMs: 30 * 60_000,
    })).toEqual({ kind: 'none', reason: 'cooldown' });
  });

  it('opt-in + double-check + cooldown 外 → recover', () => {
    expect(planManagerAutoRecover({
      optIn: true,
      doubleCheck: true,
      sessionId: 's1',
      lastRecoveredAt: '2026-06-24T23:00:00Z',
      now,
      cooldownMs: 30 * 60_000,
      recoverId: 'rid-1',
    })).toEqual({ kind: 'recover', recoverId: 'rid-1' });
  });

  it('recover prompt 带唯一 recoverId 和旧 session id', () => {
    const prompt = buildManagerRecoverPrompt({
      task: { taskId: 'st_1', goal: '修复', acceptance: null, status: 'observing' } as any,
      session: { sessionId: 'old_session' },
      reason: 'manager_session_aged',
      recoverId: 'rid-2',
    });
    expect(prompt).toContain('rid-2');
    expect(prompt).toContain('old_session');
    expect(prompt).toContain('继续处理当前 pending work');
  });
});

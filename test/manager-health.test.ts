/**
 * Unit tests for planManagerHealth — 经理卡死检测（与 stall-nudge 互补）。
 * 经理被 paused/reported_help 卡死躺尸超阈值 → escalate_ceo（上浮告警，默认不自动 resume）。
 * Run: pnpm vitest run test/manager-health.test.ts
 */
import { describe, it, expect } from 'vitest';
import { planManagerHealth, MANAGER_STALL_MS } from '../src/services/subtask-observer.js';
import type { SubTask } from '../src/services/subtask-store.js';

const now = new Date('2026-06-24T10:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
// 轻量构造：只填 planManagerHealth 用到的字段（reportingMode/status/updatedAt），其余 cast 掉。
const mk = (over: Partial<SubTask>): SubTask =>
  ({ reportingMode: 'manager', status: 'paused', updatedAt: ago(3 * 3600_000), ...over } as SubTask);

describe('planManagerHealth — 经理卡死检测', () => {
  it('manager + paused + 超期 3h → escalate_ceo', () => {
    const a = planManagerHealth(mk({}), now);
    expect(a.kind).toBe('escalate_ceo');
    if (a.kind === 'escalate_ceo') expect(a.stalledMs).toBeGreaterThan(MANAGER_STALL_MS);
  });

  it('manager + reported_help + 超期 3h → escalate_ceo', () => {
    expect(planManagerHealth(mk({ status: 'reported_help' }), now).kind).toBe('escalate_ceo');
  });

  it('manager + paused + 未超期 1h → none', () => {
    expect(planManagerHealth(mk({ updatedAt: ago(3600_000) }), now).kind).toBe('none');
  });

  it('manager + observing（活跃态，非卡死）→ none', () => {
    expect(planManagerHealth(mk({ status: 'observing' }), now).kind).toBe('none');
  });

  it('manager + reported_done（终态）→ none', () => {
    expect(planManagerHealth(mk({ status: 'reported_done' }), now).kind).toBe('none');
  });

  it('executor + paused + 超期 → none（非 manager，归 stall-nudge 管）', () => {
    expect(planManagerHealth(mk({ reportingMode: 'executor' }), now).kind).toBe('none');
  });

  it('updatedAt 脏 → none（保守，不误判）', () => {
    expect(planManagerHealth(mk({ updatedAt: 'not-a-date' }), now).kind).toBe('none');
  });

  it('边界：恰超阈值 → escalate_ceo；恰未到 → none', () => {
    expect(planManagerHealth(mk({ updatedAt: ago(MANAGER_STALL_MS + 1000) }), now).kind).toBe('escalate_ceo');
    expect(planManagerHealth(mk({ updatedAt: ago(MANAGER_STALL_MS - 1000) }), now).kind).toBe('none');
  });
});

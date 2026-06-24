/**
 * 停滞节流公共 util 单测（drive 与 subtask-observer 共用）。
 * Run: pnpm vitest run test/stall-throttle.test.ts
 */
import { describe, it, expect } from 'vitest';
import { episodeAnchorMs, effectiveNudgeCount, planStall } from '../src/services/stall-throttle.js';

const T0 = new Date('2026-06-24T10:00:00Z').getTime();
const iso = (ms: number) => new Date(ms).toISOString();

describe('episodeAnchorMs', () => {
  it('取三者最大；全脏 → NaN', () => {
    expect(episodeAnchorMs({ activityAt: iso(T0), createdAt: iso(T0 - 1000) })).toBe(T0);
    expect(Number.isNaN(episodeAnchorMs({}))).toBe(true);
  });
});

describe('effectiveNudgeCount', () => {
  it('上次催早于 anchor（新窗口）→ 0；不早于 → 累计值', () => {
    expect(effectiveNudgeCount(iso(T0 - 1000), 3, T0)).toBe(0); // 早于 anchor
    expect(effectiveNudgeCount(iso(T0 + 1000), 3, T0)).toBe(3); // 晚于 anchor
  });
});

describe('planStall', () => {
  const base = { lastNudgeAt: null, nudgeCount: 0, stallMs: 30 * 60_000, maxNudges: 3 };
  it('没卡够久 → none', () => {
    const d = planStall({ ...base, anchorMs: T0, now: new Date(T0 + 10 * 60_000) });
    expect(d.kind).toBe('none');
  });
  it('卡够久 + 没催过 → nudge', () => {
    const d = planStall({ ...base, anchorMs: T0, now: new Date(T0 + 40 * 60_000) });
    expect(d.kind).toBe('nudge');
  });
  it('本窗口已催满 MAX → capped', () => {
    const d = planStall({ anchorMs: T0, lastNudgeAt: iso(T0 + 35 * 60_000), nudgeCount: 3, now: new Date(T0 + 70 * 60_000), stallMs: 30 * 60_000, maxNudges: 3 });
    expect(d.kind).toBe('capped');
  });
  it('anchor 脏 → none', () => {
    const d = planStall({ ...base, anchorMs: NaN, now: new Date(T0) });
    expect(d.kind).toBe('none');
  });
  it('上次催后冷却未过 → none', () => {
    const d = planStall({ anchorMs: T0, lastNudgeAt: iso(T0 + 40 * 60_000), nudgeCount: 1, now: new Date(T0 + 50 * 60_000), stallMs: 30 * 60_000, maxNudges: 3 });
    expect(d.kind).toBe('none'); // 距上次催只 10min < 30min
  });
});

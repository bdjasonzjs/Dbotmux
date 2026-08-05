/**
 * 病一回归 (2026-08-05): 缇蕾扫读高水位冻结的死亡螺旋。
 *
 * 真实故障: 高水位 (lastFetchEnd) 只在"成功且未 cap-hit"时推进 → 消息量长期
 * 高于 100/轮分析上限时持续 cap-hit → 高水位永久冻结 (实测冻在 2026-07-15、
 * 连挂 19 天) → 窗口 [冻结点, now] 一天天变宽 → lark-cli --page-all 翻页量无界
 * 增长直到越过 60s 超时, 每轮抛错。
 *
 * 修复把两段逻辑抽成纯函数, 这里直接构造冻结场景断言:
 *  - computeTillyWindow: 无论高水位多老, 窗口宽度永远 ≤ maxWindowMs。
 *  - nextWatermarkOnCapHit: cap-hit 时高水位绝不再冻结, 至少推进到 now-maxWindowMs。
 *
 * Run:  pnpm vitest run test/tilly-window-freeze.test.ts
 */
import { describe, it, expect } from 'vitest';
import { computeTillyWindow, nextWatermarkOnCapHit } from '../src/services/tilly-message-store.js';

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const OPTS = { maxWindowMs: 6 * HOUR, overlapMs: 5 * MIN, intervalMs: 15 * MIN };
const NOW = new Date('2026-08-03T12:00:00.000Z');

describe('病一 · computeTillyWindow 窗口硬上界', () => {
  it('高水位冻结在 19 天前 → 窗口被钳到 6h、clamped=true', () => {
    const frozen = new Date('2026-07-15T08:20:51.000Z'); // 实测冻结点
    const w = computeTillyWindow(frozen, NOW, OPTS);
    expect(w.clamped).toBe(true);
    // 窗口宽度恰为 6h (不是 19 天)
    expect(w.end.getTime() - w.start.getTime()).toBe(6 * HOUR);
    expect(w.start.getTime()).toBe(NOW.getTime() - 6 * HOUR);
  });

  it('正常量: 高水位在 10min 前 → 不钳, start = 高水位 - overlap', () => {
    const recent = new Date(NOW.getTime() - 10 * MIN);
    const w = computeTillyWindow(recent, NOW, OPTS);
    expect(w.clamped).toBe(false);
    expect(w.start.getTime()).toBe(recent.getTime() - OPTS.overlapMs);
  });

  it('首轮: 高水位 null → 回退 now - interval, 不钳', () => {
    const w = computeTillyWindow(null, NOW, OPTS);
    expect(w.clamped).toBe(false);
    expect(w.start.getTime()).toBe(NOW.getTime() - OPTS.intervalMs);
  });

  it('边界: 高水位恰在 6h+overlap 前 → 窗口刚好不超过 6h', () => {
    const edge = new Date(NOW.getTime() - (6 * HOUR - OPTS.overlapMs));
    const w = computeTillyWindow(edge, NOW, OPTS);
    expect(w.end.getTime() - w.start.getTime()).toBeLessThanOrEqual(6 * HOUR);
  });
});

describe('病一 · nextWatermarkOnCapHit 高水位防冻结', () => {
  it('冻结场景: 高水位在 19 天前, cap-hit → 推进到 now-6h (解冻)', () => {
    const frozen = new Date('2026-07-15T08:20:51.000Z');
    const next = nextWatermarkOnCapHit(frozen, NOW, OPTS.maxWindowMs);
    expect(next.getTime()).toBe(NOW.getTime() - 6 * HOUR);
    expect(next.getTime()).toBeGreaterThan(frozen.getTime()); // 一定前进了
  });

  it('正常量: 高水位在 10min 前, cap-hit → 维持原值 (下轮补扫同窗口)', () => {
    const recent = new Date(NOW.getTime() - 10 * MIN);
    const next = nextWatermarkOnCapHit(recent, NOW, OPTS.maxWindowMs);
    expect(next.getTime()).toBe(recent.getTime());
  });

  it('高水位 null, cap-hit → 落到地板 now-6h', () => {
    const next = nextWatermarkOnCapHit(null, NOW, OPTS.maxWindowMs);
    expect(next.getTime()).toBe(NOW.getTime() - 6 * HOUR);
  });
});

describe('病一 · 死亡螺旋不再发生 (多轮迭代)', () => {
  it('从冻结态出发, 每轮都 cap-hit, 窗口宽度始终 ≤ 6h、高水位单调追上 now', () => {
    // 模拟: 初始高水位冻在很久以前, 之后每 15min 一个 tick 且每轮都 cap-hit。
    // 旧逻辑下窗口会一路涨到 19 天; 新逻辑下必须恒 ≤ 6h。
    let watermark: Date | null = new Date('2026-07-15T08:20:51.000Z');
    let clock = NOW.getTime();
    let maxWindowSeen = 0;
    for (let i = 0; i < 100; i++) {
      const end = new Date(clock);
      const w = computeTillyWindow(watermark, end, OPTS);
      maxWindowSeen = Math.max(maxWindowSeen, w.end.getTime() - w.start.getTime());
      // 每轮 cap-hit → 推进高水位
      watermark = nextWatermarkOnCapHit(watermark, end, OPTS.maxWindowMs);
      // 高水位距 now 的滞后永远 ≤ 6h (追上并锁定)
      expect(end.getTime() - watermark.getTime()).toBeLessThanOrEqual(6 * HOUR);
      clock += 15 * MIN;
    }
    // 关键断言: 窗口宽度全程 ≤ 6h, 死亡螺旋 (窗口无界增长) 不再发生
    expect(maxWindowSeen).toBeLessThanOrEqual(6 * HOUR);
  });
});

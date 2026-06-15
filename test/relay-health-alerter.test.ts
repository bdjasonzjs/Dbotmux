/**
 * Unit tests for RelayHealthAlerter (two-track: write-channel death + confirmation breakage).
 * Run: pnpm vitest run test/relay-health-alerter.test.ts
 */
import { describe, it, expect } from 'vitest';

import { RelayHealthAlerter } from '../src/services/relay-health-alerter.js';

const COOLDOWN = 30 * 60 * 1000;
const cfg = {
  token: { threshold: 2, cooldownMs: COOLDOWN },
  confirmation: { threshold: 3, cooldownMs: COOLDOWN },
};
const idle = { enqueueFailures: 0, written: 0, confirmFailures: 0, confirmed: 0 };
const writeDeadTick = { enqueueFailures: 1, written: 0, confirmFailures: 0, confirmed: 0 };   // 写不进 record
const confirmStallTick = { enqueueFailures: 0, written: 0, confirmFailures: 2, confirmed: 0 }; // 写了读不到「已发送」
const healthyTick = { enqueueFailures: 0, written: 0, confirmFailures: 0, confirmed: 2 };      // 确认送达

describe('RelayHealthAlerter — token (write-channel) track', () => {
  it('alerts after threshold consecutive write-failure ticks', () => {
    const a = new RelayHealthAlerter(cfg);
    expect(a.noteTick(writeDeadTick, 0).tokenAlert).toBe(false);
    expect(a.noteTick(writeDeadTick, 1000).tokenAlert).toBe(true);
  });

  it('writing a record (written>0) or a confirmation resets token track', () => {
    const a = new RelayHealthAlerter(cfg);
    a.noteTick(writeDeadTick, 0);
    const writeOkTick = { enqueueFailures: 0, written: 2, confirmFailures: 0, confirmed: 0 };
    expect(a.noteTick(writeOkTick, 1000).tokenConsecutive).toBe(0); // 写进 record → 写入通道健康 → 清零
    expect(a.noteTick(writeDeadTick, 2000).tokenAlert).toBe(false); // 需重新累计
  });

  it('a confirm-stall tick (written:0) neither increments nor resets token track', () => {
    const a = new RelayHealthAlerter(cfg);
    a.noteTick(writeDeadTick, 0);                       // token consecutive = 1
    expect(a.noteTick(confirmStallTick, 1000).tokenConsecutive).toBe(1); // 既不增也不清
  });

  it('idle ticks do not increment token track', () => {
    const a = new RelayHealthAlerter(cfg);
    a.noteTick(writeDeadTick, 0);
    a.noteTick(idle, 100);
    expect(a.tokenConsecutive).toBe(1);
  });

  it('cooldown advances only on commit; a FAILED send (no commit) keeps retrying next tick (P1)', () => {
    const a = new RelayHealthAlerter(cfg);
    a.noteTick(writeDeadTick, 0);
    expect(a.noteTick(writeDeadTick, 1000).tokenAlert).toBe(true);   // decision true...
    // simulate send FAILED → do NOT commit → next tick must alert again (not silenced 30min)
    expect(a.noteTick(writeDeadTick, 2000).tokenAlert).toBe(true);
    expect(a.noteTick(writeDeadTick, 3000).tokenAlert).toBe(true);
    // now send succeeds → commit → within cooldown is suppressed, past cooldown re-alerts
    a.commitTokenAlert(3000);
    expect(a.noteTick(writeDeadTick, 3000 + COOLDOWN - 1).tokenAlert).toBe(false);
    expect(a.noteTick(writeDeadTick, 3000 + COOLDOWN + 1).tokenAlert).toBe(true);
  });
});

describe('RelayHealthAlerter — confirmation track (the §10 catcher)', () => {
  it('alerts after threshold consecutive write-but-unconfirmed ticks', () => {
    const a = new RelayHealthAlerter(cfg);
    expect(a.noteTick(confirmStallTick, 0).confirmationAlert).toBe(false);
    expect(a.noteTick(confirmStallTick, 1000).confirmationAlert).toBe(false);
    expect(a.noteTick(confirmStallTick, 2000).confirmationAlert).toBe(true);
  });

  it('any confirmation resets confirmation track', () => {
    const a = new RelayHealthAlerter(cfg);
    a.noteTick(confirmStallTick, 0);
    a.noteTick(confirmStallTick, 1000);
    expect(a.noteTick(healthyTick, 2000).confirmationConsecutive).toBe(0);
  });
});

describe('RelayHealthAlerter — two tracks orthogonal', () => {
  it('write-channel death does NOT trigger confirmation alert (no record written → no confirmFailures)', () => {
    const a = new RelayHealthAlerter(cfg);
    for (let i = 0; i < 6; i++) expect(a.noteTick(writeDeadTick, i * 1000).confirmationAlert).toBe(false);
    expect(a.confirmationConsecutive).toBe(0);
  });

  it('confirmation breakage does NOT trigger token alert (records written keep token track reset)', () => {
    const a = new RelayHealthAlerter(cfg);
    for (let i = 0; i < 6; i++) expect(a.noteTick(confirmStallTick, i * 1000).tokenAlert).toBe(false);
    expect(a.tokenConsecutive).toBe(0);
  });
});

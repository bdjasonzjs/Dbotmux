/**
 * streaming-identity-snapshot.test.ts
 *
 * 直接调用 getDaemonStreamingCardUsageSnapshot()（默认 streaming 主路径，不是
 * 提前返回），验证 Claude 系会话的卡片 identity 三态确实随最终 snapshot 返回，
 * 并把真实 snapshot 喂给 buildStreamingCard() 看渲染；非 Claude 会话 legacy 对
 * 行为不变。2026-09-05 缺陷回修 review P1-1：此前只在非 streaming 提前返回里
 * spread 了 identity，主路径既压掉 legacy 又不带 identity，卡片整行空白。
 */
import { describe, expect, it } from 'vitest';
import { getDaemonStreamingCardUsageSnapshot } from '../src/core/worker-pool.js';
import { buildStreamingCard } from '../src/im/lark/card-builder.js';
import { readProcessStartIdentity } from '../src/core/session-marker.js';
import type { LaunchAttestation } from '../src/utils/launch-attestation.js';

const liveStart = readProcessStartIdentity(process.pid)!;

function attestation(over: Partial<LaunchAttestation> = {}): LaunchAttestation {
  return {
    model: 'claude-fable-5-1[1m]',
    effort: 'high',
    effortProvenance: 'default',
    effortConfigRoot: '/home/u/.claude',
    effortSourcePath: '/home/u/.claude/settings.json',
    cliPid: process.pid,
    cliProcStart: liveStart,
    workerGeneration: 1,
    leafArgvDigest: 'd',
    committedAt: '2026-09-05T00:00:00.000Z',
    ...over,
  };
}

/** Minimal DaemonSession: no runtime config (→ default 'streaming'), no
 *  transcript (→ empty usage), registry plan value deliberately set so a
 *  regression back to session.model would be visible. */
function ds(over: Record<string, unknown>): any {
  return {
    larkAppId: 'cli_test_streaming_identity',
    session: { sessionId: 's1', cliId: 'claude-code', model: 'claude-opus-5', ...over },
  };
}

const streaming = (d: any, cliId: any = 'claude-code') =>
  JSON.stringify(JSON.parse(buildStreamingCard('s1', 'om_r', 'https://t/x', 'title', 'body', 'working', cliId,
    'hidden', undefined, undefined, false, false, undefined, undefined, undefined, false,
    getDaemonStreamingCardUsageSnapshot(d, cliId))));

describe('getDaemonStreamingCardUsageSnapshot · Claude identity on the default streaming path', () => {
  it('verified → identity.state=verified with model + effortProvenance=default; legacy pair suppressed', () => {
    const snap = getDaemonStreamingCardUsageSnapshot(ds({ launchAttestation: attestation() }), 'claude-code');
    expect(snap.identity).toMatchObject({ state: 'verified', model: 'claude-fable-5-1[1m]', effort: 'high', effortProvenance: 'default' });
    expect(snap.model).toBeUndefined();
    expect(snap.reasoningEffort).toBeUndefined();
  });
  it('cli-default (attested, no --model) → identity.state=cli-default, still carries effort', () => {
    const snap = getDaemonStreamingCardUsageSnapshot(ds({ launchAttestation: attestation({ model: null }) }), 'claude-code');
    expect(snap.identity).toMatchObject({ state: 'cli-default', effort: 'high', effortProvenance: 'default' });
    expect(snap.model).toBeUndefined();
  });
  it('unknown (no attestation, or dead/recycled pid) → identity.state=unknown and NO registry plan value', () => {
    const none = getDaemonStreamingCardUsageSnapshot(ds({}), 'claude-code');
    expect(none.identity).toEqual({ state: 'unknown' });
    expect(none.model).toBeUndefined();
    const recycled = getDaemonStreamingCardUsageSnapshot(ds({ launchAttestation: attestation({ cliProcStart: '1' }) }), 'claude-code');
    expect(recycled.identity).toEqual({ state: 'unknown' });
    expect(recycled.model).toBeUndefined();
  });
  it('non-Claude session → no identity; legacy executor/launch fields untouched', () => {
    const snap = getDaemonStreamingCardUsageSnapshot(
      { larkAppId: 'cli_test_streaming_identity', activeModel: 'gpt-5.6-sol', activeReasoningEffort: 'xhigh',
        session: { sessionId: 's2', cliId: 'codex', model: 'gpt-5.6-sol' } } as any, 'codex');
    expect(snap.identity).toBeUndefined();
    expect(snap).toMatchObject({ model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' });
  });
});

describe('real snapshot → buildStreamingCard()', () => {
  it('verified, no usage numbers → row still shows model + high(默认)', () => {
    const json = streaming(ds({ launchAttestation: attestation() }));
    expect(json).toMatch(/claude-fable-5-1/);
    expect(json).toContain('high(默认)');
    expect(json).not.toContain('claude-opus-5');
  });
  it('unknown → 「模型：未知（重生后核验）」 and never the registry value', () => {
    const json = streaming(ds({}));
    expect(json).toContain('模型：未知（重生后核验）');
    expect(json).not.toContain('claude-opus-5');
  });
  it('non-Claude legacy: the **model** effort pair still renders from the real snapshot (unchanged)', () => {
    const d = { larkAppId: 'cli_test_streaming_identity', activeModel: 'gpt-5.6-sol', activeReasoningEffort: 'xhigh',
      session: { sessionId: 's2', cliId: 'codex', model: 'gpt-5.6-sol' } } as any;
    // (the real usage reader returns a zero-usage context for an empty session, so the row renders; the
    //  "no metrics → no standalone legacy row" rule is covered with a synthetic snapshot in card-builder.test.ts)
    const snap = { ...getDaemonStreamingCardUsageSnapshot(d, 'codex'), context: { usedTokens: 1000, windowTokens: 200000 } };
    expect(snap.identity).toBeUndefined();
    const json = JSON.stringify(JSON.parse(buildStreamingCard('s2', 'om_r', 'https://t/x', 't', 'b', 'working', 'codex',
      'hidden', undefined, undefined, false, false, undefined, undefined, undefined, false, snap)));
    expect(json).toContain('gpt-5.6-sol');
    expect(json).toContain('xhigh');
  });
});

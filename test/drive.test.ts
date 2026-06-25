/**
 * 二期「推动」决策逻辑单测：按目标催 + 防刷屏四道闸（防自激 / 停滞节流 / 变化检测 / 日预算）。
 * Run: pnpm vitest run test/drive.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
const mockWriteRelayRecord = vi.hoisted(() => vi.fn());

vi.mock('../src/config.js', () => ({ config: { get session() { return { dataDir: tempDir }; } } }));
vi.mock('../src/utils/logger.js', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
vi.mock('../src/services/base-relay.js', () => ({
  writeRelayRecord: (...args: any[]) => mockWriteRelayRecord(...args),
}));
vi.mock('../src/core/main-bot-playbook.js', () => ({
  resolveBotIdent: () => ({ larkAppId: 'cli_tilly', openId: 'ou_tilly', name: '缇蕾' }),
}));

async function fresh() {
  vi.resetModules();
  return {
    drive: await import('../src/services/drive.js'),
    store: await import('../src/services/drive-store.js'),
    policy: await import('../src/services/chat-policy-store.js'),
  };
}

const SPEAKER = 'ou_tilly';
const HUMAN = 'ou_human';
const T0 = new Date('2026-06-24T10:00:00+08:00').getTime();
const opts = { stallMs: 30 * 60_000, maxNudges: 3, judgeCooldownMs: 0, maxPerDay: 6 };

function mkExec(over: any = {}) {
  return {
    driveSpeakerId: SPEAKER,
    fetchMessages: vi.fn(async () => [{ id: 'm1', senderId: HUMAN, createTimeMs: T0 - 40 * 60_000, rendered: '[human] 卡住了' }]),
    judge: vi.fn(async () => ({ shouldNudge: true, nudgeText: '关于目标X，看起来卡在A了，要不要先把B推一下？' })),
    nudge: vi.fn(async () => true),
    ...over,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'drive-'));
  mockWriteRelayRecord.mockReset();
  mockWriteRelayRecord.mockResolvedValue({ ok: true, recordId: 'rec_drive_1' });
});
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('runDriveTick', () => {
  it('drive off / 没目标 → 不检查', async () => {
    const { drive, policy } = await fresh();
    policy.setPolicy('oc_a', { driveOn: false });
    policy.setPolicy('oc_b', { driveOn: true }); // 没 goal → enabled=false
    const exec = mkExec();
    const r = await drive.runDriveTick(new Date(T0), exec, opts);
    expect(r.checked).toBe(0);
    expect(exec.fetchMessages).not.toHaveBeenCalled();
  });

  it('卡够久 + judge 说催 → 急急如律令 nudge + 记次数/预算', async () => {
    const { drive, policy, store } = await fresh();
    policy.setPolicy('oc_a', { driveOn: true, driveGoal: '推进目标X', driveTargetSummonName: '克劳德' });
    const exec = mkExec();
    const r = await drive.runDriveTick(new Date(T0), exec, opts);
    expect(r.nudged).toBe(1);
    expect(exec.nudge).toHaveBeenCalledOnce();
    expect(exec.nudge).toHaveBeenCalledWith('oc_a', '关于目标X，看起来卡在A了，要不要先把B推一下？', '克劳德');
    const st = store.getDriveState('oc_a')!;
    expect(st.nudgeCount).toBe(1);
    expect(st.sentToday).toBe(1);
    expect(st.lastNudgeSignature).toBeTruthy();
  });

  it('最近有人说话（没卡够久）→ 不催', async () => {
    const { drive, policy } = await fresh();
    policy.setPolicy('oc_a', { driveOn: true, driveGoal: '推进目标X' });
    const exec = mkExec({ fetchMessages: vi.fn(async () => [{ id: 'm1', senderId: HUMAN, createTimeMs: T0 - 5 * 60_000, rendered: '刚聊' }]) });
    const r = await drive.runDriveTick(new Date(T0), exec, opts);
    expect(r.nudged).toBe(0);
    expect(exec.judge).not.toHaveBeenCalled();
  });

  it('①防自激：只有缇蕾自己的消息 → 不算群进展，仍按旧基线判卡住', async () => {
    const { drive, policy, store } = await fresh();
    policy.setPolicy('oc_a', { driveOn: true, driveGoal: '推进目标X' });
    // 预置：40min 前有过实质活动（卡住基线）
    store.saveDriveState({
      chatId: 'oc_a', lastSubstantiveActivityAt: new Date(T0 - 40 * 60_000).toISOString(),
      episodeAnchorAt: new Date(T0 - 40 * 60_000).toISOString(), nudgeCount: 0,
      lastDriveNudgeAt: null, lastNudgeSignature: null, dateKey: store.dateKeyOf(new Date(T0)), sentToday: 0,
    });
    // 本轮只有缇蕾自己 1min 前发的消息（推动催促回声）
    const exec = mkExec({ fetchMessages: vi.fn(async () => [{ id: 'm1', senderId: SPEAKER, createTimeMs: T0 - 1 * 60_000, rendered: '[缇蕾] 之前催的' }]) });
    const r = await drive.runDriveTick(new Date(T0), exec, opts);
    expect(r.nudged).toBe(1); // 缇蕾自己的消息没把基线刷新 → 仍判卡住 → 催
    // 基线没被缇蕾消息更新
    expect(store.getDriveState('oc_a')!.lastSubstantiveActivityAt).toBe(new Date(T0 - 40 * 60_000).toISOString());
  });

  it('③变化检测：同样的催促不重复说', async () => {
    const { drive, policy } = await fresh();
    policy.setPolicy('oc_a', { driveOn: true, driveGoal: '推进目标X' });
    const exec = mkExec(); // judge 每次返回同一句
    await drive.runDriveTick(new Date(T0), exec, opts); // 第一次催
    // 31min 后再卡（冷却已过），judge 还是同一句 → 应被变化检测压住
    const r2 = await drive.runDriveTick(new Date(T0 + 31 * 60_000), exec, opts);
    expect(r2.suppressedRepeat).toBe(1);
    expect(exec.nudge).toHaveBeenCalledOnce(); // 只发了一次
  });

  it('②停滞节流：本窗口催满 MAX 后停手（capped）', async () => {
    const { drive, policy } = await fresh();
    policy.setPolicy('oc_a', { driveOn: true, driveGoal: '推进目标X' });
    let n = 0;
    const exec = mkExec({ judge: vi.fn(async () => ({ shouldNudge: true, nudgeText: `催第${++n}次：卡点不同` })) });
    // 同一停滞窗口（没有新的实质活动），每隔 31min 催一次
    await drive.runDriveTick(new Date(T0), exec, opts);
    await drive.runDriveTick(new Date(T0 + 31 * 60_000), exec, opts);
    await drive.runDriveTick(new Date(T0 + 62 * 60_000), exec, opts);
    const r4 = await drive.runDriveTick(new Date(T0 + 93 * 60_000), exec, opts);
    expect(exec.nudge).toHaveBeenCalledTimes(3); // 催 3 次封顶
    expect(r4.stalledButQuiet).toBe(1);          // 第 4 次 capped 停手
  });

  it('④日预算耗尽 → 只记录不发', async () => {
    const { drive, policy } = await fresh();
    policy.setPolicy('oc_a', { driveOn: true, driveGoal: '推进目标X' });
    let n = 0;
    const exec = mkExec({ judge: vi.fn(async () => ({ shouldNudge: true, nudgeText: `催第${++n}次` })) });
    const o1 = { ...opts, maxPerDay: 1 };
    await drive.runDriveTick(new Date(T0), exec, o1);                      // 用掉唯一预算
    const r2 = await drive.runDriveTick(new Date(T0 + 31 * 60_000), exec, o1);
    expect(r2.droppedBudget).toBe(1);
    expect(exec.nudge).toHaveBeenCalledOnce();
  });

  it('judge 说不用催 → 不催', async () => {
    const { drive, policy } = await fresh();
    policy.setPolicy('oc_a', { driveOn: true, driveGoal: '推进目标X' });
    const exec = mkExec({ judge: vi.fn(async () => ({ shouldNudge: false, nudgeText: '' })) });
    const r = await drive.runDriveTick(new Date(T0), exec, opts);
    expect(r.nudged).toBe(0);
    expect(exec.nudge).not.toHaveBeenCalled();
  });

  it('群里有人动了 → 开新窗口、催次数归零', async () => {
    const { drive, policy, store } = await fresh();
    policy.setPolicy('oc_a', { driveOn: true, driveGoal: '推进目标X' });
    store.saveDriveState({
      chatId: 'oc_a', lastSubstantiveActivityAt: new Date(T0 - 60 * 60_000).toISOString(),
      episodeAnchorAt: new Date(T0 - 60 * 60_000).toISOString(), nudgeCount: 2,
      lastDriveNudgeAt: new Date(T0 - 35 * 60_000).toISOString(), lastNudgeSignature: 'old', dateKey: store.dateKeyOf(new Date(T0)), sentToday: 2,
    });
    // 真人刚说话
    const exec = mkExec({ fetchMessages: vi.fn(async () => [{ id: 'm9', senderId: HUMAN, createTimeMs: T0 - 1000, rendered: '我推进了' }]) });
    await drive.runDriveTick(new Date(T0), exec, opts);
    const st = store.getDriveState('oc_a')!;
    expect(st.nudgeCount).toBe(0);          // 窗口重置
    expect(st.lastNudgeSignature).toBe(null);
  });

  it('daemon 集成路径：runDriveTick 使用 drive-executors 写急急如律令 relay record', async () => {
    const { drive, policy, store } = await fresh();
    const { makeDriveExecutors } = await import('../src/services/drive-executors.js');
    policy.setPolicy('oc_live', { driveOn: true, driveGoal: '推进目标X', driveTargetSummonName: '克劳德' });
    store.saveDriveState({
      chatId: 'oc_live',
      lastSubstantiveActivityAt: new Date(T0 - 40 * 60_000).toISOString(),
      episodeAnchorAt: new Date(T0 - 40 * 60_000).toISOString(),
      nudgeCount: 0,
      lastDriveNudgeAt: null,
      lastNudgeSignature: null,
      dateKey: store.dateKeyOf(new Date(T0)),
      sentToday: 0,
    });

    const exec = {
      ...makeDriveExecutors(),
      fetchMessages: vi.fn(async () => []),
      judge: vi.fn(async () => ({ shouldNudge: true, nudgeText: '请继续推进目标X' })),
    };
    const r = await drive.runDriveTick(new Date(T0), exec, opts);

    expect(r.nudged).toBe(1);
    expect(mockWriteRelayRecord).toHaveBeenCalledOnce();
    expect(mockWriteRelayRecord).toHaveBeenCalledWith({
      targetChatId: 'oc_live',
      text: '急急如律令：【克劳德】请继续推进目标X',
    });
  });
});

describe('drive urgent summon renderer', () => {
  it('渲染急急如律令目标名，不使用 Lark @ open_id', async () => {
    const { buildDriveNudgeSummon } = await import('../src/services/drive-executors.js');
    expect(buildDriveNudgeSummon('请推进下一步', '克劳德')).toBe('急急如律令：【克劳德】请推进下一步');
  });

  it('未配置目标名时默认唤醒克劳德 root/main bot', async () => {
    const { buildDriveNudgeSummon } = await import('../src/services/drive-executors.js');
    expect(buildDriveNudgeSummon('继续推进', null)).toBe('急急如律令：【克劳德】继续推进');
  });
});

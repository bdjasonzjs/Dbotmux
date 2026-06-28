/**
 * 投递路径集成测试：observer「急急如律令推动」的 **真投递接缝**。
 *
 * 现有 test/drive.test.ts mock 掉了 `exec.nudge`，只覆盖决策逻辑；本测试反过来——
 * 让 `runDriveTick` 走 **真的** `makeDriveExecutors().nudge`（含真 `buildDriveNudgeSummon`），
 * 只在最底层两个 IO 边界打桩：
 *   - `listChatMessages`（Lark 拉群消息）
 *   - `writeRelayRecord`（Base relay 写记录 = 急急如律令物理投递入口）
 *
 * 证明的链路：drive tick →（停滞判定）→ 真 executor.nudge → buildDriveNudgeSummon →
 * writeRelayRecord，且写出的 payload 形如 `急急如律令：【目标bot】…`、targetChatId 正确。
 * judge（coco LLM）不在投递路径上，stub 成确定结果，避免 spawn 真 coco。
 *
 * Run: pnpm vitest run test/drive-delivery.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
vi.mock('../src/config.js', () => ({ config: { get session() { return { dataDir: tempDir }; } } }));
vi.mock('../src/utils/logger.js', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

// 投递路径的两个底层 IO 边界 —— 只在这里打桩，中间全走真代码。
const listChatMessages = vi.fn();
vi.mock('../src/im/lark/client.js', () => ({ listChatMessages: (...a: any[]) => listChatMessages(...a) }));
const writeRelayRecord = vi.fn();
vi.mock('../src/services/base-relay.js', () => ({ writeRelayRecord: (...a: any[]) => writeRelayRecord(...a) }));

const TILLY_OPEN = 'ou_tilly_open';
const TILLY_APP = 'cli_coco_app';
const HUMAN = 'ou_human';
const CHAT = 'oc_target_group';
const T0 = new Date('2026-06-24T10:00:00+08:00').getTime();
const OPTS = { stallMs: 30 * 60_000, maxNudges: 3, judgeCooldownMs: 0, maxPerDay: 6 };

// makeDriveExecutors() 构造时 resolveBotIdent('tilly') 要读 bots-info.json。
function seedBotsInfo() {
  writeFileSync(join(tempDir, 'bots-info.json'), JSON.stringify([
    { larkAppId: TILLY_APP, botName: '缇蕾', cliId: 'coco', botOpenId: TILLY_OPEN },
  ]));
}

// fetchMessages 解析的原始 Lark 消息结构。
function rawMsg(senderOpenId: string, createTimeMs: number, text: string) {
  return {
    message_id: 'm_' + createTimeMs,
    sender: { id: senderOpenId, sender_id: { open_id: senderOpenId } },
    create_time: String(createTimeMs),
    body: { content: JSON.stringify({ text }) },
  };
}

async function fresh() {
  vi.resetModules();
  return {
    drive: await import('../src/services/drive.js'),
    policy: await import('../src/services/chat-policy-store.js'),
    store: await import('../src/services/drive-store.js'),
    execs: await import('../src/services/drive-executors.js'),
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'drive-deliv-'));
  seedBotsInfo();
  listChatMessages.mockReset();
  writeRelayRecord.mockReset();
});
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('drive 投递路径集成（drive tick → 真 nudge executor → writeRelayRecord）', () => {
  it('drive=on + 停滞>阈值 → 真 executor 写出「急急如律令：【克劳德】…」relay record', async () => {
    const { drive, policy, store, execs } = await fresh();
    policy.setPolicy(CHAT, { driveOn: true, driveGoal: '推进目标X', driveTargetSummonName: '克劳德' });

    // Lark 真返回：40min 前真人发的一条（> 30min 停滞阈值）。
    listChatMessages.mockResolvedValue([rawMsg(HUMAN, T0 - 40 * 60_000, '卡住了，等人接')]);
    // Base relay 真写成功，回 recordId（= 真投递凭证）。
    writeRelayRecord.mockResolvedValue({ ok: true, recordId: 'recXYZ123' });

    // 真 executors，只 stub judge（coco LLM，不在投递路径上）。
    const exec = { ...execs.makeDriveExecutors(), judge: async () => ({ shouldNudge: true, nudgeText: '目标X 卡在 A，建议先把 B 推一下' }) };

    const r = await drive.runDriveTick(new Date(T0), exec, OPTS);

    // —— 真投递发生了 ——
    expect(r.nudged).toBe(1);
    expect(writeRelayRecord).toHaveBeenCalledOnce();
    const arg = writeRelayRecord.mock.calls[0][0];
    expect(arg.targetChatId).toBe(CHAT);
    expect(arg.text).toMatch(/^急急如律令：【克劳德】/);          // 急急如律令格式 + 目标 bot
    expect(arg.text).toContain('目标X 卡在 A，建议先把 B 推一下'); // 带上 judge 的催促正文
    // —— 投递成功后落了 state（次数/预算）——
    const st = store.getDriveState(CHAT)!;
    expect(st.nudgeCount).toBe(1);
    expect(st.sentToday).toBe(1);
    expect(st.lastNudgeSignature).toBeTruthy();
  });

  it('未配 summon 目标名 → 默认唤醒克劳德（root/main bot）', async () => {
    const { drive, policy, execs } = await fresh();
    policy.setPolicy(CHAT, { driveOn: true, driveGoal: '推进目标X' }); // 不带 driveTargetSummonName
    listChatMessages.mockResolvedValue([rawMsg(HUMAN, T0 - 40 * 60_000, '卡住了')]);
    writeRelayRecord.mockResolvedValue({ ok: true, recordId: 'rec1' });

    const exec = { ...execs.makeDriveExecutors(), judge: async () => ({ shouldNudge: true, nudgeText: '继续推进下一步' }) };
    await drive.runDriveTick(new Date(T0), exec, OPTS);

    expect(writeRelayRecord).toHaveBeenCalledOnce();
    expect(writeRelayRecord.mock.calls[0][0].text).toBe('急急如律令：【克劳德】继续推进下一步');
  });

  it('writeRelayRecord 写失败 → nudged=0、不记 state（下轮可重试，不假记成功）', async () => {
    const { drive, policy, store, execs } = await fresh();
    policy.setPolicy(CHAT, { driveOn: true, driveGoal: '推进目标X', driveTargetSummonName: '克劳德' });
    listChatMessages.mockResolvedValue([rawMsg(HUMAN, T0 - 40 * 60_000, '卡住了')]);
    writeRelayRecord.mockResolvedValue({ ok: false, authError: false, error: 'group not found' });

    const exec = { ...execs.makeDriveExecutors(), judge: async () => ({ shouldNudge: true, nudgeText: '推一下' }) };
    const r = await drive.runDriveTick(new Date(T0), exec, OPTS);

    expect(writeRelayRecord).toHaveBeenCalledOnce(); // 真尝试投递了
    expect(r.nudged).toBe(0);                        // 但失败 → 不计 nudged
    const st = store.getDriveState(CHAT);
    expect(st?.nudgeCount ?? 0).toBe(0);             // 没假记成功
    expect(st?.lastDriveNudgeAt ?? null).toBeFalsy();
  });

  it('防自激：本轮只有缇蕾自己的催促回声 → 不刷新基线，仍判停滞 → 真投递（不自激但也不漏催）', async () => {
    const { drive, policy, store, execs } = await fresh();
    policy.setPolicy(CHAT, { driveOn: true, driveGoal: '推进目标X', driveTargetSummonName: '克劳德' });
    // 预置 40min 前的停滞基线。
    store.saveDriveState({
      chatId: CHAT, lastSubstantiveActivityAt: new Date(T0 - 40 * 60_000).toISOString(),
      episodeAnchorAt: new Date(T0 - 40 * 60_000).toISOString(), nudgeCount: 0,
      lastDriveNudgeAt: null, lastNudgeSignature: null, dateKey: store.dateKeyOf(new Date(T0)), sentToday: 0,
    });
    // 本轮 Lark 只返回缇蕾自己 1min 前的催促回声。
    listChatMessages.mockResolvedValue([rawMsg(TILLY_OPEN, T0 - 1 * 60_000, '[缇蕾] 之前催的')]);
    writeRelayRecord.mockResolvedValue({ ok: true, recordId: 'rec2' });

    const exec = { ...execs.makeDriveExecutors(), judge: async () => ({ shouldNudge: true, nudgeText: '还是卡着，推一下 B' }) };
    const r = await drive.runDriveTick(new Date(T0), exec, OPTS);

    expect(r.nudged).toBe(1); // 缇蕾自己的消息没刷新基线 → 仍判停滞 → 真投递
    expect(writeRelayRecord).toHaveBeenCalledOnce();
    // 基线没被缇蕾的回声更新。
    expect(store.getDriveState(CHAT)!.lastSubstantiveActivityAt).toBe(new Date(T0 - 40 * 60_000).toISOString());
  });
});

/**
 * 一期 · `botmux watch` CLI 单测（含蔻黛克斯 P2-2 可达性 accept/reject 逻辑）。
 * Run: pnpm vitest run test/watch-cli.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
let logs: string[];
let errs: string[];

vi.mock('../src/config.js', () => ({
  config: { get session() { return { dataDir: tempDir }; } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

async function fresh() {
  vi.resetModules();
  return {
    cli: await import('../src/cli/watch.js'),
    policy: await import('../src/services/chat-policy-store.js'),
    inbox: await import('../src/services/watch-inbox-store.js'),
  };
}

const okProber = async () => ({ ok: true });
const failProber = async () => ({ ok: false, reason: '机器人不在该群' });

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'watch-cli-'));
  logs = []; errs = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { errs.push(a.join(' ')); });
  process.exitCode = 0;
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('botmux watch CLI', () => {
  it('set 三开关 → 落库（推动用 --push 带目标）', async () => {
    const { cli, policy } = await fresh();
    await cli.cmdWatch('set', ['--chat', 'oc_a', '--scout', 'mute', '--push', '推进目标X', '--report', 'oc_t'], { reachProber: okProber });
    const p = policy.getPolicy('oc_a')!;
    expect(p.scoutMode).toBe('mute');
    expect(p.driveOn).toBe(true);
    expect(p.driveGoal).toBe('推进目标X');
    expect(p.reportTargetChatId).toBe('oc_t');
    expect(process.exitCode).toBe(0);
  });

  it('--drive on 但没目标 → 报错', async () => {
    const { cli, policy } = await fresh();
    await cli.cmdWatch('set', ['--chat', 'oc_a', '--drive', 'on'], {});
    expect(process.exitCode).toBe(2);
    expect(policy.getPolicy('oc_a')).toBe(null);
  });

  it('--push off 关推动', async () => {
    const { cli, policy } = await fresh();
    await cli.cmdWatch('set', ['--chat', 'oc_a', '--push', '目标'], {});
    await cli.cmdWatch('set', ['--chat', 'oc_a', '--push', 'off'], {});
    expect(policy.getPolicy('oc_a')!.driveOn).toBe(false);
  });

  it('P2-2：目标群不可达 → 报错 + 不落库', async () => {
    const { cli, policy } = await fresh();
    await cli.cmdWatch('set', ['--chat', 'oc_a', '--report', 'oc_unreachable'], { reachProber: failProber });
    expect(process.exitCode).toBe(2);
    expect(errs.join('\n')).toContain('不可达');
    expect(policy.getPolicy('oc_a')).toBe(null); // 没落库
  });

  it('P2-2：--skip-verify 跳过可达性检查', async () => {
    const { cli, policy } = await fresh();
    await cli.cmdWatch('set', ['--chat', 'oc_a', '--report', 'oc_x', '--skip-verify'], { reachProber: failProber });
    expect(process.exitCode).toBe(0);
    expect(policy.getReportTarget('oc_a')).toBe('oc_x');
  });

  it('--report off 清空汇报目标（不验可达）', async () => {
    const { cli, policy } = await fresh();
    await cli.cmdWatch('set', ['--chat', 'oc_a', '--report', 'off'], { reachProber: failProber });
    expect(process.exitCode).toBe(0);
    expect(policy.getReportTarget('oc_a')).toBe(null);
  });

  it('非法 --drive/--scout 值 → 报错', async () => {
    const { cli } = await fresh();
    await cli.cmdWatch('set', ['--chat', 'oc_a', '--drive', 'maybe'], {});
    expect(process.exitCode).toBe(2);
  });

  it('remove', async () => {
    const { cli, policy } = await fresh();
    await cli.cmdWatch('set', ['--chat', 'oc_a', '--scout', 'mute'], {});
    await cli.cmdWatch('remove', ['--chat', 'oc_a'], {});
    expect(policy.getPolicy('oc_a')).toBe(null);
  });

  it('incidents 列 open + close 关掉', async () => {
    const { cli, inbox } = await fresh();
    inbox.upsertIncident({ watchedChatId: 'oc_w', slug: 's', targetChatId: 'oc_t', kind: 'alert', summary: 'x', evidence: 'e', sourceMessageIds: ['m'] });
    await cli.cmdWatch('incidents', [], {});
    expect(logs.join('\n')).toContain('oc_w:s');
    await cli.cmdWatch('close', ['oc_w:s', '--by', '松松'], {});
    expect(inbox.getIncident('oc_w:s')!.status).toBe('closed');
    expect(inbox.getIncident('oc_w:s')!.closedBy).toBe('松松');
  });
});

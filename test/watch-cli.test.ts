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
  // dataDir 用 tempDir/data：schedule-store 的 per-bot 路径是 dirname(dataDir)/bots/<app>，
  // 嵌一层让 bots 目录也落在 tempDir 内（instant 撤销用例会碰 schedule store）。
  config: { get session() { return { dataDir: join(tempDir, 'data') }; } },
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
    instant: await import('../src/services/instant-observer.js'),
    schedules: await import('../src/services/schedule-store.js'),
  };
}

/** 在某 app 的 schedule store 里预置一条 pending instant 唤醒任务。 */
function seedInstantTask(mods: Awaited<ReturnType<typeof fresh>>, chat: string, appId: string) {
  return mods.schedules.createTask({
    id: mods.instant.instantTaskId(chat, appId),
    name: mods.instant.instantTaskName(chat),
    schedule: 'instant+90s',
    parsed: { kind: 'once', runAt: new Date(Date.now() + 90_000).toISOString(), display: 'instant-observer +90s' },
    prompt: '对账一轮',
    workingDir: '/work',
    chatId: chat,
    chatType: 'topic_group',
    scope: 'chat',
    executionPosition: 'top-level',
    larkAppId: appId,
    repeat: { times: 1, completed: 0 },
    silent: true,
  });
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
  it('set 三开关 → 落库（推动用 --push 带目标，可配急急如律令目标）', async () => {
    const { cli, policy } = await fresh();
    await cli.cmdWatch('set', ['--chat', 'oc_a', '--scout', 'mute', '--push', '推进目标X', '--summon', '克劳德', '--report', 'oc_t'], { reachProber: okProber });
    const p = policy.getPolicy('oc_a')!;
    expect(p.scoutMode).toBe('mute');
    expect(p.driveOn).toBe(true);
    expect(p.driveGoal).toBe('推进目标X');
    expect(p.driveTargetSummonName).toBe('克劳德');
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

describe('botmux watch CLI · --instant 即时唤醒（review P1-2 / P2-2）', () => {
  const APP = 'cli_observer0001';
  const APP2 = 'cli_observer0002';

  it('--instant on 全参数落库；show/list 显示即时唤醒状态', async () => {
    const m = await fresh();
    await m.cli.cmdWatch('set', ['--chat', 'oc_a', '--instant', 'on', '--instant-app', APP, '--instant-debounce', '100', '--instant-prompt', '对账P'], {});
    expect(process.exitCode).toBe(0);
    expect(m.policy.getPolicy('oc_a')!.instantObserver).toEqual({
      enabled: true, larkAppId: APP, debounceSeconds: 100, prompt: '对账P',
    });
    logs = [];
    await m.cli.cmdWatch('show', ['--chat', 'oc_a'], {});
    expect(logs.join('\n')).toContain('即时唤醒: on');
    expect(logs.join('\n')).toContain(APP);
  });

  it('--instant on 缺 --instant-app（且无旧配置）→ 报错不落库', async () => {
    const m = await fresh();
    await m.cli.cmdWatch('set', ['--chat', 'oc_a', '--instant', 'on'], {});
    expect(process.exitCode).toBe(2);
    expect(m.policy.getPolicy('oc_a')).toBe(null);
  });

  it('--instant-debounce 超出 60~120 → 报错不落库', async () => {
    const m = await fresh();
    await m.cli.cmdWatch('set', ['--chat', 'oc_a', '--instant', 'on', '--instant-app', APP, '--instant-debounce', '30'], {});
    expect(process.exitCode).toBe(2);
    expect(m.policy.getPolicy('oc_a')).toBe(null);
    process.exitCode = 0;
    await m.cli.cmdWatch('set', ['--chat', 'oc_a', '--instant', 'on', '--instant-app', APP, '--instant-debounce', '121'], {});
    expect(process.exitCode).toBe(2);
  });

  it('再次 --instant on 不带参数 → 保留旧 app/debounce/prompt', async () => {
    const m = await fresh();
    await m.cli.cmdWatch('set', ['--chat', 'oc_a', '--instant', 'on', '--instant-app', APP, '--instant-debounce', '110', '--instant-prompt', 'P旧'], {});
    await m.cli.cmdWatch('set', ['--chat', 'oc_a', '--instant', 'on'], {});
    expect(process.exitCode).toBe(0);
    expect(m.policy.getPolicy('oc_a')!.instantObserver).toEqual({
      enabled: true, larkAppId: APP, debounceSeconds: 110, prompt: 'P旧',
    });
  });

  it('--instant-app 等旁支参数不带 --instant on → 报错', async () => {
    const m = await fresh();
    await m.cli.cmdWatch('set', ['--chat', 'oc_a', '--instant-app', APP], {});
    expect(process.exitCode).toBe(2);
  });

  it('P1-2：--instant off 清策略并撤销该 app 的 pending 唤醒任务', async () => {
    const m = await fresh();
    await m.cli.cmdWatch('set', ['--chat', 'oc_a', '--instant', 'on', '--instant-app', APP], {});
    seedInstantTask(m, 'oc_a', APP);
    expect(m.schedules.listTasks(APP)).toHaveLength(1);

    await m.cli.cmdWatch('set', ['--chat', 'oc_a', '--instant', 'off'], {});
    expect(process.exitCode).toBe(0);
    expect(m.policy.getPolicy('oc_a')!.instantObserver).toBeNull();
    expect(m.schedules.listTasks(APP)).toHaveLength(0); // pending 已撤销
    expect(logs.join('\n')).toContain('已撤销 1 条');
  });

  it('P1-2：切 --instant-app → 旧 app 的 pending 撤销，新 app 生效', async () => {
    const m = await fresh();
    await m.cli.cmdWatch('set', ['--chat', 'oc_a', '--instant', 'on', '--instant-app', APP], {});
    seedInstantTask(m, 'oc_a', APP);

    await m.cli.cmdWatch('set', ['--chat', 'oc_a', '--instant', 'on', '--instant-app', APP2], {});
    expect(process.exitCode).toBe(0);
    expect(m.policy.getPolicy('oc_a')!.instantObserver!.larkAppId).toBe(APP2);
    expect(m.schedules.listTasks(APP)).toHaveLength(0); // 旧 app 名下 pending 已清
  });

  it('P1-2：watch remove → 策略删除且 pending 撤销', async () => {
    const m = await fresh();
    await m.cli.cmdWatch('set', ['--chat', 'oc_a', '--instant', 'on', '--instant-app', APP], {});
    seedInstantTask(m, 'oc_a', APP);

    await m.cli.cmdWatch('remove', ['--chat', 'oc_a'], {});
    expect(m.policy.getPolicy('oc_a')).toBe(null);
    expect(m.schedules.listTasks(APP)).toHaveLength(0);
  });

  it('撤销不误伤：同 app 其它群/其它任务不受影响', async () => {
    const m = await fresh();
    await m.cli.cmdWatch('set', ['--chat', 'oc_a', '--instant', 'on', '--instant-app', APP], {});
    seedInstantTask(m, 'oc_a', APP);
    seedInstantTask(m, 'oc_b', APP); // 另一个群的 pending
    m.schedules.createTask({
      name: 'observer事件轮-15min', schedule: '*/15 * * * *',
      parsed: { kind: 'cron', expr: '*/15 * * * *', display: '每 15 分钟' },
      prompt: '对账', workingDir: '/work', chatId: 'oc_a',
      chatType: 'topic_group', scope: 'chat', executionPosition: 'top-level', larkAppId: APP,
    });

    await m.cli.cmdWatch('set', ['--chat', 'oc_a', '--instant', 'off'], {});
    const left = m.schedules.listTasks(APP);
    expect(left).toHaveLength(2); // oc_b 的 instant + 15min cron 原样保留
    expect(left.map(t => t.name).sort()).toEqual([m.instant.instantTaskName('oc_b'), 'observer事件轮-15min'].sort());
  });
});

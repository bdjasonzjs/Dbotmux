/**
 * CLI `botmux watch` —— 给任意群挂 observer + 扫读静音的「统一群级配置」入口
 * （设计 v3.1 §二/§五，一期）。直接读写 chat-policy-store + watch-inbox-store
 * （本地原子 JSON，daemon 每 tick 重读，CLI 写完下 tick 即生效）。
 *
 * ⚠️ 调用方（cli.ts dispatch）必须先 `process.env.SESSION_DATA_DIR ??= resolveDataDir()`
 * 再 import 本模块，否则 store 读错 dataDir。
 *
 * 用法：
 *   botmux watch set --chat oc_xxx [--push "<目标>"|off] [--mention ou_xxx|off] [--until "<时间>"|off] [--max-per-day N] [--report oc_target|off] [--scout watch|mute] [--skip-verify]
 *   botmux watch list
 *   botmux watch show --chat oc_xxx
 *   botmux watch remove --chat oc_xxx
 *   botmux watch incidents [--target oc_xxx]    # 列 open incident（可按目标群过滤）
 *   botmux watch close <incidentId> [--by 名字]  # 显式 close 一条 incident（"回应后闭嘴"扳机）
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  setPolicy, listPolicies, getPolicy, removePolicy, type ChatPolicy,
} from '../services/chat-policy-store.js';
import {
  listOpen, listOpenByTarget, closeIncident, type WatchIncident,
} from '../services/watch-inbox-store.js';

const execFileAsync = promisify(execFile);

function argValue(rest: string[], ...flags: string[]): string | undefined {
  for (const flag of flags) {
    const i = rest.indexOf(flag);
    if (i >= 0 && i + 1 < rest.length) return rest[i + 1];
  }
  return undefined;
}
function hasFlag(rest: string[], flag: string): boolean {
  return rest.includes(flag);
}

function parseUntil(raw: string): number | null {
  if (raw === 'off') return null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : NaN;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : NaN;
}

/** 蔻黛克斯 P2-2：验证汇报目标群可达（机器人发得到才接受）。返 ok 或原因。
 *  默认实现：用 lark-cli 列出 bot 所在群，目标群在其中 = 机器人是成员 = 发得到。
 *  注入式（reachProber 参数）便于单测；真实可达性在投递阶段（publisher）再确认一次。 */
export type ReachProber = (targetChatId: string) => Promise<{ ok: boolean; reason?: string }>;

const defaultReachProber: ReachProber = async (targetChatId) => {
  try {
    const { stdout } = await execFileAsync(
      'lark-cli', ['im', '+chat-list', '--as', 'bot', '--page-all', '--format', 'json'],
      { maxBuffer: 20 * 1024 * 1024, timeout: 30_000 },
    );
    const resp = JSON.parse(stdout) as any;
    const items: any[] = resp?.data?.items ?? resp?.data?.chats ?? resp?.items ?? [];
    const ids = new Set(items.map((c) => c?.chat_id ?? c?.chatId).filter(Boolean));
    if (ids.has(targetChatId)) return { ok: true };
    return { ok: false, reason: '机器人不在该目标群（发不到）；先把机器人拉进群，或用 --skip-verify 跳过' };
  } catch (err: any) {
    return { ok: false, reason: `可达性检查失败（${err?.message ?? err}）；确认后可用 --skip-verify 跳过` };
  }
};

function fmtPolicy(p: ChatPolicy): string {
  const bits: string[] = [];
  if (p.driveOn) {
    bits.push(`目标：${p.driveGoal ?? '（未设，无效）'}`);
    if (p.driveMentionOpenId) bits.push(`@ ${p.driveMentionOpenId}`);
    if (p.driveUntil) bits.push(`到 ${new Date(p.driveUntil).toISOString()}`);
    if (p.driveMaxPerDay) bits.push(`每日最多 ${p.driveMaxPerDay}`);
  }
  const drive = p.driveOn ? `on（${bits.join('；')}）` : 'off';
  return `${p.chatId}\n   推动: ${drive} | 汇报: ${p.reportTargetChatId ?? 'off'} | 扫读: ${p.scoutMode}\n   更新: ${p.updatedAt}`;
}

export async function cmdWatch(
  sub: string,
  rest: string[],
  opts: { reachProber?: ReachProber } = {},
): Promise<void> {
  const reachProber = opts.reachProber ?? defaultReachProber;

  if (!sub || sub === '--help' || sub === '-h') {
    console.log(`botmux watch —— 给任意群挂 observer + 扫读静音的统一群级配置

用法:
  botmux watch set --chat oc_xxx [--push "<目标>"|off] [--mention ou_xxx|off] [--until "<时间>"|off] [--max-per-day N] [--report oc_target|off] [--scout watch|mute] [--skip-verify]
  botmux watch list
  botmux watch show --chat oc_xxx
  botmux watch remove --chat oc_xxx
  botmux watch incidents [--target oc_xxx]
  botmux watch close <incidentId> [--by 名字]

每个群三个独立开关: 推动(drive, --push 设目标后缇蕾按目标在群里催) / 汇报(report, off 或目标群) / 扫读(scout, watch|mute)。
主话题默认扫读静音(fail-closed)。`);
    return;
  }

  if (sub === 'set') {
    const chat = argValue(rest, '--chat', '--chat-id');
    if (!chat || !chat.startsWith('oc_')) { console.error('❌ 缺 --chat oc_xxx'); process.exitCode = 2; return; }
    const patch: Parameters<typeof setPolicy>[1] = {};

    // 推动：--push "<目标文本>" 开推动并设目标；--push off 关推动。
    // （drive on 必须带目标——否则推动没方向。）
    const push = argValue(rest, '--push');
    if (push !== undefined) {
      if (push === 'off') {
        patch.driveOn = false;
        patch.driveMentionOpenId = null;
        patch.driveUntil = null;
      } else if (push.trim()) {
        patch.driveOn = true;
        patch.driveGoal = push.trim();
      } else {
        console.error('❌ --push 要么是目标文本，要么是 off'); process.exitCode = 2; return;
      }
    }

    const mention = argValue(rest, '--mention', '--drive-mention');
    if (mention !== undefined) {
      if (mention === 'off') {
        patch.driveMentionOpenId = null;
      } else if (mention.startsWith('ou_')) {
        patch.driveMentionOpenId = mention;
      } else {
        console.error('❌ --mention 只能是 off 或 ou_xxx'); process.exitCode = 2; return;
      }
    }

    const until = argValue(rest, '--until', '--drive-until');
    if (until !== undefined) {
      const parsed = parseUntil(until);
      if (Number.isNaN(parsed)) { console.error('❌ --until 要么是 off、epoch ms，或可解析时间（如 2026-06-25T10:00:00+08:00）'); process.exitCode = 2; return; }
      patch.driveUntil = parsed;
    }

    const maxPerDay = argValue(rest, '--max-per-day', '--drive-max-per-day');
    if (maxPerDay !== undefined) {
      const n = Number(maxPerDay);
      if (!Number.isInteger(n) || n <= 0 || n > 200) { console.error('❌ --max-per-day 必须是 1..200 的整数'); process.exitCode = 2; return; }
      patch.driveMaxPerDay = n;
    }
    // 兼容 --drive on/off：on 必须已有或同时给目标。
    const drive = argValue(rest, '--drive');
    if (drive !== undefined) {
      if (drive !== 'on' && drive !== 'off') { console.error('❌ --drive 只能是 on|off'); process.exitCode = 2; return; }
      if (drive === 'on') {
        const goal = patch.driveGoal ?? getPolicy(chat)?.driveGoal ?? null;
        if (!goal) { console.error('❌ 推动 on 必须带目标，用 --push "<目标>"'); process.exitCode = 2; return; }
        patch.driveOn = true;
      } else {
        patch.driveOn = false;
      }
    }

    const scout = argValue(rest, '--scout');
    if (scout !== undefined) {
      if (scout !== 'watch' && scout !== 'mute') { console.error('❌ --scout 只能是 watch|mute'); process.exitCode = 2; return; }
      patch.scoutMode = scout;
    }

    const report = argValue(rest, '--report', '--report-to');
    if (report !== undefined) {
      if (report === 'off') {
        patch.reportTargetChatId = null;
      } else if (report.startsWith('oc_') || report.startsWith('ou_')) {
        // P2-2: 配目标群时验证可达（除非 --skip-verify）
        if (!hasFlag(rest, '--skip-verify')) {
          const reach = await reachProber(report);
          if (!reach.ok) { console.error(`❌ 汇报目标群不可达: ${reach.reason}`); process.exitCode = 2; return; }
        }
        patch.reportTargetChatId = report;
      } else {
        console.error('❌ --report 只能是 off 或 oc_xxx/ou_xxx'); process.exitCode = 2; return;
      }
    }

    if (Object.keys(patch).length === 0) { console.error('❌ set 至少要带一个 --push/--report/--scout/--drive'); process.exitCode = 2; return; }
    const p = setPolicy(chat, patch);
    console.log(`✅ 已更新群策略\n   ${fmtPolicy(p)}`);
    return;
  }

  if (sub === 'list' || sub === 'ls') {
    const ps = listPolicies();
    if (ps.length === 0) { console.log('暂无群策略。用 `botmux watch set --chat oc_xxx ...` 添加。'); return; }
    console.log(`群策略 (${ps.length}):\n`);
    for (const p of ps) console.log(`── ${fmtPolicy(p)}\n`);
    return;
  }

  if (sub === 'show') {
    const chat = argValue(rest, '--chat', '--chat-id');
    if (!chat) { console.error('❌ 缺 --chat oc_xxx'); process.exitCode = 2; return; }
    const p = getPolicy(chat);
    console.log(p ? fmtPolicy(p) : `⚠️ 没找到 ${chat} 的策略（按默认：推动 off / 汇报 off / 扫读 ${chat ? 'watch（主话题除外，默认静音）' : 'watch'}）`);
    return;
  }

  if (sub === 'remove' || sub === 'rm') {
    const chat = argValue(rest, '--chat', '--chat-id');
    if (!chat) { console.error('❌ 缺 --chat oc_xxx'); process.exitCode = 2; return; }
    console.log(removePolicy(chat) ? `✅ 已移除 ${chat} 的策略` : `⚠️ 没找到 ${chat} 的策略`);
    return;
  }

  if (sub === 'incidents') {
    const target = argValue(rest, '--target', '--target-chat');
    const items: WatchIncident[] = target ? listOpenByTarget(target) : listOpen();
    if (items.length === 0) { console.log(target ? `目标群 ${target} 名下暂无 open incident。` : '暂无 open incident。'); return; }
    console.log(`open incident (${items.length})${target ? ` @目标群 ${target}` : ''}:\n`);
    for (const it of items) {
      console.log(`── ${it.incidentId} [${it.kind}/${it.status}]`);
      console.log(`   被盯群: ${it.watchedChatId} → 汇报到: ${it.targetChatId}`);
      console.log(`   情况: ${it.summary}`);
      console.log(`   投递: ${it.delivery.deliveryStatus}${it.delivery.messageId ? ` (msg ${it.delivery.messageId})` : ''} | 戳 ${it.delivery.pokeCount} 次`);
      console.log(`   关闭它: botmux watch close ${it.incidentId}\n`);
    }
    return;
  }

  if (sub === 'close') {
    const id = rest.find(a => !a.startsWith('-')) ?? argValue(rest, '--id');
    if (!id) { console.error('❌ 缺 incidentId，用 `botmux watch incidents` 查'); process.exitCode = 2; return; }
    const by = argValue(rest, '--by') ?? 'cli';
    const r = closeIncident(id, by);
    console.log(r ? `✅ incident ${id} 已关闭（by ${by}）—— 该卡点不再汇报，除非复发开新一代` : `⚠️ 没找到 incident ${id}`);
    return;
  }

  console.error(`❌ 未知子命令: ${sub} (set/list/show/remove/incidents/close)`); process.exitCode = 2;
}

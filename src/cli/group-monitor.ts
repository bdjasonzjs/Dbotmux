/**
 * 2026-05-30 — CLI `botmux group-monitor` / `monitor-reports` / `monitor-report-consume`。
 *
 * 群实时监控的注册 + 报告查看/消费。直接读写 group-monitor-store (本地原子 JSON,
 * coco daemon 每 tick 重读, 无内存缓存 → CLI 写完下 tick 即生效)。
 *
 * ⚠️ 调用方 (cli.ts dispatch) 必须先 `process.env.SESSION_DATA_DIR ??= resolveDataDir()`
 * 再 import 本模块, 否则 store 会读错 dataDir (默认 <repo>/data 而非 ~/.botmux/data)。
 *
 * 用法:
 *   botmux group-monitor add --chat oc_xxx --goal "监控目标(自然语言)"
 *   botmux group-monitor list
 *   botmux group-monitor remove --chat oc_xxx
 *   botmux monitor-reports            # 列未处理的上报 (克劳德被唤醒后看)
 *   botmux monitor-report-consume <id>  # 标记某条上报已处理
 */
import {
  registerMonitor, listMonitors, removeMonitor,
  listPendingReports, markReportConsumed,
} from '../services/group-monitor-store.js';

function argValue(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  return i >= 0 && i + 1 < rest.length ? rest[i + 1] : undefined;
}

export async function cmdGroupMonitor(sub: string, rest: string[]): Promise<void> {
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(`botmux group-monitor — 缇蕾盯指定群 + 自定义监控目标, 命中就 @ 唤醒克劳德

用法:
  botmux group-monitor add --chat oc_xxx --goal "监控目标(自然语言)"
  botmux group-monitor list
  botmux group-monitor remove --chat oc_xxx`);
    return;
  }

  if (sub === 'add') {
    const chat = argValue(rest, '--chat') ?? argValue(rest, '--chat-id');
    const goal = argValue(rest, '--goal');
    if (!chat || !chat.startsWith('oc_')) { console.error('❌ 缺 --chat oc_xxx (群 chat_id)'); process.exitCode = 2; return; }
    if (!goal) { console.error('❌ 缺 --goal "监控目标"'); process.exitCode = 2; return; }
    const m = registerMonitor({ chatId: chat, goal });
    console.log(`✅ 已注册群监控\n  群: ${m.chatId}\n  目标: ${m.goal}\n  (缇蕾会在 coco daemon 上每轮按节流去判, 命中该上报的事件就 @ 唤醒克劳德)`);
    return;
  }

  if (sub === 'list' || sub === 'ls') {
    const ms = listMonitors();
    if (ms.length === 0) { console.log('暂无群监控。用 `botmux group-monitor add --chat oc_xxx --goal "..."` 添加。'); return; }
    console.log(`群监控 (${ms.length}):\n`);
    for (const m of ms) {
      console.log(`${m.enabled ? '🟢' : '⏸️'} ${m.chatId}\n   目标: ${m.goal}\n   上次判断: ${m.lastJudgedAt ?? '还没'} | 高水位 msg: ${m.lastSeenMessageId ?? '—'}\n`);
    }
    return;
  }

  if (sub === 'remove' || sub === 'rm') {
    const chat = argValue(rest, '--chat') ?? argValue(rest, '--chat-id');
    if (!chat) { console.error('❌ 缺 --chat oc_xxx'); process.exitCode = 2; return; }
    console.log(removeMonitor(chat) ? `✅ 已移除监控 ${chat} (连带其报告)` : `⚠️ 没找到监控 ${chat}`);
    return;
  }

  console.error(`❌ 未知子命令: ${sub} (add/list/remove)`); process.exitCode = 2;
}

export async function cmdMonitorReports(_rest: string[]): Promise<void> {
  const reports = listPendingReports();
  if (reports.length === 0) { console.log('暂无未处理的群监控上报。'); return; }
  console.log(`未处理的群监控上报 (${reports.length}):\n`);
  for (const r of reports) {
    console.log(`── ${r.id} ─────────────────`);
    console.log(`  监控群: ${r.chatId}`);
    console.log(`  目标:   ${r.goal}`);
    console.log(`  情况:   ${r.summary}`);
    console.log(`  证据:   ${r.evidence}`);
    console.log(`  时间:   ${r.createdAt} | 已戳 ${r.pokeCount} 次`);
    console.log(`  处理完: botmux monitor-report-consume ${r.id}\n`);
  }
}

export async function cmdMonitorReportConsume(rest: string[]): Promise<void> {
  const id = rest.find(a => a.startsWith('mr_')) ?? argValue(rest, '--id');
  if (!id) { console.error('❌ 缺 report id (mr_xxx)，用 `botmux monitor-reports` 查'); process.exitCode = 2; return; }
  const r = markReportConsumed(id);
  console.log(r ? `✅ 报告 ${id} 已标记处理完` : `⚠️ 没找到报告 ${id}`);
}

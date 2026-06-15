#!/usr/bin/env tsx
/**
 * 经理群上报泄漏修复 · 上线前扫描门控（蔻黛克斯 review 点1）。
 *
 * 列出 manager 子群中**仍可能被投递层渲染成急急如律令**的存量 report_help 命令：
 *   reportingMode==='manager' 的任务的 report_help 命令里
 *   supersededBy==null && deliveryStatus ∈ {pending, sent_unconfirmed} 的条目。
 *
 * 闭环语义（见方案 docx）：
 *   - pending：部署后 planDispatch 兜底会 skip+supersede（record 未写出，硬闭环）→ 列出仅供知情。
 *   - sent_unconfirmed：record 已写进 Base，代码只能阻止「再次重发」，**拦不住已写出的 record 被自动化发出**
 *     → 这些条目需在部署前人工/脚本把对应 relayRecordId 在 Base 里置「已取消」，或接受残余一次发送。
 *
 * 用法：
 *   pnpm tsx scripts/scan-manager-help-leak.ts            # 扫默认 ~/.botmux/data/subtasks.json
 *   pnpm tsx scripts/scan-manager-help-leak.ts --file <path>
 *   pnpm tsx scripts/scan-manager-help-leak.ts --json     # 机器可读
 *
 * 退出码：发现 sent_unconfirmed 残余（需部署前清理）→ 2；仅 pending 或全清 → 0；读不到文件 → 1。
 * **部署当刻重跑一次**，确认 pending/sent_unconfirmed 计数为 0 再部署。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const fileFlagIdx = argv.indexOf('--file');
const storePath = fileFlagIdx >= 0 && argv[fileFlagIdx + 1]
  ? argv[fileFlagIdx + 1]
  : join(homedir(), '.botmux', 'data', 'subtasks.json');

let raw: string;
try {
  raw = readFileSync(storePath, 'utf8');
} catch (err) {
  console.error(`[scan] 读不到 store: ${storePath} (${(err as Error).message})`);
  process.exit(1);
}

const data = JSON.parse(raw) as {
  subtasks?: Array<{ taskId: string; reportingMode?: string; chatId?: string; goal?: string }>;
  commands?: Array<{
    cmdId: string; taskId: string; commandType: string; direction: string;
    deliveryStatus: string; supersededBy: string | null; relayRecordId: string | null;
  }>;
};

const tasks = data.subtasks ?? [];
const commands = data.commands ?? [];
const managerIds = new Set(tasks.filter(t => t.reportingMode === 'manager').map(t => t.taskId));
const goalOf = new Map(tasks.map(t => [t.taskId, t.goal ?? '']));

const AT_RISK = new Set(['pending', 'sent_unconfirmed']);
const leaks = commands.filter(c =>
  c.commandType === 'report_help'
  && c.direction === 'child_to_parent'
  && managerIds.has(c.taskId)
  && c.supersededBy == null
  && AT_RISK.has(c.deliveryStatus),
).map(c => ({
  taskId: c.taskId,
  cmdId: c.cmdId,
  deliveryStatus: c.deliveryStatus,
  relayRecordId: c.relayRecordId,
  goal: (goalOf.get(c.taskId) ?? '').slice(0, 40),
}));

const pending = leaks.filter(l => l.deliveryStatus === 'pending');
const sentUnconfirmed = leaks.filter(l => l.deliveryStatus === 'sent_unconfirmed');

if (asJson) {
  console.log(JSON.stringify({
    storePath,
    managerTasks: managerIds.size,
    pending: pending.length,
    sentUnconfirmed: sentUnconfirmed.length,
    leaks,
  }, null, 2));
} else {
  console.log(`[scan] store: ${storePath}`);
  console.log(`[scan] manager 任务: ${managerIds.size} 个`);
  console.log(`[scan] 风险 report_help（manager / child→parent / 未 superseded / pending|sent_unconfirmed）: ${leaks.length} 条`);
  console.log(`         pending=${pending.length}（部署后 planDispatch 兜底自动 skip+supersede，硬闭环）`);
  console.log(`         sent_unconfirmed=${sentUnconfirmed.length}（record 已写出，需部署前在 Base 取消对应 relayRecordId 或接受残余发送）`);
  if (leaks.length) {
    console.log('\n  taskId\tcmdId\tdeliveryStatus\trelayRecordId\tgoal');
    for (const l of leaks) {
      console.log(`  ${l.taskId}\t${l.cmdId}\t${l.deliveryStatus}\t${l.relayRecordId ?? '-'}\t${l.goal}`);
    }
  } else {
    console.log('\n  ✅ 无存量泄漏，可直接部署（部署当刻请重跑本脚本确认仍为 0）。');
  }
}

// sent_unconfirmed 需人工清理 → 退 2；仅 pending（兜底硬闭环）或全清 → 0。
process.exit(sentUnconfirmed.length > 0 ? 2 : 0);

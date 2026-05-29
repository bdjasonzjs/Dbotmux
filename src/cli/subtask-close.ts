/**
 * 2026-05-29 — CLI `botmux subtask-close`: 关闭一个在跟的子群任务。
 *
 * 主体确认某子群任务彻底完事 (或松松说关掉) 时调 → closeWatch → 移出主体的
 * 「在跟列表」, 缇蕾也不再盯。纯 IPC 薄壳 (不 import store), 打 claude daemon。
 *
 * 用法:
 *   botmux subtask-close --chat-id oc_xxx [--by claude|jason] [--note "原因"]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REGISTRY_DIR = join(homedir(), '.botmux', 'data', 'dashboard-daemons');
const CLAUDE_BOT_NAME_ZH = '克劳德';

interface DaemonInfoFile { botName: string; ipcPort: number; lastHeartbeat: number; }

function findMainBotDaemonPort(): number | null {
  let files: string[];
  try { files = readdirSync(REGISTRY_DIR).filter(f => f.endsWith('.json')); }
  catch { return null; }
  const now = Date.now();
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(join(REGISTRY_DIR, f), 'utf-8')) as DaemonInfoFile;
      if (d.botName !== CLAUDE_BOT_NAME_ZH) continue;
      if (now - d.lastHeartbeat > 90_000) continue;
      return d.ipcPort;
    } catch { /* skip */ }
  }
  return null;
}

export async function cmdSubtaskClose(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.error(`botmux subtask-close — 关闭一个在跟的子群任务 (移出主体在跟列表)

用法:
  botmux subtask-close --chat-id oc_xxx [--by claude|jason] [--note "原因"]

参数:
  --chat-id <oc_xxx>   必传, 要关闭的子群 chatId (主体 active_subtasks 列表里有)
  --by <who>           可选, 谁关的 (审计用), 默认 claude
  --note "<text>"      可选, 关闭说明

行为: POST claude daemon /api/subtask-close → closeWatch(chatId)。
exit 0 ok / 1 失败 / 2 用法错。`);
    process.exit(0);
  }

  let chatId = '', by = 'claude', note: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i], next = argv[i + 1];
    switch (a) {
      case '--chat-id': chatId = next; i += 2; break;
      case '--by': by = next; i += 2; break;
      case '--note': note = next; i += 2; break;
      default: console.error(`❌ 未知参数: ${a}`); process.exit(2);
    }
  }
  if (!chatId) { console.error('❌ 缺 --chat-id'); process.exit(2); }

  const port = findMainBotDaemonPort();
  if (!port) { console.error(`❌ 找不到主 bot Claude 的活 daemon`); process.exit(1); }

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/subtask-close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId, by, note }),
    });
  } catch (err: any) {
    console.error(`❌ 连不上 daemon (port ${port}): ${err.message}`);
    process.exit(1);
  }
  const json = await res.json().catch(() => ({ ok: false, error: 'invalid_json_response' }));
  console.log(JSON.stringify(json));
  process.exit(res.ok && (json as any).ok !== false ? 0 : 1);
}

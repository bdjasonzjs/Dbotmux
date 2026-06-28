/**
 * P1 commit #7 — CLI `botmux subtask-create`: 主 bot 调子任务的入口
 * 薄壳。
 *
 * 职责（spec v0.4.1 §4 + §6.5）：
 *   1. parse args
 *   2. 取 sessionId（顺序: --session-id flag > env BOTMUX_SESSION_ID;
 *      都缺 → exit 2）
 *   3. 从 dashboard-daemons 注册表查 Claude bot daemon 的 ipcPort
 *   4. POST `http://127.0.0.1:<port>/api/spawn-subtask` with body
 *   5. stdout 透传 daemon 返 JSON；exit 0/1 按 ok 字段
 *
 * 架构契约（妹妹 review v0.2 #3，验在 commit #7 CL-5）：
 *   - 此文件 **绝不** import `spawn-idempotency-store` / `group-creator` /
 *     `main-bot-playbook`. CLI 子进程并发同 key 时各自内存锁挡不住跨进程
 *     race；必须串到单 daemon 进程的 inflight Map 才能真去重。
 *   - 因此 CLI 是纯 IPC 客户端薄壳。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveSessionId } from './session-marker.js';

// Type-only import OK (compiled away — does not violate import contract).
// Used purely for shape of the request body.
import type { SpawnSubTaskRequest } from '../core/main-bot-playbook.js';

const REGISTRY_DIR = join(homedir(), '.botmux', 'data', 'dashboard-daemons');
const CLAUDE_BOT_NAME_ZH = '克劳德';  // bots.json display name for main bot

interface DaemonInfoFile {
  larkAppId: string;
  botName: string;
  ipcPort: number;
  pid: number;
  startedAt: number;
  lastHeartbeat: number;
}

interface SubtaskCreateArgs {
  sessionId: string;
  purpose: string;
  taskType: 'prd' | 'bug' | 'misc';
  bots?: string[];           // c,k,t shorthand resolved later
  relatedRefs?: string[];
  parentDigest?: string;
  name?: string;
}

function findMainBotDaemonPort(): number | null {
  let files: string[];
  try {
    files = readdirSync(REGISTRY_DIR).filter(f => f.endsWith('.json'));
  } catch {
    return null;
  }
  const STALE_MS = 90_000;
  const now = Date.now();
  const fresh: DaemonInfoFile[] = [];
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(join(REGISTRY_DIR, f), 'utf-8')) as DaemonInfoFile;
      if (now - d.lastHeartbeat > STALE_MS) continue;
      fresh.push(d);
    } catch { /* skip corrupt file */ }
  }
  const envAppId = process.env.LARK_APP_ID;
  if (envAppId) {
    const own = fresh.find(d => d.larkAppId === envAppId);
    if (own) return own.ipcPort;
  }
  return fresh.find(d => d.botName === CLAUDE_BOT_NAME_ZH)?.ipcPort ?? null;
}

function parseArgs(argv: string[]): SubtaskCreateArgs | { error: string } {
  const args: Partial<SubtaskCreateArgs> = {};
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--session-id': args.sessionId = next; i += 2; break;
      case '--purpose':    args.purpose = next; i += 2; break;
      case '--task-type':
        if (next !== 'prd' && next !== 'bug' && next !== 'misc') {
          return { error: `--task-type 必须是 prd|bug|misc，got: ${next}` };
        }
        args.taskType = next;
        i += 2;
        break;
      case '--bots':       args.bots = next.split(',').map(s => s.trim()); i += 2; break;
      case '--related-refs':
        args.relatedRefs = next.split(',').map(s => s.trim()); i += 2; break;
      case '--parent-digest': args.parentDigest = next; i += 2; break;
      case '--name':       args.name = next; i += 2; break;
      default:
        return { error: `未知参数: ${a}` };
    }
  }
  // sessionId precedence: flag > 进程树 marker(真值) > env BOTMUX_SESSION_ID(legacy 兜底)。
  // 不再只信易残留旧值的 env —— 根治「daemon/会话重启后 env 指错群、子任务汇报发错群」。
  if (!args.sessionId) {
    args.sessionId = resolveSessionId() ?? undefined;
  }
  if (!args.sessionId) {
    return { error: 'missing session id (expected --session-id <sid>; 通常由进程树 marker 或 env BOTMUX_SESSION_ID 自动解析)' };
  }
  if (!args.purpose) return { error: '缺 --purpose' };
  if (!args.taskType) return { error: '缺 --task-type' };
  return args as SubtaskCreateArgs;
}

const BOT_KEY_SHORT: Record<string, 'claude' | 'codex' | 'tilly'> = {
  c: 'claude', claude: 'claude',
  k: 'codex',  codex: 'codex',  // k for 蔻黛克斯
  t: 'tilly',  tilly: 'tilly',
};

function resolveBotKeys(refs?: string[]): Array<'claude' | 'codex' | 'tilly'> | undefined {
  if (!refs || refs.length === 0) return undefined;
  return refs.map(r => {
    const key = BOT_KEY_SHORT[r.toLowerCase()];
    if (!key) throw new Error(`unknown bot ref: ${r} (use c|k|t or claude|codex|tilly)`);
    return key;
  });
}

export async function cmdSubtaskCreate(argv: string[]): Promise<void> {
  const showHelp = argv.length === 0 || argv.includes('--help') || argv.includes('-h');
  if (showHelp) {
    console.error(`botmux subtask-create — main-bot 拉子群派活

用法:
  botmux subtask-create [--session-id <sid>] --purpose "<任务>" --task-type prd|bug|misc
                        [--bots c,k,t] [--related-refs url1,url2]
                        [--parent-digest "文本"] [--name "群名"]

参数:
  --session-id <sid>     可选，runtime spawn worker 时通常会注入 env BOTMUX_SESSION_ID；
                         此 flag 用于调试 / 测试 override。两者都缺则 exit 2。
  --purpose "<task>"     必传，一句话任务描述
  --task-type            必传，prd|bug|misc 三选一
  --bots                 可选，逗号分隔 c|k|t 或 claude|codex|tilly，默认全拉三 bot
  --related-refs         可选，逗号分隔 PRD/wiki/ticket 链接
  --parent-digest        可选，父群 24h 摘要文本
  --name                 可选，群名 override；不传则自动生成

行为:
  1. 取 sessionId（flag 优先于 env）
  2. 从 ~/.botmux/data/dashboard-daemons/ 找 botName="克劳德" 的活 daemon 端口
  3. POST 127.0.0.1:<port>/api/spawn-subtask  body=SpawnSubTaskRequest
  4. stdout 透传 daemon 返 JSON；exit 0 ok / 1 daemon 拒绝 / 2 用法错

权限：daemon 端 authzCheck 反查 session 真凭证（chatId=mainTopic +
larkAppId=Claude），CLI 任何参数不能伪造 authority。

架构契约：CLI 是纯 IPC 客户端，**不 import** group-creator / main-bot-playbook /
spawn-idempotency-store —— 多进程并发同 key 必经单 daemon inflight Map 真去重。`);
    process.exit(argv.length === 0 ? 0 : 0);
  }

  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    console.error(`❌ ${parsed.error}`);
    process.exit(2);
  }

  let botKeys: Array<'claude' | 'codex' | 'tilly'> | undefined;
  try {
    botKeys = resolveBotKeys(parsed.bots);
  } catch (err: any) {
    console.error(`❌ ${err.message}`);
    process.exit(2);
  }

  const port = findMainBotDaemonPort();
  if (!port) {
    console.error(`❌ 找不到主 bot Claude 的活 daemon（${REGISTRY_DIR} 里没有 botName=克劳德 的新鲜注册）。daemon 跑了吗？`);
    process.exit(1);
  }

  const body: SpawnSubTaskRequest = {
    sessionId: parsed.sessionId,
    purpose: parsed.purpose,
    taskType: parsed.taskType,
    bots: botKeys,
    relatedRefs: parsed.relatedRefs,
    parentDigest: parsed.parentDigest,
    name: parsed.name,
  };
  // Strip undefined for clean JSON
  for (const k of Object.keys(body) as (keyof typeof body)[]) {
    if (body[k] === undefined) delete (body as any)[k];
  }

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/spawn-subtask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    console.error(`❌ 连不上 daemon (port ${port}): ${err.message}`);
    process.exit(1);
  }

  const json = await res.json().catch(() => ({ ok: false, error: 'invalid_json_response' }));
  console.log(JSON.stringify(json));
  process.exit(res.ok && (json as any).ok !== false ? 0 : 1);
}

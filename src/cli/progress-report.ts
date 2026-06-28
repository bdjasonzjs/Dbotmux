/**
 * P2 commit #5 — CLI `botmux progress-report`: 主 bot 在子群完成阶段
 * 进展（或求决策）时调，把卡片汇报到主话题。
 *
 * 架构契约（同 subtask-create 一样）：CLI 是纯 IPC 客户端，不 import
 * service 层，所有真凭证 / 幂等 / 模板都在 daemon 侧 (publisher)。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveSessionId } from './session-marker.js';

const REGISTRY_DIR = join(homedir(), '.botmux', 'data', 'dashboard-daemons');
const DATA_DIR = join(homedir(), '.botmux', 'data');
const CLAUDE_BOT_NAME_ZH = '克劳德';

interface DaemonInfoFile {
  larkAppId: string; botName: string; ipcPort: number; pid: number;
  startedAt: number; lastHeartbeat: number;
}

interface Args {
  sessionId: string;
  summary: string;
  slug: string;
  kind: 'progress' | 'request_decision';
  subChatName?: string;
  // P2-rev1 #4 (妹妹 review): `--sub-chat-id` flag removed. subChatId is
  // always derived from session.chatId in the daemon (真凭证); CLI can't
  // pass arbitrary chat ids to ghost-report on behalf of unrelated chats.
}

function parseArgs(argv: string[]): Args | { error: string } {
  const a: Partial<Args> = { kind: 'progress' };
  let i = 0;
  while (i < argv.length) {
    const cur = argv[i]; const next = argv[i + 1];
    switch (cur) {
      case '--session-id':   a.sessionId = next; i += 2; break;
      case '--summary':      a.summary = next; i += 2; break;
      case '--slug':         a.slug = next; i += 2; break;
      case '--kind':
        if (next !== 'progress' && next !== 'request_decision') {
          return { error: `--kind 必须 progress|request_decision，got: ${next}` };
        }
        a.kind = next; i += 2; break;
      case '--sub-chat-name': a.subChatName = next; i += 2; break;
      default: return { error: `未知参数: ${cur}` };
    }
  }
  // flag 缺省 → 进程树 marker(真值) > env BOTMUX_SESSION_ID(legacy)。根治 stale-env 错群。
  if (!a.sessionId) a.sessionId = resolveSessionId() ?? undefined;
  if (!a.sessionId) return { error: 'missing session id (expected --session-id; 通常由进程树 marker / BOTMUX_SESSION_ID 自动解析)' };
  if (!a.summary) return { error: '缺 --summary' };
  if (!a.slug)    return { error: '缺 --slug (stable dedup key, e.g. "milestone-1" / "auth-design-q1")' };
  return a as Args;
}

function findSessionLarkAppId(sessionId: string): string | null {
  let files: string[];
  try { files = readdirSync(DATA_DIR).filter(f => f.startsWith('sessions-') && f.endsWith('.json')); }
  catch { return null; }
  for (const f of files) {
    try {
      const sessions = JSON.parse(readFileSync(join(DATA_DIR, f), 'utf-8')) as Record<string, { larkAppId?: string }>;
      const appId = sessions?.[sessionId]?.larkAppId;
      if (appId) return appId;
    } catch { /* skip */ }
  }
  return null;
}

function findMainBotDaemonPort(sessionId: string): number | null {
  let files: string[];
  try { files = readdirSync(REGISTRY_DIR).filter(f => f.endsWith('.json')); }
  catch { return null; }
  const now = Date.now(); const STALE = 90_000;
  const fresh: DaemonInfoFile[] = [];
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(join(REGISTRY_DIR, f), 'utf-8')) as DaemonInfoFile;
      if (now - d.lastHeartbeat > STALE) continue;
      fresh.push(d);
    } catch { /* skip */ }
  }
  const envAppId = process.env.LARK_APP_ID;
  if (envAppId) {
    const own = fresh.find(d => d.larkAppId === envAppId);
    if (own) return own.ipcPort;
  }
  const sessionAppId = findSessionLarkAppId(sessionId);
  if (sessionAppId) {
    const own = fresh.find(d => d.larkAppId === sessionAppId);
    if (own) return own.ipcPort;
  }
  return fresh.find(d => d.botName === CLAUDE_BOT_NAME_ZH)?.ipcPort ?? null;
}

export async function cmdProgressReport(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.error(`botmux progress-report — 子群进展/决策请求汇报到主话题

用法:
  botmux progress-report [--session-id <sid>]
                          --summary "<一句话>"
                          --slug <stable-key>
                          [--kind progress|request_decision]   # default progress
                          [--sub-chat-name "<群名>"]              # human label cached on card

dedup: 同 kind+sub-chat+slug 第二次调用 → 编辑同张主话题卡（不刷屏）。
切到 --kind request_decision 给松松一张「❓ 需要决策」卡。`);
    process.exit(argv.length === 0 ? 0 : 0);
  }

  const parsed = parseArgs(argv);
  if ('error' in parsed) { console.error(`❌ ${parsed.error}`); process.exit(2); }

  const port = findMainBotDaemonPort(parsed.sessionId);
  if (!port) { console.error(`❌ 找不到当前 session 所属 daemon（${REGISTRY_DIR} 里没新鲜注册）`); process.exit(1); }

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/progress-report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed),
    });
  } catch (err: any) { console.error(`❌ 连不上 daemon: ${err.message}`); process.exit(1); }

  const json = await res.json().catch(() => ({ ok: false, error: 'invalid_json_response' }));
  console.log(JSON.stringify(json));
  process.exit(res.ok && (json as any).ok !== false ? 0 : 1);
}

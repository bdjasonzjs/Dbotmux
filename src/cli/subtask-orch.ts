/**
 * CLI `botmux subtask-{start,report,query,finish,supplement}` — 子任务编排 v2 薄壳
 * (Phase 4)。纯 IPC 客户端：解析 args → POST 到 Claude daemon 的 /api/subtask-orch-* →
 * 透传 JSON。鉴权/幂等/版本全在 daemon service 侧 (authzCheck/session-store 反查，CLI 不能伪造)。
 *
 * sessionId 取自 --session-id 或 env BOTMUX_SESSION_ID (runtime spawn worker 时注入)。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REGISTRY_DIR = join(homedir(), '.botmux', 'data', 'dashboard-daemons');
const CLAUDE_BOT_NAME_ZH = '克劳德';

interface DaemonInfoFile { botName: string; ipcPort: number; lastHeartbeat: number; }

const VERB_ROUTE: Record<string, string> = {
  start: '/api/subtask-orch-create',
  report: '/api/subtask-orch-report',
  query: '/api/subtask-orch-query',
  finish: '/api/subtask-orch-finish',
  supplement: '/api/subtask-orch-supplement',
  askforhelp: '/api/subtask-orch-askforhelp',
  'request-review': '/api/subtask-orch-request-review',
  // 双层汇报 v6（经理汇报制度）：
  'manager-report': '/api/subtask-orch-manager-report',
  'request-report': '/api/subtask-orch-request-report',
  'inbox-list': '/api/subtask-orch-inbox-list',
  'inbox-read': '/api/subtask-orch-inbox-read',
  managers: '/api/subtask-orch-managers',
};
const NUM_FLAGS = new Set(['expectedVersion', 'limit']);
const LIST_FLAGS = new Set(['bots', 'sourceMessageIds', 'relatedRefs', 'ids']);
const BOOL_FLAGS = new Set(['force', 'spawnable', 'cascade', 'manager', 'noObserver', 'unreadOnly', 'withBody']);
// 注：bot 简写 c/k/t → claude|codex|tilly 的归一化已下沉到 orchestrator（N-bot ref 解析，
// 支持 ref:role 后缀 + 分身 name/appId）。CLI 侧不再做映射，--bots 原样透传。


function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export function findClaudeDaemonPort(): number | null {
  let files: string[];
  try { files = readdirSync(REGISTRY_DIR).filter(f => f.endsWith('.json')); }
  catch { return null; }
  const now = Date.now(); const STALE = 90_000;
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(join(REGISTRY_DIR, f), 'utf-8')) as DaemonInfoFile;
      if (d.botName !== CLAUDE_BOT_NAME_ZH) continue;
      if (now - d.lastHeartbeat > STALE) continue;
      return d.ipcPort;
    } catch { /* skip corrupt */ }
  }
  return null;
}

function parseBody(argv: string[]): { body: Record<string, unknown> } | { error: string } {
  const body: Record<string, unknown> = {};
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (!a.startsWith('--')) return { error: `unexpected arg: ${a}` };
    const key = kebabToCamel(a.slice(2));
    if (BOOL_FLAGS.has(key)) { body[key] = true; i += 1; continue; } // boolean flag, 无 value
    const val = argv[i + 1];
    if (val === undefined) return { error: `missing value for ${a}` };
    if (NUM_FLAGS.has(key)) body[key] = Number(val);
    else if (LIST_FLAGS.has(key)) body[key] = val.split(',').map(s => s.trim()).filter(Boolean);
    else body[key] = val;
    i += 2;
  }
  // N-bot: pass --bots entries through verbatim. The orchestrator resolves each
  // ref (alias c/k/t/claude/codex/tilly, or any registered bot name/appId) and
  // parses an optional `ref:role` suffix; unknown ref / bad role → 400 there.
  // So `--bots claude:main,克隆2:collab` flows straight through.
  if (!body.sessionId) body.sessionId = process.env.BOTMUX_SESSION_ID;
  if (!body.sessionId) return { error: 'missing --session-id <sid> or env BOTMUX_SESSION_ID' };
  return { body };
}

const HELP = `botmux subtask-{start|report|query|finish|supplement} — 子任务编排 v2

  subtask-start      --goal "<任务>" [--acceptance "<验收>"] [--bots <ref>[:role],...]
                     [--task-type prd|bug|misc] [--name "<群名>"] [--related-refs a,b]
    --bots  逗号分隔；每项 <ref>[:role]。ref = c|k|t / claude|codex|tilly / 已注册 bot 的 name 或 appId（含分身）。
            role ∈ main|collab|observer（省略走默认：内建 bot 保留原角色，其它默认 collab）。默认全拉三 bot。
                     [--spawnable]  (授权新子群可再派孙群；默认关，create 一锤定音)
                     [--no-observer] (显式 opt-out：executor 群即使含 main 也不自动补 t:observer)
                     [--manager]    (部门经理子群：只真紧急才实时推、其余定期 digest；默认 executor 实时直报)
  subtask-report     --task-id <id> --type need_help|done --summary "<一句话>" [--source-message-ids m1,m2]
  subtask-query      (--task-id <id> | --command-id <id>)
  subtask-finish     --task-id <id> --expected-version <n> [--note "<说明>"] [--force]
                     [--cascade]  (存在 ACTIVE 子任务时级联自底向上收尾；不带则 409 列清单)
  subtask-supplement --task-id <id> --content "<补充>" --expected-version <n> [--force]
                     [--target-role main|reviewer|all]  (缺省 main：普通补充给执行者)
                     (expected-version 默认必传守 stale；人工强制结束/补充才加 --force)
  subtask-askforhelp --task-id <id> --summary "<卡在哪/需要什么>" [--source-message-ids m1,m2]
                     (子群执行 bot 向主 bot 求助：写求助进 store，由 coco 触发急急如律令唤主 bot)
  subtask-request-review --task-id <id> --summary "<可打开的飞书链接/本机绝对路径>" [--source-message-ids m1,m2]
                     (执行者产出后唤起 reviewer；只能从子群、由执行者(main)调；summary 必须含可打开链接/绝对路径)

  —— 双层汇报 v6（经理汇报制度）——
  subtask-manager-report --task-id <id> --summary "<一行进展>" [--body "<详情>"]
                     [--urgency normal|urgent] [--reason "<urgent 必填理由>"] [--report-kind scheduled|manual|requested|urgent]
                     (manager 子群 main 调：写汇报邮件进 CEO 收件箱。normal 不唤醒；urgent **必须带 --reason**，否则 400)
  subtask-request-report --task-id <id> [--note "<想看什么>"]
                     (CEO=父群 orchestrator 调：命令该经理立即产一封 digest 邮件进收件箱)
  subtask-inbox-list   [--unread-only] [--since <ISO>] [--limit <n>] [--with-body]
                     (列调用者自己群的收件箱；reader=自己，只看投给自己群+自己的邮件)
  subtask-inbox-read   --ids id1,id2   (标自己收件箱里若干邮件已读，per-reader)

通用: [--session-id <sid>]（缺省取 env BOTMUX_SESSION_ID）。
鉴权/幂等/版本在 daemon service 侧；CLI 仅透传。`;

export async function cmdSubtaskOrch(verb: string, argv: string[]): Promise<void> {
  const route = VERB_ROUTE[verb];
  if (!route || argv.includes('--help') || argv.includes('-h')) {
    console.error(HELP);
    process.exit(route ? 0 : 2);
  }

  const parsed = parseBody(argv);
  if ('error' in parsed) { console.error(`❌ ${parsed.error}`); process.exit(2); }

  const port = findClaudeDaemonPort();
  if (!port) { console.error(`❌ 找不到 Claude daemon（${REGISTRY_DIR} 无新鲜注册）`); process.exit(1); }

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed.body),
    });
  } catch (err: any) { console.error(`❌ 连不上 daemon (port ${port}): ${err.message}`); process.exit(1); }

  const json = await res.json().catch(() => ({ ok: false, error: 'invalid_json_response' }));
  console.log(JSON.stringify(json));
  process.exit(res.ok && (json as any).ok !== false ? 0 : 1);
}

// 任务小组 · CLI 命令族（v3.1 §5）——纯 IPC 客户端：解析 args → POST 到 Claude daemon 的 /api/taskteam-* → 打印结果。
// 复用 subtask-orch 的 daemon 解析（findClaudeDaemonPort）。结构化负载（角色/规则/类型/模板/快照/事件）走 --json / --file。
// P1 修复：按 verb 把裸对象包进 IPC envelope（role/rule/teamType/org/bundle/snapshot/event），与 admin/daemon 端 body 合约一致。

import { readFileSync } from 'node:fs';
import { findClaudeDaemonPort } from './subtask-orch.js';

const ROUTES: Record<string, string> = {
  types: '/api/taskteam-types',
  'config-list': '/api/taskteam-config-list',
  'role-upsert': '/api/taskteam-role-upsert',
  'rule-upsert': '/api/taskteam-rule-upsert',
  'type-upsert': '/api/taskteam-type-upsert',
  'org-upsert': '/api/taskteam-org-upsert',
  'template-export': '/api/taskteam-template-export',
  'template-import': '/api/taskteam-template-import',
  'snapshot-export': '/api/taskteam-snapshot-export',
  'snapshot-restore': '/api/taskteam-snapshot-restore',
  create: '/api/taskteam-create-from-template',
  'raw-create': '/api/taskteam-create',
  event: '/api/taskteam-event',
  onboard: '/api/taskteam-onboard',
};

// 结构化对象（--json/--file 解析结果）要包进的 IPC envelope key（与 admin/daemon body 合约一致）。
// 不在表内的 verb（create / *-export / config-list）走裸 merge / 空 body。
const ENVELOPE: Record<string, string> = {
  'role-upsert': 'role',
  'rule-upsert': 'rule',
  'type-upsert': 'teamType',
  'org-upsert': 'org',
  'template-import': 'bundle',
  'snapshot-restore': 'snapshot',
  event: 'event',
};

const HELP = `botmux taskteam-* — 任务小组 CLI（§5）。结构化对象传裸 JSON，CLI 自动包进 IPC 字段。
  taskteam-types                                   列出可创建的小组类型、slot、可用 bot ref
  taskteam-config-list                             列出角色/规则/类型/组织配置
  taskteam-role-upsert    --json '<TaskTeamRole>'        增改角色（或 --file x.json）→ {role}
  taskteam-rule-upsert    --json '<CollabRule>'          增改协作规则 → {rule}
  taskteam-type-upsert    --json '<TaskTeamType>'        增改小组类型 → {teamType}
  taskteam-org-upsert     --json '<OrgStructureShape>'   增改组织结构(shape) → {org}
  taskteam-template-export                          导出可分享 TemplateBundle（无 app 身份）
  taskteam-template-import --file bundle.json        导入 TemplateBundle → {bundle}（导入后须重选 creator app + 重绑 bot）
  taskteam-snapshot-export                           导出同环境 InstanceSnapshot（含运行态）
  taskteam-snapshot-restore --file snap.json         恢复 InstanceSnapshot → {snapshot}
  taskteam-create         --type-id <type> --slot <slot=bot> --goal "..." [--target-external-chat-id oc_x]
                                                    按模板建小组（server 解析 bot openId + 校验 slot + 拉 owner）
  taskteam-raw-create     --json '<CreateTaskTeamParams>'  高级接口：手写 roleInstances（不作为 bot 默认路径）
  taskteam-event          --team-id <id> --json '<TeamEvent>'  注入事件 → {teamId, event}
  通用：--json '<内联 JSON>' | --file <路径> | --k v（简单字段，自动 kebab→camel，放顶层）
  create 示例：
    botmux taskteam-types
    botmux taskteam-create --type-id tt_type_two_layer_review \\
      --slot tt_slot_developer_main=claude --slot tt_slot_architect_main=codex \\
      --slot tt_slot_detail_reviewer_main=k --slot tt_slot_observer_main=t \\
      --goal "实现 X" --target-external-chat-id oc_xxx`;

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// 解析 args：--json/--file 合并为 structured（结构化对象），其余 --k v 为顶层 flags。
function setFlag(flags: Record<string, unknown>, key: string, val: unknown): void {
  if (key === 'slot') {
    const prev = flags[key];
    flags[key] = Array.isArray(prev) ? [...prev, val] : prev === undefined ? [val] : [prev, val];
    return;
  }
  flags[key] = val;
}

function parseArgs(argv: string[]): { structured: Record<string, unknown> | undefined; flags: Record<string, unknown> } {
  let structured: Record<string, unknown> | undefined;
  const flags: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; ) {
    const a = argv[i];
    if (a === '--json') { structured = { ...(structured ?? {}), ...JSON.parse(argv[i + 1]) }; i += 2; continue; }
    if (a === '--file') { structured = { ...(structured ?? {}), ...JSON.parse(readFileSync(argv[i + 1], 'utf-8')) }; i += 2; continue; }
    if (a?.startsWith('--')) {
      const key = kebabToCamel(a.slice(2));
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) { setFlag(flags, key, true); i += 1; }
      else { setFlag(flags, key, val); i += 2; }
      continue;
    }
    i += 1;
  }
  return { structured, flags };
}

function normalizeCreateBody(body: Record<string, unknown>): Record<string, unknown> {
  const next = { ...body };
  if (next.type && !next.typeId) {
    next.typeId = next.type;
    delete next.type;
  }
  const slots = next.slot;
  delete next.slot;
  if (slots !== undefined) {
    const selected = { ...((next.selectedBotBySlot as Record<string, string> | undefined) ?? {}) };
    for (const item of Array.isArray(slots) ? slots : [slots]) {
      if (typeof item !== 'string') continue;
      const idx = item.indexOf('=');
      if (idx <= 0) throw new Error(`invalid --slot "${item}", expected <slotId-or-label>=<bot-ref>`);
      selected[item.slice(0, idx)] = item.slice(idx + 1);
    }
    next.selectedBotBySlot = selected;
  }
  return next;
}

/** 纯函数：把 verb + argv 构造成 { path, body }，body 已按 verb 包进正确 IPC envelope。可单测的 CLI→IPC 合约。 */
export function buildTaskTeamRequest(
  verb: string,
  argv: string[],
): { path: string; body: Record<string, unknown> } | { error: string } {
  const path = ROUTES[verb];
  if (!path) return { error: `unknown taskteam verb: ${verb}` };
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    return { error: `invalid taskteam arguments: ${err instanceof Error ? err.message : String(err)}` };
  }
  const { structured, flags } = parsed;
  const envelopeKey = ENVELOPE[verb];
  let body: Record<string, unknown>;
  if (envelopeKey) {
    // 结构化对象包进 envelope key；简单 flags（如 event 的 --team-id）放顶层
    body = { ...flags };
    if (structured !== undefined) body[envelopeKey] = structured;
  } else {
    // create / *-export / config-list：裸 merge（结构化 + flags 都到顶层）
    body = { ...flags, ...(structured ?? {}) };
  }
  if (verb === 'create') {
    try {
      body = normalizeCreateBody(body);
    } catch (err) {
      return { error: `invalid taskteam-create arguments: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { path, body };
}

export async function cmdTaskTeam(verb: string, argv: string[]): Promise<void> {
  if (verb === 'help' || argv.includes('--help')) { console.log(HELP); return; }
  const built = buildTaskTeamRequest(verb, argv);
  if ('error' in built) { console.error(`${built.error}\n${HELP}`); process.exitCode = 1; return; }

  const port = findClaudeDaemonPort(process.env.BOTMUX_SESSION_ID);
  if (!port) { console.error('no live Claude daemon found (is the daemon running?)'); process.exitCode = 1; return; }

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}${built.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(built.body),
    });
  } catch (err) {
    console.error(`daemon request failed: ${String(err)}`);
    process.exitCode = 1;
    return;
  }
  const text = await res.text();
  console.log(text);
  if (!res.ok) process.exitCode = 1;
}

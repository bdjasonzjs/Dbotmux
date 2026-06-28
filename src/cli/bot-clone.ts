/**
 * `botmux bot clone <source>` — clone an existing bot via QR scan.
 *
 * Terminal path: shows the device-flow QR in this terminal, then writes the
 * clone to bots.json with an isolated home. Trust = host shell access (owner
 * gate per 方案 owner-model B). Does NOT regenerate the ecosystem or start the
 * new daemon — that's a later, separately-gated step.
 */
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import type { BotConfig } from '../bot-registry.js';
import { readBotsJsonOrEmpty } from '../setup/bots-store.js';
import { parseBotSelection } from '../setup/bot-config-editor.js';
import { defaultBotsJsonPath } from '../services/bot-inventory.js';
import { cloneBot } from '../services/bot-clone.js';
import { findClaudeDaemonPort } from './subtask-orch.js';
import { resolveSessionId } from './session-marker.js';

export async function cmdBot(sub: string, args: string[]): Promise<void> {
  if (sub === 'ceo-spawn') { await cmdBotCeoSpawn(args); return; }
  if (sub !== 'clone') {
    console.error(`unknown bot subcommand: "${sub}" (supported: clone | ceo-spawn)`);
    process.exit(1);
  }

  const sourceRef = args.find(a => !a.startsWith('-'));
  if (!sourceRef) {
    console.error('usage: botmux bot clone <source bot: name | appId | botmux-<index>>');
    process.exit(1);
  }

  const botsJsonPath = defaultBotsJsonPath();
  // Derive the config dir from the active registry's directory so the clone's
  // isolated home lands beside the bots.json it's registered in (honours
  // BOTS_CONFIG), not always under ~/.botmux.
  const configDir = dirname(botsJsonPath);
  const bots = readBotsJsonOrEmpty(botsJsonPath);
  const idx = parseBotSelection(sourceRef, bots);
  if (idx === undefined) {
    console.error(`source bot not found in ${botsJsonPath}: "${sourceRef}"`);
    process.exit(1);
  }
  const sourceBot = bots[idx] as BotConfig;

  console.error(`正在克隆 bot「${(sourceBot as any).name ?? sourceBot.larkAppId}」(cli: ${sourceBot.cliId ?? 'claude-code'})…`);
  console.error('请用飞书 App 扫码创建分身（二维码见下方）。');

  // sourceClaudeHome omitted → cloneBot derives it engine-aware (Round-4 B4).
  const result = await cloneBot({ sourceBot, configDir, botsJsonPath });
  if (!result.ok) {
    console.error(`❌ clone 失败: ${result.error} — ${result.message}`);
    process.exit(1);
  }

  // stdout = machine-readable result (no secret); stderr = human hints.
  console.log(JSON.stringify({
    ok: true,
    appId: result.appId,
    name: result.slug,
    claudeConfigDir: result.claudeConfigDir,
    botIndex: result.botIndex,
  }, null, 2));
  console.error(`✅ 已克隆 bot：${result.slug} (${result.appId})，bots.json 索引 ${result.botIndex}。`);
  console.error('注意：新 bot 尚未生效 —— 需重生成 ecosystem 并仅启动新进程（不会重启现有 daemon）；该步骤单独执行。');
}

const CEO_SPAWN_HELP = `botmux bot ceo-spawn — CEO 端到端建群编排（聊天里由 CEO 克劳德调用）

  --goal "<任务目标>"                       必填
  --seats <seat>[,<seat>...]                席位：每项 <role> / auto:<role>（claude 自动席，本体或克隆）
                                            或 <ref>:<role>（指定已注册 bot）。role ∈ main|collab|observer。
                                            缺省 = "auto:main,auto:collab"（worker 本体 + reviewer 克隆）。
  --activation-approved <appId>             松松已批准激活该克隆（部署门控）才传；daemon 侧再做 owner-scope 校验。
  --source-description "<描述>"             源配置无可信描述时，用该描述预填新 clone 应用描述；未提供则完整性 gate 阻断。
  [--session-id <sid>]                      缺省取 env BOTMUX_SESSION_ID。

返回 outcome JSON：spawned / awaiting_activation / awaiting_openid / refused / error。
鉴权（owner）+ 激活部署门控都在 daemon service 侧（session 反查，CLI 不能伪造）。`;

/**
 * Parse `bot ceo-spawn` argv into the daemon request body. Exported + pure so
 * the CLI↔service field contract is unit-tested (a name mismatch here silently
 * drops a field — e.g. `--activation-approved` must land as the field ceoSpawn
 * actually reads, `activationApprovedAppId`, not the auto-camelCased name).
 */
export function parseCeoSpawnArgs(args: string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) throw new Error(`unexpected arg: ${a}`);
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const val = args[++i];
    if (val === undefined) throw new Error(`missing value for ${a}`);
    if (key === 'seats') body.seats = val.split(',').map(s => s.trim()).filter(Boolean);
    // `--activation-approved <appId>` → the field ceoSpawn reads.
    else if (key === 'activationApproved') body.activationApprovedAppId = val;
    else body[key] = val;
  }
  return body;
}

async function cmdBotCeoSpawn(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.error(CEO_SPAWN_HELP); process.exit(0); }
  let body: Record<string, unknown>;
  try { body = parseCeoSpawnArgs(args); }
  catch (err: any) { console.error(`❌ ${err?.message ?? err}`); process.exit(2); }
  if (!body.goal) { console.error('❌ missing --goal'); process.exit(2); }
  // flag 缺省 → 进程树 marker(真值) > env BOTMUX_SESSION_ID(legacy)。根治 stale-env 错群。
  if (!body.sessionId) body.sessionId = resolveSessionId() ?? undefined;
  if (!body.sessionId) { console.error('❌ missing --session-id <sid> (进程树 marker / env BOTMUX_SESSION_ID 均无)'); process.exit(2); }

  const port = findClaudeDaemonPort();
  if (!port) { console.error('❌ 找不到 Claude daemon（无新鲜注册）'); process.exit(1); }
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/bot-ceo-spawn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch (err: any) { console.error(`❌ 连不上 daemon (port ${port}): ${err.message}`); process.exit(1); }
  const json = await res.json().catch(() => ({ ok: false, error: 'invalid_json_response' }));
  console.log(JSON.stringify(json));
  process.exit(res.ok && (json as any).ok !== false ? 0 : 1);
}

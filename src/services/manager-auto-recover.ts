import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import type { SubTask } from './subtask-store.js';
import type { Session } from '../types.js';

export const MANAGER_AUTO_RECOVER_COOLDOWN_MS = 30 * 60 * 1000;

export type ManagerRecoverReason = 'manager_stalled' | 'manager_session_aged';

export type ManagerAutoRecoverDecision =
  | { kind: 'none'; reason: 'opt_in_disabled' | 'double_check_failed' | 'no_session' | 'cooldown' }
  | { kind: 'recover'; recoverId: string };

export function managerAutoRecoverEnabled(): boolean {
  return process.env.BOTMUX_MANAGER_AUTO_RECOVER === '1';
}

export function planManagerAutoRecover(input: {
  optIn: boolean;
  doubleCheck: boolean;
  sessionId?: string | null;
  lastRecoveredAt?: string | null;
  now: Date;
  cooldownMs?: number;
  recoverId?: string;
}): ManagerAutoRecoverDecision {
  if (!input.optIn) return { kind: 'none', reason: 'opt_in_disabled' };
  if (!input.doubleCheck) return { kind: 'none', reason: 'double_check_failed' };
  if (!input.sessionId) return { kind: 'none', reason: 'no_session' };
  const cooldownMs = input.cooldownMs ?? MANAGER_AUTO_RECOVER_COOLDOWN_MS;
  const lastMs = input.lastRecoveredAt ? new Date(input.lastRecoveredAt).getTime() : NaN;
  if (Number.isFinite(lastMs) && input.now.getTime() - lastMs < cooldownMs) {
    return { kind: 'none', reason: 'cooldown' };
  }
  return { kind: 'recover', recoverId: input.recoverId ?? randomUUID() };
}

export function buildManagerRecoverPrompt(input: {
  task: Pick<SubTask, 'taskId' | 'goal' | 'acceptance' | 'status'>;
  session: Pick<Session, 'sessionId'>;
  reason: ManagerRecoverReason;
  recoverId: string;
}): string {
  return [
    `【botmux manager auto-recover ${input.recoverId}】`,
    `上一条 manager session ${input.session.sessionId} 被判定为 ${input.reason}，botmux 已自动 kill/delete，并用本消息拉起一个干净 session。`,
    `任务ID：${input.task.taskId}`,
    `任务目标：${input.task.goal}`,
    `验收标准：${input.task.acceptance ?? '(未明确)'}`,
    `恢复要求：先用一句话说明已从自动恢复中接管，然后继续处理当前 pending work；不要等待人工再次唤醒。`,
  ].join('\n');
}

export interface RecoverManagerSessionRequest {
  task: SubTask;
  session: Session;
  reason: ManagerRecoverReason;
  recoverId: string;
  prompt: string;
}

export interface RecoverManagerSessionResult {
  ok: boolean;
  oldSessionId: string;
  newSessionId?: string;
  error?: string;
}

interface DaemonDescriptor { larkAppId: string; ipcPort: number; lastHeartbeat?: number }

function descriptorFor(larkAppId: string): DaemonDescriptor | null {
  const dirs = [
    join(config.session.dataDir, 'dashboard-daemons'),
    join(homedir(), '.botmux', 'data', 'dashboard-daemons'),
  ];
  const now = Date.now();
  for (const dir of dirs) {
    const fp = join(dir, `${larkAppId}.json`);
    if (!existsSync(fp)) continue;
    try {
      const d = JSON.parse(readFileSync(fp, 'utf-8')) as DaemonDescriptor;
      if (typeof d.ipcPort !== 'number') continue;
      if (d.lastHeartbeat && now - d.lastHeartbeat > 90_000) continue;
      return d;
    } catch { /* ignore malformed descriptor */ }
  }
  return null;
}

export async function recoverManagerSessionViaDaemon(req: RecoverManagerSessionRequest): Promise<RecoverManagerSessionResult> {
  const larkAppId = req.session.larkAppId ?? req.task.createdByLarkAppId ?? '';
  if (!larkAppId) return { ok: false, oldSessionId: req.session.sessionId, error: 'missing_lark_app_id' };
  const daemon = descriptorFor(larkAppId);
  if (!daemon) return { ok: false, oldSessionId: req.session.sessionId, error: 'daemon_offline' };
  try {
    const res = await fetch(`http://127.0.0.1:${daemon.ipcPort}/api/sessions/${encodeURIComponent(req.session.sessionId)}/manager-recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId: req.task.taskId,
        reason: req.reason,
        recoverId: req.recoverId,
        prompt: req.prompt,
      }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body?.ok) {
      return { ok: false, oldSessionId: req.session.sessionId, error: body?.error ?? `http_${res.status}` };
    }
    return { ok: true, oldSessionId: req.session.sessionId, newSessionId: body.newSessionId };
  } catch (err: any) {
    return { ok: false, oldSessionId: req.session.sessionId, error: err?.message ?? String(err) };
  }
}

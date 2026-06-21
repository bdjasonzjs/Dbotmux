// 任务小组 · 投递 executor（IO 边界）——把一条 outbox 投递命令渲染成消息、发进子群、@ 目标席位的 bot。
// 由 daemon dispatcher cron 注入；纯 tick 逻辑在 taskteam-dispatcher.ts，不依赖此文件。

import { sendMessage } from '../im/lark/client.js';
import { getTaskTeam } from './taskteam-store.js';
import type { TaskTeamDispatchExecutors, TaskTeamSendResult } from './taskteam-dispatcher.js';
import type { TaskTeamAction, TaskTeamId, TaskTeamInstance } from './taskteam-schema.js';

const COMMAND_LABEL: Record<string, string> = {
  kickoff: '开工',
  'request-review': '请评审',
  nudge: '请返工 / 跟进',
  escalate: '上报卡点',
  report: '进度 / 待验收',
  finish: '收尾',
};

export function renderTaskTeamCommand(action: TaskTeamAction, instance: TaskTeamInstance): string {
  const ri = instance.roleInstances.find(r => r.roleInstanceId === action.targetRoleInstanceId);
  const botOpenId = ri?.binding?.botOpenId;
  const mention = botOpenId ? `<at user_id="${botOpenId}"></at> ` : '';
  const label = COMMAND_LABEL[action.actionType] ?? action.actionType;
  const summary = typeof action.payload?.summary === 'string' ? action.payload.summary : '';
  const body = summary ? `：${summary}` : '';
  return `${mention}【任务小组·${label}】${body}`.trim();
}

export function makeTaskTeamDispatchExecutors(senderLarkAppId: string): TaskTeamDispatchExecutors {
  return {
    async send(action: TaskTeamAction): Promise<TaskTeamSendResult> {
      const instance = getTaskTeam(action.teamId);
      if (!instance) return { ok: false, error: `team ${action.teamId} not found`, retriable: false };
      if (!instance.chatId) return { ok: false, error: `team ${action.teamId} has no chatId`, retriable: false };
      try {
        const messageId = await sendMessage(senderLarkAppId, instance.chatId, renderTaskTeamCommand(action, instance));
        return { ok: true, messageId };
      } catch (err) {
        return { ok: false, error: String(err), retriable: true };
      }
    },
    teamVersion(teamId: TaskTeamId): number | null {
      return getTaskTeam(teamId)?.version ?? null;
    },
  };
}

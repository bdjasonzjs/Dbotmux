// 任务小组 · 投递 executor（IO 边界）——把一条 outbox 投递命令渲染成消息、发进子群、@ 目标席位的 bot。
// 由 daemon dispatcher cron 注入；纯 tick 逻辑在 taskteam-dispatcher.ts，不依赖此文件。

import { sendMessage } from '../im/lark/client.js';
import { getTaskTeam } from './taskteam-store.js';
import type { TaskTeamDispatchExecutors, TaskTeamSendResult } from './taskteam-dispatcher.js';
import type { TaskTeamAction, TaskTeamActionSpec, TaskTeamE2eConfig, TaskTeamId, TaskTeamInstance } from './taskteam-schema.js';

const COMMAND_LABEL: Record<string, string> = {
  kickoff: '开工',
  'request-review': '请评审',
  nudge: '请返工 / 跟进',
  escalate: '上报卡点',
  report: '进度 / 待验收',
  finish: '收尾',
  // 阶段2 领域无关动作（§2.3）
  notify: '通知',
  'wake-role': '唤醒角色',
  'route-to-owner': '转交 owner',
};

/** 从 action.payload 取阶段2 的领域无关投递补充语义（engine 写进 payload.__delivery）。无则 undefined。 */
export function deliverySpecOf(action: TaskTeamAction): TaskTeamActionSpec | undefined {
  const d = (action.payload as Record<string, unknown> | undefined)?.__delivery;
  return d && typeof d === 'object' ? (d as TaskTeamActionSpec) : undefined;
}

/**
 * 把实例级 e2e 四项配置渲染成 @豆包M 的「派 e2e」kickoff 文本（tt_type_dev_with_e2e，由 delivery.kind='e2e-kickoff' 触发）。
 * 四项含义见 shared_knowledge `cua/doubao-desktop-e2e-kickoff-template.md`。e2eConfig 缺省时只给通用提示（不编内容）。
 */
// 清洗实例 e2e 文本（来自 dashboard/CLI 的用户输入）：剥控制字符、截断超长，避免影响 Lark 消息展示（reviewer 非阻塞建议）。
function cleanE2eField(s: string, max = 600): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(s ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

export function renderE2eKickoff(cfg: TaskTeamE2eConfig | undefined): string {
  if (!cfg) {
    return '\n（本组未配置 e2e 四项，请 owner 补：①装哪个客户端包 ②哪个分支编本地前端 ③测哪些 case+预期 ④用哪个 skill）';
  }
  const skill = cleanE2eField(cfg.skill ?? '', 120) || 'doubao-desktop-cdp-verification';
  return [
    '\n【请在真机豆包桌面客户端跑 e2e 验证，四项配置】',
    `① 客户端包：${cleanE2eField(cfg.clientPackage)}`,
    `② 本地前端分支：${cleanE2eField(cfg.frontendBranch)}（worktree 用 flow_web_1~4，禁自 clone 大仓）`,
    `③ 测哪些 case + 预期：${cleanE2eField(cfg.cases)}`,
    `④ 验证 skill：${skill}`,
    '跑完把通过/失败结果连同关键现象回报到本群（明确说"全部通过"或"失败：..."，便于判读）。',
  ].join('\n');
}

export function renderTaskTeamCommand(action: TaskTeamAction, instance: TaskTeamInstance): string {
  const delivery = deliverySpecOf(action);
  const ri = instance.roleInstances.find(r => r.roleInstanceId === action.targetRoleInstanceId);
  // 目标 @：user/owner 类显式 open_id 优先；否则 @ 目标席位绑定的 bot（席位寻址，沿用旧行为）。
  const mentionOpenId =
    (delivery?.targetType === 'user' || delivery?.targetType === 'owner') && delivery.targetOpenId
      ? delivery.targetOpenId
      : ri?.binding?.botOpenId;
  const mention = mentionOpenId ? `<at user_id="${mentionOpenId}"></at> ` : '';
  const label = COMMAND_LABEL[action.actionType] ?? action.actionType;
  const summary = typeof action.payload?.summary === 'string' ? action.payload.summary : '';
  const body = summary ? `：${summary}` : '';
  const ackHint = delivery?.ack ? '（请回执 ack）' : '';
  // type-specific 渲染补充（kind 驱动，通用——不耦合具体角色 id）：
  //  · e2e-kickoff：派 e2e 时把实例四项配置追加给豆包M；
  //  · e2e-fail-rework：e2e 失败踢回开发者时追加「先自查能修就修、修不了向上反馈、失败详情见群内回报」。
  let extra = '';
  if (delivery?.kind === 'e2e-kickoff') {
    extra = renderE2eKickoff(instance.e2eConfig);
  } else if (delivery?.kind === 'e2e-fail-rework') {
    extra = '\n（e2e 验证未通过：先自查，能修就修复后重走 e2e；确实修不了用 askforhelp 向上反馈。失败详情见本群内 e2e 验证员的回报）';
  }
  return `${mention}【任务小组·${label}】${body}${ackHint}${extra}`.trim();
}

/** 投递目标群：targetType=chat 的显式 targetChatId 覆盖；否则小组自身 chatId。 */
export function targetChatIdFor(action: TaskTeamAction, instance: TaskTeamInstance): string | null {
  const delivery = deliverySpecOf(action);
  if (delivery?.targetType === 'chat' && delivery.targetChatId) return delivery.targetChatId;
  return instance.chatId || null;
}

export function makeTaskTeamDispatchExecutors(senderLarkAppId: string): TaskTeamDispatchExecutors {
  return {
    async send(action: TaskTeamAction): Promise<TaskTeamSendResult> {
      const instance = getTaskTeam(action.teamId);
      if (!instance) return { ok: false, error: `team ${action.teamId} not found`, retriable: false };
      // 阶段2：targetType=chat 可把 notify/route 投到外部群（targetChatId）；否则发小组自身 chatId。
      const chatId = targetChatIdFor(action, instance);
      if (!chatId) return { ok: false, error: `team ${action.teamId} has no target chatId`, retriable: false };
      try {
        const messageId = await sendMessage(senderLarkAppId, chatId, renderTaskTeamCommand(action, instance));
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

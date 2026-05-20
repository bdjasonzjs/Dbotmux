export type Lang = 'en' | 'zh';

const STORAGE_KEY = 'botmux.dashboard.lang';

const messages = {
  en: {
    'nav.sessions': 'Sessions',
    'nav.schedules': 'Schedules',
    'nav.workflows': 'Workflows',
    'nav.groups': 'Groups & Bots',
    'nav.botDefaults': 'Bot Defaults',
    'status.live': '● live',
    'status.offline': '● disconnected',

    'time.secondsAgo': '{value}s ago',
    'time.minutesAgo': '{value}m ago',
    'time.hoursAgo': '{value}h ago',

    'workflow.searchPlaceholder': 'search runId / workflowId / chatId',
    'workflow.filter.nonTerminal': 'non-terminal',
    'workflow.filter.all': 'all',
    'workflow.status.pending': 'pending',
    'workflow.status.running': 'running',
    'workflow.status.waiting': 'waiting',
    'workflow.status.succeeded': 'succeeded',
    'workflow.status.failed': 'failed',
    'workflow.status.cancelled': 'cancelled',
    'workflow.table.run': 'run',
    'workflow.table.workflow': 'workflow',
    'workflow.table.status': 'status',
    'workflow.table.lastSeq': 'lastSeq',
    'workflow.table.dangling': 'dEf/dAct/dWait',
    'workflow.table.updated': 'updated',
    'workflow.table.chatApp': 'chat / app',
    'workflow.list.failedLoad': 'Failed to load: {error}',
    'workflow.list.noRuns': 'No runs match.',
    'workflow.list.noFilterMatch': 'No runs match this filter.',
    'workflow.list.loaded': '{count} runs · refreshed {time}',
    'workflow.list.error': 'error: {error}',

    'workflow.detail.back': 'Back',
    'workflow.detail.loading': 'Loading...',
    'workflow.detail.loadFailed': 'Load failed',
    'workflow.detail.cancel': 'Cancel',
    'workflow.detail.cliCancelOnly': 'CLI cancel only',
    'workflow.detail.cancelTitle': 'Cancel this workflow run',
    'workflow.detail.cliCancelTitle': 'Cancel unavailable: use botmux workflow cancel {runId}',
    'workflow.detail.nodes': 'Nodes / Activities',
    'workflow.detail.node': 'node',
    'workflow.detail.nodeStatus': 'node status',
    'workflow.detail.activity': 'activity',
    'workflow.detail.activityStatus': 'activity status',
    'workflow.detail.attempts': 'attempts',
    'workflow.detail.current': 'current',
    'workflow.detail.detail': 'detail',
    'workflow.detail.nodeIO': 'Node I/O',
    'workflow.detail.timeline': 'Timeline',
    'workflow.detail.loadOlder': 'Load older',
    'workflow.detail.seq': 'seq',
    'workflow.detail.actor': 'actor',
    'workflow.detail.error': 'error',
    'workflow.detail.event': 'event',
    'workflow.detail.time': 'time',
    'workflow.detail.refreshed': 'refreshed {time}',
    'workflow.detail.unknownRun': 'unknown run',
    'workflow.detail.snapshotHttp': 'snapshot HTTP {status}',
    'workflow.detail.eventsHttp': 'events HTTP {status}',
    'workflow.detail.cancelUnavailable': 'cancel unavailable: use botmux workflow cancel {runId}',
    'workflow.detail.cancelConfirm': 'Cancel workflow run {runId}?\n\n{total} dangling item(s) will be handled by cancel-driven recovery.\neffects={effects}, activities={activities}, waits={waits}, cancels={cancels}',
    'workflow.detail.writeAccessCancel': 'write access required: run `botmux dashboard` in the terminal to get a one-time URL, open it once to set the cookie, then come back and click cancel again.',
    'workflow.detail.cancelHttp': 'cancel HTTP {status}',
    'workflow.detail.cancelPending': 'cancel pending; waiting for running activity to drain',
    'workflow.detail.writeAccessApproval': 'write access required: run `botmux dashboard` in the terminal to get a one-time URL, open it once to set the cookie, then come back and approve/reject again.',
    'workflow.detail.actionHttp': '{action} HTTP {status}',
    'workflow.detail.approved': 'approved',
    'workflow.detail.rejected': 'rejected',
    'workflow.detail.alreadyTerminal': 'Run already terminal; {label} was not applied.',
    'workflow.detail.workflowContinue': '{label}; waiting for workflow to continue.',
    'workflow.detail.workflowRefreshing': '{label}; refreshing workflow state.',
    'workflow.detail.eventsLoaded': '{loaded}/{total} events loaded',
    'workflow.detail.dangling': 'Dangling',
    'workflow.detail.noDangling': 'No dangling work.',
    'workflow.detail.none': 'none',
    'workflow.detail.noNodes': 'No nodes yet.',
    'workflow.detail.idle': 'idle',
    'workflow.detail.noNodeIO': 'No node I/O yet.',
    'workflow.detail.notDispatched': 'not dispatched',
    'workflow.detail.noAttempt': 'No attempt yet',
    'workflow.detail.attempt': 'attempt',
    'workflow.detail.authoredInput': 'Authored input',
    'workflow.detail.resolvedInput': 'Resolved input',
    'workflow.detail.output': 'Output',
    'workflow.detail.executionLog': 'Execution log',
    'workflow.detail.waitPrompt': 'Wait prompt',
    'workflow.detail.approvalComment': 'Approval comment',
    'workflow.detail.optionalComment': 'Optional comment',
    'workflow.detail.approve': 'Approve',
    'workflow.detail.reject': 'Reject',
    'workflow.detail.submitting': 'Submitting...',
    'workflow.detail.empty': 'empty',
    'workflow.detail.truncated': 'truncated',
    'workflow.detail.noData': 'No data.',
    'workflow.detail.noPreview': 'No preview.',
    'workflow.detail.open': 'open',
    'workflow.detail.deadline': 'deadline',
    'workflow.detail.effect': 'effect',
    'workflow.detail.wait': 'wait',
    'workflow.detail.noEvents': 'No events.',

    'workflow.summary.workflow': 'workflow',
    'workflow.summary.status': 'status',
    'workflow.summary.lastSeq': 'lastSeq',
    'workflow.summary.updated': 'updated',
    'workflow.summary.revision': 'revision',
    'workflow.summary.initiator': 'initiator',
    'workflow.summary.failedNode': 'failedNode',
    'workflow.summary.cancelOrigin': 'cancelOrigin',
    'workflow.summary.chat': 'chat',
    'workflow.summary.app': 'app',

    'workflow.dangling.activities': 'activities',
    'workflow.dangling.effects': 'effects',
    'workflow.dangling.waits': 'waits',
    'workflow.dangling.cancels': 'cancels',
  },
  zh: {
    'nav.sessions': '会话',
    'nav.schedules': '定时',
    'nav.workflows': '工作流',
    'nav.groups': '群组与机器人',
    'nav.botDefaults': '机器人默认值',
    'status.live': '● 在线',
    'status.offline': '● 已断开',

    'time.secondsAgo': '{value} 秒前',
    'time.minutesAgo': '{value} 分钟前',
    'time.hoursAgo': '{value} 小时前',

    'workflow.searchPlaceholder': '搜索 runId / workflowId / chatId',
    'workflow.filter.nonTerminal': '非终态',
    'workflow.filter.all': '全部',
    'workflow.status.pending': '待开始',
    'workflow.status.running': '运行中',
    'workflow.status.waiting': '等待中',
    'workflow.status.succeeded': '成功',
    'workflow.status.failed': '失败',
    'workflow.status.cancelled': '已取消',
    'workflow.table.run': '运行',
    'workflow.table.workflow': '工作流',
    'workflow.table.status': '状态',
    'workflow.table.lastSeq': '最后序号',
    'workflow.table.dangling': '悬挂 dEf/dAct/dWait',
    'workflow.table.updated': '更新时间',
    'workflow.table.chatApp': '群聊 / 应用',
    'workflow.list.failedLoad': '加载失败：{error}',
    'workflow.list.noRuns': '没有匹配的运行。',
    'workflow.list.noFilterMatch': '没有符合筛选条件的运行。',
    'workflow.list.loaded': '{count} 个运行 · 刷新于 {time}',
    'workflow.list.error': '错误：{error}',

    'workflow.detail.back': '返回',
    'workflow.detail.loading': '加载中...',
    'workflow.detail.loadFailed': '加载失败',
    'workflow.detail.cancel': '取消',
    'workflow.detail.cliCancelOnly': '仅 CLI 可取消',
    'workflow.detail.cancelTitle': '取消这个工作流运行',
    'workflow.detail.cliCancelTitle': '无法在页面取消：请使用 botmux workflow cancel {runId}',
    'workflow.detail.nodes': '节点 / Activity',
    'workflow.detail.node': '节点',
    'workflow.detail.nodeStatus': '节点状态',
    'workflow.detail.activity': 'Activity',
    'workflow.detail.activityStatus': 'Activity 状态',
    'workflow.detail.attempts': '尝试次数',
    'workflow.detail.current': '当前尝试',
    'workflow.detail.detail': '详情',
    'workflow.detail.nodeIO': '节点输入输出',
    'workflow.detail.timeline': '时间线',
    'workflow.detail.loadOlder': '加载更早事件',
    'workflow.detail.seq': '序号',
    'workflow.detail.actor': '执行者',
    'workflow.detail.error': '错误',
    'workflow.detail.event': '事件',
    'workflow.detail.time': '时间',
    'workflow.detail.refreshed': '刷新于 {time}',
    'workflow.detail.unknownRun': '未知运行',
    'workflow.detail.snapshotHttp': 'snapshot HTTP {status}',
    'workflow.detail.eventsHttp': 'events HTTP {status}',
    'workflow.detail.cancelUnavailable': '无法取消：请使用 botmux workflow cancel {runId}',
    'workflow.detail.cancelConfirm': '确认取消工作流运行 {runId}？\n\n{total} 个悬挂项会由 cancel recovery 处理。\neffects={effects}, activities={activities}, waits={waits}, cancels={cancels}',
    'workflow.detail.writeAccessCancel': '需要写权限：请在终端运行 `botmux dashboard` 获取一次性 URL，打开后写入 cookie，再回来点击取消。',
    'workflow.detail.cancelHttp': 'cancel HTTP {status}',
    'workflow.detail.cancelPending': '取消已提交；等待运行中的 activity 收敛',
    'workflow.detail.writeAccessApproval': '需要写权限：请在终端运行 `botmux dashboard` 获取一次性 URL，打开后写入 cookie，再回来审批。',
    'workflow.detail.actionHttp': '{action} HTTP {status}',
    'workflow.detail.approved': '已通过',
    'workflow.detail.rejected': '已拒绝',
    'workflow.detail.alreadyTerminal': '运行已终态；未应用“{label}”。',
    'workflow.detail.workflowContinue': '{label}；等待工作流继续执行。',
    'workflow.detail.workflowRefreshing': '{label}；正在刷新工作流状态。',
    'workflow.detail.eventsLoaded': '已加载 {loaded}/{total} 个事件',
    'workflow.detail.dangling': '悬挂项',
    'workflow.detail.noDangling': '没有悬挂工作。',
    'workflow.detail.none': '无',
    'workflow.detail.noNodes': '还没有节点。',
    'workflow.detail.idle': '空闲',
    'workflow.detail.noNodeIO': '还没有节点输入输出。',
    'workflow.detail.notDispatched': '尚未派发',
    'workflow.detail.noAttempt': '还没有尝试',
    'workflow.detail.attempt': '尝试',
    'workflow.detail.authoredInput': '原始输入',
    'workflow.detail.resolvedInput': '解析后输入',
    'workflow.detail.output': '输出',
    'workflow.detail.executionLog': '执行日志',
    'workflow.detail.waitPrompt': '等待提示',
    'workflow.detail.approvalComment': '审批备注',
    'workflow.detail.optionalComment': '可选备注',
    'workflow.detail.approve': '通过',
    'workflow.detail.reject': '拒绝',
    'workflow.detail.submitting': '提交中...',
    'workflow.detail.empty': '空',
    'workflow.detail.truncated': '已截断',
    'workflow.detail.noData': '没有数据。',
    'workflow.detail.noPreview': '没有预览。',
    'workflow.detail.open': '打开',
    'workflow.detail.deadline': '截止',
    'workflow.detail.effect': '副作用',
    'workflow.detail.wait': '等待',
    'workflow.detail.noEvents': '还没有事件。',

    'workflow.summary.workflow': '工作流',
    'workflow.summary.status': '状态',
    'workflow.summary.lastSeq': '最后序号',
    'workflow.summary.updated': '更新时间',
    'workflow.summary.revision': '修订',
    'workflow.summary.initiator': '发起人',
    'workflow.summary.failedNode': '失败节点',
    'workflow.summary.cancelOrigin': '取消来源',
    'workflow.summary.chat': '群聊',
    'workflow.summary.app': '应用',

    'workflow.dangling.activities': 'Activities',
    'workflow.dangling.effects': 'Effects',
    'workflow.dangling.waits': 'Waits',
    'workflow.dangling.cancels': 'Cancels',
  },
} as const;

export type MessageKey = keyof typeof messages.en;

let lang: Lang = readInitialLang();
const listeners = new Set<() => void>();

function readInitialLang(): Lang {
  const saved = typeof window !== 'undefined'
    ? window.localStorage.getItem(STORAGE_KEY)
    : undefined;
  if (saved === 'zh' || saved === 'en') return saved;
  const navLang = typeof navigator !== 'undefined' ? navigator.language : 'en';
  return navLang.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function getLang(): Lang {
  return lang;
}

export function setLang(next: Lang): void {
  if (next === lang) return;
  lang = next;
  if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, next);
  if (typeof document !== 'undefined') document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
  for (const cb of listeners) cb();
}

export function onLangChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
  const template = messages[lang][key] ?? messages.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}

export function translateDom(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n as MessageKey | undefined;
    if (!key) return;
    el.textContent = t(key);
  });
}

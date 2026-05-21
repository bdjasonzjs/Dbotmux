import { store } from './store.js';
import { escapeHtml, relTime, t } from './ui.js';

let groupsSnapshot: { chats: any[]; bots: any[] } = { chats: [], bots: [] };

async function loadGroupsSnapshot(): Promise<void> {
  try {
    const r = await fetch('/api/groups');
    if (!r.ok) return;
    groupsSnapshot = await r.json();
  } catch {
    // Overview stays useful even when Lark group APIs are unavailable.
  }
}

function statusClass(status: string): string {
  return `status status-${escapeHtml(status || 'unknown')}`;
}

function renderSessionMini(s: any): string {
  return `<li class="overview-list-row">
    <div>
      <strong>${escapeHtml(s.title ?? s.sessionId)}</strong>
      <span>${escapeHtml(s.botName ?? '')} · ${escapeHtml(s.cliId ?? 'unknown')}</span>
    </div>
    <span class="${statusClass(s.status)}">${escapeHtml(s.status ?? 'unknown')}</span>
  </li>`;
}

function renderScheduleMini(s: any): string {
  const next = s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : '-';
  return `<li class="overview-list-row">
    <div>
      <strong>${escapeHtml(s.name ?? s.id)}</strong>
      <span>${escapeHtml(s.botName ?? s.larkAppId ?? '')} · ${escapeHtml(s.parsed?.display ?? '')}</span>
    </div>
    <span>${escapeHtml(next)}</span>
  </li>`;
}

export async function renderOverviewPage(root: HTMLElement) {
  root.innerHTML = `<section class="page hero-page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">${t('app.subtitle')}</p>
        <h1>${t('overview.title')}</h1>
        <p>${t('overview.subtitle')}</p>
      </div>
    </div>
    <div class="metric-grid" id="overview-metrics"></div>
    <div class="overview-grid">
      <section class="panel">
        <header class="panel-header">
          <div>
            <h2>${t('overview.recentSessions')}</h2>
            <p>${t('sessions.subtitle')}</p>
          </div>
          <a class="btn-link" href="#/sessions">${t('nav.sessions')}</a>
        </header>
        <ul class="overview-list" id="recent-sessions"></ul>
      </section>
      <section class="panel">
        <header class="panel-header">
          <div>
            <h2>${t('overview.nextSchedules')}</h2>
            <p>${t('schedules.subtitle')}</p>
          </div>
          <a class="btn-link" href="#/schedules">${t('nav.schedules')}</a>
        </header>
        <ul class="overview-list" id="next-schedules"></ul>
      </section>
    </div>
  </section>`;

  const metricsEl = root.querySelector<HTMLElement>('#overview-metrics')!;
  const sessionsEl = root.querySelector<HTMLElement>('#recent-sessions')!;
  const schedulesEl = root.querySelector<HTMLElement>('#next-schedules')!;

  function rerender() {
    const sessions = [...store.sessions.values()];
    const schedules = [...store.schedules.values()];
    const active = sessions.filter(s => s.status !== 'closed');
    const working = sessions.filter(s => s.status === 'working' || s.status === 'analyzing' || s.status === 'starting');
    const enabledSchedules = schedules.filter(s => s.enabled);
    const onlineBots = groupsSnapshot.bots?.length || new Set(sessions.map(s => s.larkAppId).filter(Boolean)).size;
    const cards = [
      { label: t('overview.openSessions'), value: active.length, meta: `${sessions.length} ${t('overview.total')}` },
      { label: t('overview.workingSessions'), value: working.length, meta: `${active.length} ${t('overview.active')}` },
      { label: t('overview.onlineBots'), value: onlineBots, meta: t('overview.daemonRegistry') },
      { label: t('overview.schedules'), value: schedules.length, meta: `${enabledSchedules.length} ${t('overview.enabledSchedules')}` },
      { label: t('overview.groups'), value: groupsSnapshot.chats?.length ?? 0, meta: t('overview.chatMatrix') },
    ];
    metricsEl.innerHTML = cards.map(card => `<article class="metric-card">
      <span>${escapeHtml(card.label)}</span>
      <strong>${card.value}</strong>
      <small>${escapeHtml(card.meta)}</small>
    </article>`).join('');

    const recent = sessions
      .sort((a, b) => Number(b.lastMessageAt ?? 0) - Number(a.lastMessageAt ?? 0))
      .slice(0, 6);
    sessionsEl.innerHTML = recent.length
      ? recent.map(s => renderSessionMini({ ...s, title: s.title ?? `${relTime(s.lastMessageAt)} · ${s.sessionId}` })).join('')
      : `<li class="empty">${t('overview.noSessions')}</li>`;

    const upcoming = schedules
      .filter(s => s.nextRunAt)
      .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))
      .slice(0, 6);
    schedulesEl.innerHTML = upcoming.length
      ? upcoming.map(renderScheduleMini).join('')
      : `<li class="empty">${t('overview.noSchedules')}</li>`;
  }

  store.on(rerender);
  rerender();
  void loadGroupsSnapshot().then(rerender);
}

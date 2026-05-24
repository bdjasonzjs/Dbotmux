/**
 * P4/v2 Collaboration Board (Topology page reimagined).
 *
 * Design philosophy (per 松松 2026-05-24 feedback): NOT an admin
 * monitoring panel — this is a **productivity tool** for high-concurrency
 * human-AI collaboration. The user must be able to:
 *   - glance the whole "task board" and spot what needs THEIR reply
 *   - one-click jump to any chat in Lark
 *   - never see naked chat_ids (use real group names)
 *   - see the latest activity, auto-refresh
 *
 * Layout:
 *   ┌── header (title + subtitle)
 *   ├── topbar (live counts: N awaiting reply · M bot working · refreshed Xs ago)
 *   ├── controls (search + status filter)
 *   └── grid
 *       ├── stream (sorted by urgency: needs_reply → bot_working → idle)
 *       └── drawer (full ChatContext when a card is clicked)
 *
 * Implementation notes:
 *   - polls /api/topology + /api/groups every 5s (no SSE yet, keep it simple)
 *   - merges chat-real-names from /api/groups into topology nodes
 *   - status inferred from metrics: hasUnansweredPing → needs_reply, fresh
 *     lastMessageAt → bot_working, else → idle
 *   - all visible strings via t() — Chinese/English follows sidebar locale
 *   - dispose returned to clear polling timer on route change
 */
import { t, escapeHtml } from './ui.js';

interface ChatNode {
  chatId: string;
  name: string;
  chatType: string;
  originType: 'p2p' | 'human_created' | 'bot_spawned';
  parentChatId: string | null;
  tags: string[];
  metrics: { lastMessageAt: string | null; messages24h: number; hasUnansweredPing: boolean };
  summary: string;
  /** Lifecycle status enriched by /api/topology (P5 archive feature). */
  status?: 'active' | 'archived';
  archivedAt?: string | null;
}

interface GroupBrief { chatId: string; name?: string }

interface ChatContext {
  chatId: string;
  purpose: string;
  originType: string;
  relatedRefs: string[];
  participants: { openId: string; role: string }[];
  inheritedFrom: { parentChatId: string; parentDigest: string } | null;
  activeTodoRefs: string[];
  rules: string[];
  injectionPolicy: string;
  updatedAt: string;
}

type CardStatus = 'needs_reply' | 'bot_working' | 'idle';

const LARK_APPLINK = 'https://applink.larksuite.com/client/chat/open';
const TOPOLOGY_POLL_MS = 5_000;      // /api/topology is cheap (file read)
const GROUPS_POLL_MS = 60_000;       // /api/groups fans out to Lark API — keep at 1 min minimum
const REFRESH_LABEL_TICK_MS = 1_000; // update "last refresh Xs ago" label
const FRESH_THRESHOLD_MS = 5 * 60 * 1000;  // < 5 min counts as "recently active"

function applink(chatId: string): string {
  return `${LARK_APPLINK}?openChatId=${encodeURIComponent(chatId)}`;
}

function statusOf(node: ChatNode): CardStatus {
  if (node.metrics.hasUnansweredPing) return 'needs_reply';
  if (node.metrics.lastMessageAt) {
    const age = Date.now() - new Date(node.metrics.lastMessageAt).getTime();
    if (age < FRESH_THRESHOLD_MS) return 'bot_working';
  }
  return 'idle';
}

function statusKey(s: CardStatus): string {
  return s === 'needs_reply' ? 'topo.status.needsReply'
    : s === 'bot_working' ? 'topo.status.botWorking'
    : 'topo.status.idle';
}

function formatAge(iso: string | null): string {
  if (!iso) return '-';
  const ageMs = Date.now() - new Date(iso).getTime();
  if (ageMs < 0) return 'now';
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s`;
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h`;
  return `${Math.floor(ageMs / 86_400_000)}d`;
}

export function renderTopologyPage(root: HTMLElement): () => void {
  root.innerHTML = `
    <div class="topo-v2-page">
      <header class="topo-v2-header">
        <h1>${t('topo.title')}</h1>
        <p class="topo-v2-subtitle">${t('topo.subtitle')}</p>
      </header>
      <div class="topo-v2-topbar" id="topo-topbar">${t('topo.refreshing')}</div>
      <div class="topo-v2-controls">
        <input type="search" id="topo-search" placeholder="${t('topo.searchPlaceholder')}" autocomplete="off" />
        <select id="topo-filter">
          <option value="all">${t('topo.filter.all')}</option>
          <option value="needs_reply">${t('topo.filter.needsReply')}</option>
          <option value="bot_working">${t('topo.filter.botWorking')}</option>
          <option value="idle">${t('topo.filter.idle')}</option>
        </select>
      </div>
      <div class="topo-v2-grid">
        <main class="topo-v2-stream" id="topo-stream">${t('topo.refreshing')}</main>
        <aside class="topo-v2-drawer" id="topo-drawer">${t('topo.drawer.empty')}</aside>
      </div>
    </div>
  `;

  const state = {
    nodes: [] as ChatNode[],
    groupNameByChatId: new Map<string, string>(),
    offTreeChats: [] as GroupBrief[],
    activeChatId: null as string | null,
    search: '',
    filter: 'all' as 'all' | CardStatus,
    showArchived: false,  // P5: toggle archived section
    lastLoadedAt: 0,  // ms epoch when latest topology data landed
  };

  const streamEl = document.getElementById('topo-stream')!;
  const drawerEl = document.getElementById('topo-drawer')!;
  const topbarEl = document.getElementById('topo-topbar')!;
  const searchEl = document.getElementById('topo-search') as HTMLInputElement;
  const filterEl = document.getElementById('topo-filter') as HTMLSelectElement;

  function nameOf(chatId: string, fallback?: string): string {
    return state.groupNameByChatId.get(chatId) || fallback || chatId;
  }

  function renderCard(n: ChatNode): string {
    const name = nameOf(n.chatId, n.name);
    const status = statusOf(n);
    const isArchived = n.status === 'archived';
    const lastWhen = formatAge(n.metrics.lastMessageAt);
    const summary = n.summary || '(无摘要)';
    const archiveBtn = isArchived
      ? `<button class="topo-v2-archive-btn" data-action="unarchive" data-chat-id="${escapeHtml(n.chatId)}" title="${t('topo.action.unarchiveTitle')}">${t('topo.action.unarchive')}</button>`
      : `<button class="topo-v2-archive-btn" data-action="archive" data-chat-id="${escapeHtml(n.chatId)}" title="${t('topo.action.archiveTitle')}">${t('topo.action.archive')}</button>`;
    return `
      <article class="topo-v2-card status-${status} ${isArchived ? 'archived' : ''} ${n.chatId === state.activeChatId ? 'active' : ''}" data-chat-id="${escapeHtml(n.chatId)}">
        <header class="topo-v2-card-head">
          <strong title="${escapeHtml(n.chatId)}">${escapeHtml(name)}</strong>
          <span class="topo-v2-status status-${status}">${t(statusKey(status))}</span>
        </header>
        <div class="topo-v2-card-summary">${escapeHtml(summary)}</div>
        <footer class="topo-v2-card-foot">
          <span>${t('topo.meta.messages24h', { n: n.metrics.messages24h })}</span>
          <span>${t('topo.meta.lastSeen', { when: lastWhen })}</span>
          ${archiveBtn}
          <a class="topo-v2-applink" target="_blank" rel="noopener" href="${applink(n.chatId)}">${t('topo.action.openInLark')}</a>
        </footer>
      </article>
    `;
  }

  function renderOffTreeCard(g: GroupBrief): string {
    const name = g.name || g.chatId;
    const active = g.chatId === state.activeChatId ? 'active' : '';
    return `
      <article class="topo-v2-card status-idle topo-v2-offtree-card ${active}" data-chat-id="${escapeHtml(g.chatId)}">
        <header class="topo-v2-card-head">
          <strong title="${escapeHtml(g.chatId)}">${escapeHtml(name)}</strong>
          <span class="topo-v2-status status-idle">${t('topo.status.idle')}</span>
        </header>
        <footer class="topo-v2-card-foot">
          <span><code>${escapeHtml(g.chatId)}</code></span>
          <a class="topo-v2-applink" target="_blank" rel="noopener" href="${applink(g.chatId)}">${t('topo.action.openInLark')}</a>
        </footer>
      </article>
    `;
  }

  function renderSectionList(label: string, list: ChatNode[]): string {
    if (!list.length) return '';
    return `<section class="topo-v2-section"><h3>${label} (${list.length})</h3>${list.map(renderCard).join('')}</section>`;
  }

  function renderStream(): void {
    // Partition into archived vs active first.
    const archivedNodes: ChatNode[] = [];
    const activeNodes: ChatNode[] = [];
    for (const n of state.nodes) {
      if (n.status === 'archived') archivedNodes.push(n);
      else activeNodes.push(n);
    }

    // Filter active nodes for the main sections
    const filtered = activeNodes.filter(n => {
      if (state.filter !== 'all' && statusOf(n) !== state.filter) return false;
      if (state.search) {
        const needle = state.search.toLowerCase();
        const name = nameOf(n.chatId, n.name).toLowerCase();
        if (!name.includes(needle) && !n.chatId.toLowerCase().includes(needle)) return false;
      }
      return true;
    });
    // Filter archived nodes (search applies; status filter doesn't to keep
    // discovery flexible).
    const archivedFiltered = archivedNodes.filter(n => {
      if (state.search) {
        const needle = state.search.toLowerCase();
        const name = nameOf(n.chatId, n.name).toLowerCase();
        if (!name.includes(needle) && !n.chatId.toLowerCase().includes(needle)) return false;
      }
      return true;
    });

    // Group active by status + sort within by lastMessageAt desc
    const groups: Record<CardStatus, ChatNode[]> = { needs_reply: [], bot_working: [], idle: [] };
    for (const n of filtered) groups[statusOf(n)].push(n);
    for (const s of ['needs_reply', 'bot_working', 'idle'] as CardStatus[]) {
      groups[s].sort((a, b) => {
        const la = a.metrics.lastMessageAt ? new Date(a.metrics.lastMessageAt).getTime() : 0;
        const lb = b.metrics.lastMessageAt ? new Date(b.metrics.lastMessageAt).getTime() : 0;
        return lb - la;
      });
    }

    // Off-tree chats (groups not in main-bot topology — p2p / human created
    // groups that the bot is in but hasn't been onboarded as bot_spawned).
    // Apply the same search filter so the user can find them too.
    const offTreeFiltered = state.offTreeChats.filter(g => {
      if (!state.search) return true;
      const needle = state.search.toLowerCase();
      const name = (g.name || g.chatId).toLowerCase();
      return name.includes(needle) || g.chatId.toLowerCase().includes(needle);
    });
    // Filter status: off-tree have no metrics so they're effectively 'idle';
    // hide them unless filter is 'all' or 'idle'.
    const showOffTree = state.filter === 'all' || state.filter === 'idle';
    const offTreeSection = (showOffTree && offTreeFiltered.length)
      ? `<section class="topo-v2-section topo-v2-offtree"><h3>${t('topo.section.offTree')} (${offTreeFiltered.length})</h3>${offTreeFiltered.map(renderOffTreeCard).join('')}</section>`
      : '';

    // P5: archived section, gated by state.showArchived toggle.
    const archivedSection = (state.showArchived && archivedFiltered.length)
      ? `<section class="topo-v2-section topo-v2-archived"><h3>${t('topo.section.archived', { n: archivedFiltered.length })}</h3>${archivedFiltered.map(renderCard).join('')}</section>`
      : '';

    const sections = [
      renderSectionList(t('topo.section.needsReply'), groups.needs_reply),
      renderSectionList(t('topo.section.botWorking'), groups.bot_working),
      renderSectionList(t('topo.section.idle'), groups.idle),
      offTreeSection,
      archivedSection,
    ].filter(Boolean).join('');

    streamEl.innerHTML = sections || `<div class="topo-v2-empty">${t('topo.empty')}</div>`;

    // Topbar live counts — idle includes both in-topology idle AND off-tree
    // groups (semantics: "all idle items on the board"). When filter narrows
    // the view we count what's actually visible, not the underlying total.
    const idleCount = groups.idle.length + (showOffTree ? offTreeFiltered.length : 0);
    const parts: string[] = [];
    if (groups.needs_reply.length) parts.push(`<span class="topo-v2-stat urgent">${t('topo.topbar.needsReply', { n: groups.needs_reply.length })}</span>`);
    if (groups.bot_working.length) parts.push(`<span class="topo-v2-stat working">${t('topo.topbar.botWorking', { n: groups.bot_working.length })}</span>`);
    if (idleCount) parts.push(`<span class="topo-v2-stat idle">${t('topo.topbar.idle', { n: idleCount })}</span>`);
    if (archivedFiltered.length) {
      const key = state.showArchived ? 'topo.topbar.archivedHide' : 'topo.topbar.archivedShow';
      parts.push(`<button class="topo-v2-stat archived-toggle" id="topo-archived-toggle">${t(key, { n: archivedFiltered.length })}</button>`);
    }
    const refreshWhen = state.lastLoadedAt
      ? formatAge(new Date(state.lastLoadedAt).toISOString())
      : '-';
    parts.push(`<span class="topo-v2-stat last-refresh" id="topo-refresh-label">${t('topo.topbar.lastRefresh', { when: refreshWhen })}</span>`);
    topbarEl.innerHTML = parts.join(' · ');

    wireClicks();
  }

  function wireClicks(): void {
    // Archive / unarchive button click — fire before card click handler.
    streamEl.querySelectorAll<HTMLElement>('.topo-v2-archive-btn').forEach(el => {
      el.addEventListener('click', async (ev) => {
        ev.stopPropagation();  // don't propagate to card click → drawer open
        const cid = el.dataset.chatId;
        const action = el.dataset.action;
        if (!cid || !action) return;
        try {
          const r = await fetch(`/api/contexts/${encodeURIComponent(cid)}/${action}`, { method: 'POST' });
          if (!r.ok) { alert(`${action} failed: HTTP ${r.status}`); return; }
          // Force reload to reflect new status
          await loadTopology();
        } catch (e) {
          alert(`${action} 出错: ${e}`);
        }
      });
    });
    // Archived toggle button
    const toggle = document.getElementById('topo-archived-toggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        state.showArchived = !state.showArchived;
        renderStream();
      });
    }
    streamEl.querySelectorAll<HTMLElement>('.topo-v2-card').forEach(el => {
      el.addEventListener('click', (ev) => {
        // Don't hijack the applink anchor click — let target=_blank work.
        if ((ev.target as HTMLElement).closest('.topo-v2-applink')) return;
        // Same for archive button (already stopPropagation'd, but defensive).
        if ((ev.target as HTMLElement).closest('.topo-v2-archive-btn')) return;
        const cid = el.dataset.chatId;
        if (!cid) return;
        state.activeChatId = cid;
        // history.replaceState — avoid hashchange that triggers route() rebuild
        // and our 5s polling restart. Deep-link still bookmarkable.
        history.replaceState(null, '', `#/topology?chat=${encodeURIComponent(cid)}`);
        void loadContext(cid);
        renderStream();
      });
    });
  }

  async function loadContext(chatId: string): Promise<void> {
    drawerEl.innerHTML = `<div class="topo-v2-drawer-loading">${t('topo.drawer.loading')}</div>`;
    try {
      const r = await fetch(`/api/contexts/${encodeURIComponent(chatId)}`);
      if (r.status === 404) {
        drawerEl.innerHTML = `<div class="topo-v2-drawer-empty">${t('topo.drawer.notFound')}</div>`;
        return;
      }
      const ctx: ChatContext = await r.json();
      drawerEl.innerHTML = renderDrawer(ctx);
    } catch (err) {
      drawerEl.innerHTML = `<div class="topo-v2-drawer-err">加载失败: ${escapeHtml(String(err))}</div>`;
    }
  }

  function renderDrawer(ctx: ChatContext): string {
    const name = nameOf(ctx.chatId);
    const inheritedPart = ctx.inheritedFrom?.parentChatId
      ? `<dt>${t('topo.drawer.parentChat')}</dt><dd><code>${escapeHtml(ctx.inheritedFrom.parentChatId)}</code></dd>
         ${ctx.inheritedFrom.parentDigest ? `<dt>${t('topo.drawer.parentDigest')}</dt><dd class="topo-v2-pre">${escapeHtml(ctx.inheritedFrom.parentDigest)}</dd>` : ''}`
      : '';
    const participants = ctx.participants.length
      ? `<ul>${ctx.participants.map(p => `<li>${escapeHtml(p.role)} · <code>${escapeHtml(p.openId)}</code></li>`).join('')}</ul>`
      : '<em>-</em>';
    const rules = ctx.rules.length ? `<ul>${ctx.rules.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : '<em>-</em>';
    const refs = ctx.relatedRefs.length ? `<ul>${ctx.relatedRefs.map(r => `<li><a href="${escapeHtml(r)}" target="_blank">${escapeHtml(r)}</a></li>`).join('')}</ul>` : '<em>-</em>';
    return `
      <div class="topo-v2-drawer-content">
        <header class="topo-v2-drawer-head">
          <div>
            <h2>${escapeHtml(name)}</h2>
            <code class="topo-v2-drawer-id">${escapeHtml(ctx.chatId)}</code>
          </div>
          <a href="${applink(ctx.chatId)}" target="_blank" class="topo-v2-applink">${t('topo.action.openInLark')}</a>
        </header>
        <dl>
          <dt>${t('topo.drawer.purpose')}</dt><dd>${escapeHtml(ctx.purpose)}</dd>
          <dt>${t('topo.drawer.originType')}</dt><dd><code>${escapeHtml(ctx.originType)}</code></dd>
          ${inheritedPart}
          <dt>${t('topo.drawer.activeTodoRefs')}</dt><dd>${ctx.activeTodoRefs.length ? ctx.activeTodoRefs.map(escapeHtml).join(' / ') : '<em>-</em>'}</dd>
          <dt>${t('topo.drawer.relatedRefs')}</dt><dd>${refs}</dd>
          <dt>${t('topo.drawer.participants')}</dt><dd>${participants}</dd>
          <dt>${t('topo.drawer.rules')}</dt><dd>${rules}</dd>
          <dt>${t('topo.drawer.updatedAt')}</dt><dd>${escapeHtml(ctx.updatedAt)}</dd>
        </dl>
      </div>
    `;
  }

  async function loadTopology(): Promise<void> {
    try {
      const topoRes = await fetch('/api/topology');
      const topo: { nodes: ChatNode[] } = await topoRes.json();
      state.nodes = topo.nodes || [];
      state.lastLoadedAt = Date.now();
      renderStream();
    } catch (err) {
      streamEl.innerHTML = `<div class="topo-v2-err">加载 topology 失败: ${escapeHtml(String(err))}</div>`;
    }
  }

  async function loadGroups(): Promise<void> {
    // /api/groups fans out to Lark API per daemon — keep at 60s+ TTL.
    try {
      const groupsRes = await fetch('/api/groups');
      const groups: { chats?: GroupBrief[] } = await groupsRes.json();
      state.groupNameByChatId.clear();
      const inTopoIds = new Set(state.nodes.map(n => n.chatId));
      const offTree: GroupBrief[] = [];
      for (const g of (groups.chats || [])) {
        if (g.name) state.groupNameByChatId.set(g.chatId, g.name);
        if (!inTopoIds.has(g.chatId)) offTree.push(g);
      }
      state.offTreeChats = offTree;
      renderStream();
    } catch (err) {
      // Don't crash the page on a failed groups fetch — names will fall
      // back to chat_id, which is ugly but not broken.
      console.warn('[topology] /api/groups fetch failed', err);
    }
  }

  function tickRefreshLabel(): void {
    const labelEl = document.getElementById('topo-refresh-label');
    if (!labelEl || !state.lastLoadedAt) return;
    const when = formatAge(new Date(state.lastLoadedAt).toISOString());
    labelEl.textContent = t('topo.topbar.lastRefresh', { when });
  }

  // Deep-link from chat-context card URL: #/topology?chat=oc_xxx
  const m = location.hash.match(/[?&]chat=([^&]+)/);
  if (m) state.activeChatId = decodeURIComponent(m[1]);

  searchEl.addEventListener('input', () => {
    state.search = searchEl.value;
    renderStream();
  });
  filterEl.addEventListener('change', () => {
    state.filter = filterEl.value as any;
    renderStream();
  });

  // Initial load: topology first (cheap), then groups (Lark API call) so the
  // page renders with real names as soon as groups arrive.
  void loadTopology().then(async () => {
    if (state.activeChatId) void loadContext(state.activeChatId);
    await loadGroups();
  });
  const topologyTimer = window.setInterval(loadTopology, TOPOLOGY_POLL_MS);
  const groupsTimer = window.setInterval(loadGroups, GROUPS_POLL_MS);
  const labelTimer = window.setInterval(tickRefreshLabel, REFRESH_LABEL_TICK_MS);

  // Dispose: stop all timers when route changes away from this page.
  return () => {
    window.clearInterval(topologyTimer);
    window.clearInterval(groupsTimer);
    window.clearInterval(labelTimer);
  };
}

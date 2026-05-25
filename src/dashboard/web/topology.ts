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

interface ApiTopology {
  rootChatId: string;
  nodes: ChatNode[];
}

type ViewMode = 'list' | 'graph' | 'tilly';

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
        <div class="topo-v2-view-switch" id="topo-view-switch">
          <button class="topo-v2-view-btn active" data-view="list">${t('topo.view.list')}</button>
          <button class="topo-v2-view-btn" data-view="graph">${t('topo.view.graph')}</button>
          <button class="topo-v2-view-btn" data-view="tilly">${t('topo.view.tilly')}</button>
        </div>
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
    rootChatId: '' as string,
    groupNameByChatId: new Map<string, string>(),
    activeChatId: null as string | null,
    search: '',
    filter: 'all' as 'all' | CardStatus,
    showArchived: false,  // P5: toggle archived section
    lastLoadedAt: 0,  // ms epoch when latest topology data landed
    viewMode: 'list' as ViewMode,  // 2026-05-25: list vs graph
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

  function renderSectionList(label: string, list: ChatNode[]): string {
    if (!list.length) return '';
    return `<section class="topo-v2-section"><h3>${label} (${list.length})</h3>${list.map(renderCard).join('')}</section>`;
  }

  // 2026-05-25 fix (妹妹 review #4): graph + list 共用的 search/filter
  // predicate. Graph 用它来 dim 不 match 的节点（保持连通性，比"消失"友好）；
  // list 也共享同一规则，避免两个视图筛选不一致。
  function matchesSearchFilter(n: ChatNode): boolean {
    if (state.filter !== 'all' && statusOf(n) !== state.filter) return false;
    if (state.search) {
      const needle = state.search.toLowerCase();
      const name = nameOf(n.chatId, n.name).toLowerCase();
      if (!name.includes(needle) && !n.chatId.toLowerCase().includes(needle)) return false;
    }
    return true;
  }

  // ----- 2026-05-25: SVG graph view -----------------------------------
  // Renders nodes as a radial layout: rootChatId in the center; each
  // bot_spawned child orbits at r=190; grandchildren at r=340. human_created
  // chats that themselves have bot_spawned children are also surfaced as
  // "alt-roots" outside the main orbit (top row). Orphans (parent=null
  // bot_spawned that aren't reachable from root) get a chip strip below.
  function renderGraph(): void {
    // 2026-05-25 fix #6 (实拍后发现): graph 视图原本只画 active，但现状
    // 5 个 bot_spawned 里有 4 个 status=archived，导致 graph 几乎啥都
    // 看不到。改成 archived 也画进去 + 加 .archived class 视觉降权
    // (dimmer + dashed border)，这样松松能看到完整拓扑，archived 一眼
    // 区分。orphan strip 同理也包含 archived 孤儿。
    const all = state.nodes;
    if (all.length === 0) {
      streamEl.innerHTML = `<div class="topo-v2-empty">${t('topo.graph.empty')}</div>`;
      return;
    }

    const byId = new Map<string, ChatNode>(all.map(n => [n.chatId, n]));
    const childrenOf = new Map<string, ChatNode[]>();
    for (const n of all) {
      if (n.parentChatId && byId.has(n.parentChatId)) {
        const arr = childrenOf.get(n.parentChatId) ?? [];
        arr.push(n);
        childrenOf.set(n.parentChatId, arr);
      }
    }

    // G4 (2026-05-25): 不强行用 state.rootChatId 当中心 — 如果它没
     // children，把图最大 subtree 的根拿来居中（视觉空间利用率高）。
     // rootChatId 没 children 时降为 alt-root 顶部显示。
    function subtreeSize(chatId: string, seen = new Set<string>()): number {
      if (seen.has(chatId)) return 0;
      seen.add(chatId);
      let n = 1;
      for (const c of childrenOf.get(chatId) ?? []) n += subtreeSize(c.chatId, seen);
      return n;
    }
    // 候选 = 所有有 children 的 node（无 children 的不能当中心）
    const subtreeCandidates = all.filter(n => (childrenOf.get(n.chatId)?.length ?? 0) > 0);
    let bestRootId: string | null = null;
    let bestSize = 0;
    for (const n of subtreeCandidates) {
      const size = subtreeSize(n.chatId);
      if (size > bestSize) { bestSize = size; bestRootId = n.chatId; }
    }
    // 优先级：state.rootChatId 如果是 best 之一 → 用它（语义清晰）；
     // 否则用 best (即使不是 mainTopic)。都没有 (无任何 parent_child edge)
     // → null，渲染时全 alt-root 平铺。
    const stateRootSize = state.rootChatId && byId.has(state.rootChatId)
      ? subtreeSize(state.rootChatId) : 0;
    const rootId: string | null = (state.rootChatId && stateRootSize > 0 && stateRootSize === bestSize)
      ? state.rootChatId
      : bestRootId;
    const reachable = new Set<string>();
    if (rootId) {
      const q = [rootId];
      while (q.length) {
        const cur = q.shift()!;
        if (reachable.has(cur)) continue;
        reachable.add(cur);
        for (const c of childrenOf.get(cur) ?? []) q.push(c.chatId);
      }
    }

    // Anything human_created with bot_spawned children but not reachable → alt-root.
    const altRoots = all.filter(
      n => !reachable.has(n.chatId)
        && n.originType !== 'bot_spawned'
        && (childrenOf.get(n.chatId)?.length ?? 0) > 0
    );
    // 2026-05-25 fix (妹妹 review #5): alt-root 的 children 已经在主图里画了，
    // 不能再进 orphan chip strip（之前会双显）。把 alt-root parent 也排除。
    const altRootIds = new Set(altRoots.map(n => n.chatId));
    const orphans = all.filter(
      n => n.originType === 'bot_spawned'
        && !reachable.has(n.chatId)
        && !(n.parentChatId && altRootIds.has(n.parentChatId))
    );

    // ----- layout: radial -------------------------------------------------
    const W = 1100, H = 540;
    const cx = W / 2, cy = H / 2 - 30;
    type Placed = { n: ChatNode; x: number; y: number; ring: 0 | 1 | 2 | -1 };
    const placed: Placed[] = [];

    if (rootId) {
      placed.push({ n: byId.get(rootId)!, x: cx, y: cy, ring: 0 });
      const ring1 = childrenOf.get(rootId) ?? [];
      const R1 = 190;
      ring1.forEach((c, i) => {
        const a = (i / Math.max(ring1.length, 1)) * 2 * Math.PI - Math.PI / 2;
        placed.push({ n: c, x: cx + R1 * Math.cos(a), y: cy + R1 * Math.sin(a), ring: 1 });
        const ring2 = childrenOf.get(c.chatId) ?? [];
        const R2 = 340;
        const ring2Angle = (i / Math.max(ring1.length, 1)) * 2 * Math.PI - Math.PI / 2;
        const spread = Math.min(ring2.length * 0.12, 0.8);
        ring2.forEach((gc, j) => {
          const offset = ring2.length === 1 ? 0 : ((j / (ring2.length - 1)) - 0.5) * spread;
          const a2 = ring2Angle + offset;
          placed.push({ n: gc, x: cx + R2 * Math.cos(a2), y: cy + R2 * Math.sin(a2), ring: 2 });
        });
      });
    }

    // Alt-roots: spread across the top row.
    altRoots.forEach((ar, i) => {
      const x = 80 + i * 180;
      const y = 40;
      placed.push({ n: ar, x, y, ring: -1 });
      // include direct children of alt-root one row below
      const children = childrenOf.get(ar.chatId) ?? [];
      children.forEach((c, j) => {
        placed.push({ n: c, x: x + (j - (children.length - 1) / 2) * 90, y: y + 90, ring: -1 });
      });
    });

    const placedById = new Map<string, Placed>(placed.map(p => [p.n.chatId, p]));

    // Edges from parent → child for every placed node with a placed parent.
    const edgesSvg: string[] = [];
    for (const p of placed) {
      if (!p.n.parentChatId) continue;
      const parent = placedById.get(p.n.parentChatId);
      if (!parent) continue;
      // Quadratic curve for nicer routing on radial layout
      const mx = (p.x + parent.x) / 2;
      const my = (p.y + parent.y) / 2 - 12;
      edgesSvg.push(
        `<path class="edge parent_child" d="M ${parent.x.toFixed(1)} ${parent.y.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${p.x.toFixed(1)} ${p.y.toFixed(1)}" marker-end="url(#arrow)" />`
      );
    }

    // Nodes as rounded rectangles with name + msg/24h
    const nodesSvg: string[] = [];
    for (const p of placed) {
      const status = statusOf(p.n);
      const name = nameOf(p.n.chatId, p.n.name);
      const short = name.length > 14 ? name.slice(0, 13) + '…' : name;
      const w = p.ring === 0 ? 140 : 120;
      const h = p.ring === 0 ? 56 : 44;
      const x0 = p.x - w / 2;
      const y0 = p.y - h / 2;
      const kindClass = p.n.chatId === rootId
        ? 'node-rect-root'
        : p.n.originType === 'bot_spawned' ? 'node-rect-spawned' : 'node-rect-human';
      const activeCls = p.n.chatId === state.activeChatId ? 'active' : '';
      const statusCls = `status-${status}`;
      // Fix #4: search/filter 不 match 的节点 dim 化 (保持连通性), 不消失。
      const fadedCls = matchesSearchFilter(p.n) ? '' : 'faded';
      // Fix #6: archived 节点用 dashed border + 半透明区分 active
      const archivedCls = p.n.status === 'archived' ? 'archived' : '';
      nodesSvg.push(`
        <g class="node-card ${activeCls} ${fadedCls} ${archivedCls}" data-chat-id="${escapeHtml(p.n.chatId)}">
          <title>${escapeHtml(name)} · ${p.n.metrics.messages24h} msg/24h · ${t(statusKey(status))}</title>
          <rect class="node-rect ${kindClass} ${statusCls}" x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" rx="8" ry="8" width="${w}" height="${h}" />
          <text class="node-label" x="${p.x.toFixed(1)}" y="${(p.y - 4).toFixed(1)}" text-anchor="middle">${escapeHtml(short)}</text>
          <text class="node-sub" x="${p.x.toFixed(1)}" y="${(p.y + 12).toFixed(1)}" text-anchor="middle">${p.n.metrics.messages24h} msg/24h · ${formatAge(p.n.metrics.lastMessageAt)}</text>
        </g>
      `);
    }

    const legend = `
      <div class="topo-v2-graph-legend">
        <span><span class="swatch" style="background:#fef3c7;border:1px solid #f59e0b"></span>${t('topo.graph.legend.root')}</span>
        <span><span class="swatch" style="background:#ecfdf5;border:1px solid #10b981"></span>${t('topo.graph.legend.spawned')}</span>
        <span><span class="swatch" style="background:#f1f5f9;border:1px solid #94a3b8"></span>${t('topo.graph.legend.human')}</span>
        <span><span class="swatch" style="background:#ef4444"></span>${t('topo.graph.legend.needsReply')}</span>
        <span><span class="swatch" style="background:#f59e0b"></span>${t('topo.graph.legend.botWorking')}</span>
        <span><span class="swatch" style="background:#cbd5e1"></span>${t('topo.graph.legend.idle')}</span>
      </div>
    `;

    const orphanStrip = orphans.length === 0 ? '' : `
      <div class="topo-v2-graph-orphans-row">
        <h4>${t('topo.graph.orphans', { n: orphans.length })}</h4>
        <div class="topo-v2-graph-orphans-list">
          ${orphans.map(n => {
            const st = statusOf(n);
            const nm = nameOf(n.chatId, n.name);
            const fadedCls = matchesSearchFilter(n) ? '' : 'faded';
            const archivedCls = n.status === 'archived' ? 'archived' : '';
            return `<span class="topo-v2-graph-orphan-chip status-${st} ${fadedCls} ${archivedCls}" data-chat-id="${escapeHtml(n.chatId)}" title="${escapeHtml(n.chatId)}"><span class="chip-dot"></span>${escapeHtml(nm.length > 18 ? nm.slice(0,17) + '…' : nm)}</span>`;
          }).join('')}
        </div>
      </div>
    `;

    streamEl.innerHTML = `
      <div class="topo-v2-graph-pane">
        ${legend}
        <svg class="topo-v2-graph-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
          <defs>
            <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
              <path d="M 0 0 L 6 4 L 0 8 Z" fill="#2563eb" opacity="0.6"/>
            </marker>
          </defs>
          <g class="edges">${edgesSvg.join('')}</g>
          <g class="nodes">${nodesSvg.join('')}</g>
        </svg>
        ${orphanStrip}
      </div>
    `;

    // Wire node + orphan-chip clicks → loadContext (same drawer as list view)
    streamEl.querySelectorAll<SVGGElement>('.node-card').forEach(g => {
      g.addEventListener('click', () => {
        const cid = g.dataset.chatId;
        if (!cid) return;
        state.activeChatId = cid;
        history.replaceState(null, '', `#/topology?chat=${encodeURIComponent(cid)}&view=graph`);
        void loadContext(cid);
        renderGraph();
      });
    });
    streamEl.querySelectorAll<HTMLElement>('.topo-v2-graph-orphan-chip').forEach(el => {
      el.addEventListener('click', () => {
        const cid = el.dataset.chatId;
        if (!cid) return;
        state.activeChatId = cid;
        history.replaceState(null, '', `#/topology?chat=${encodeURIComponent(cid)}&view=graph`);
        void loadContext(cid);
        renderGraph();
      });
    });
  }

  function renderStream(): void {
    // P6 product decision: the board is a task tracker, not a chat inbox.
    // Only chats that the bot itself spawned (bot_spawned) belong here —
    // p2p / human_created groups are info-gathering surfaces and must NOT
    // leak into the active task panel. Backend digest / topology ingest
    // is unchanged so main-bot still observes those chats for context;
    // we just don't surface them to the human. Archived chats keep all
    // originType (松松 confirmed A: a manually-archived human-created
    // chat should still be recoverable from the archived section).
    const bot_spawned_nodes = state.nodes.filter(n => n.originType === 'bot_spawned');

    // Partition into archived vs active first.
    const archivedNodes: ChatNode[] = [];
    const activeNodes: ChatNode[] = [];
    for (const n of bot_spawned_nodes) {
      if (n.status === 'archived') archivedNodes.push(n);
      else activeNodes.push(n);
    }
    // Plus: all archived nodes regardless of originType (so recovery works
    // for human_created chats that 松松 archived by mistake).
    for (const n of state.nodes) {
      if (n.status === 'archived' && n.originType !== 'bot_spawned') {
        archivedNodes.push(n);
      }
    }

    // Filter active nodes for the main sections (Fix #4: use shared predicate
    // so list 和 graph 用同一规则; 之前两份实现可能漂移)
    const filtered = activeNodes.filter(matchesSearchFilter);
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

    // P5: archived section, gated by state.showArchived toggle.
    const archivedSection = (state.showArchived && archivedFiltered.length)
      ? `<section class="topo-v2-section topo-v2-archived"><h3>${t('topo.section.archived', { n: archivedFiltered.length })}</h3>${archivedFiltered.map(renderCard).join('')}</section>`
      : '';

    const sections = [
      renderSectionList(t('topo.section.needsReply'), groups.needs_reply),
      renderSectionList(t('topo.section.botWorking'), groups.bot_working),
      renderSectionList(t('topo.section.idle'), groups.idle),
      archivedSection,
    ].filter(Boolean).join('');

    streamEl.innerHTML = sections || `<div class="topo-v2-empty">${t('topo.empty')}</div>`;

    // Topbar live counts. P6: off-tree no longer surfaces on the board,
    // so idle is purely "bot_spawned idle in topology". When the user
    // narrows the filter, count what's visible, not the underlying total.
    const idleCount = groups.idle.length;
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
    // P2 commit #6: RootInbox indicator + expand/collapse panel
    parts.push(`<button class="topo-v2-stat root-inbox-toggle" id="topo-root-inbox-toggle" title="主话题待处理 root-inbox 项">📥 RootInbox</button>`);
    topbarEl.innerHTML = parts.join(' · ');

    // RootInbox panel container (renders below topbar when expanded)
    // Fix #7: shared idempotent ensure — same fn called by renderTopbar.
    ensureRootInboxPanel();

    wireClicks();
    wireRootInboxPanel();
  }

  async function loadRootInboxPanel(): Promise<void> {
    const panel = document.getElementById('topo-root-inbox-panel');
    if (!panel) return;
    panel.innerHTML = '<em>加载中...</em>';
    try {
      const r = await fetch('/api/root-inbox');
      const data: { items?: any[] } = await r.json();
      const items = data.items ?? [];
      if (items.length === 0) {
        panel.innerHTML = '<em style="color:#94a3b8">📥 RootInbox 空 — 没有待处理项</em>';
        return;
      }
      panel.innerHTML = `
        <div class="topo-v2-root-inbox-header">📥 RootInbox · ${items.length} open</div>
        ${items.map(it => {
          const kindEmoji = it.kind === 'escalation' ? '🔔' : it.kind === 'progress' ? '✅' : '❓';
          const ruleBadge = it.ruleId ? `[${it.ruleId}]` : `[${it.kind}]`;
          const updates = it.updateCount > 1 ? `· 更新 ${it.updateCount} 次` : '';
          return `<div class="topo-v2-root-inbox-row">
            <span>${kindEmoji} ${escapeHtml(ruleBadge)}</span>
            <code title="${escapeHtml(it.subChatId)}">${escapeHtml(it.subChatName || it.subChatId).slice(0, 20)}</code>
            <span class="topo-v2-root-inbox-summary">${escapeHtml(it.summary)}</span>
            <span class="topo-v2-root-inbox-meta">${updates}</span>
            <button class="topo-v2-root-inbox-close" data-id="${escapeHtml(it.id)}">✅ 关闭</button>
          </div>`;
        }).join('')}
      `;
      // Wire close buttons
      panel.querySelectorAll<HTMLElement>('.topo-v2-root-inbox-close').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          if (!id) return;
          btn.setAttribute('disabled', 'true');
          btn.textContent = '关闭中...';
          try {
            const r = await fetch(`/api/root-inbox/${encodeURIComponent(id)}/close`, { method: 'POST' });
            if (!r.ok) { alert(`关闭失败: HTTP ${r.status}`); btn.removeAttribute('disabled'); btn.textContent = '✅ 关闭'; return; }
            void loadRootInboxPanel();
          } catch (e) { alert(`关闭出错: ${e}`); btn.removeAttribute('disabled'); btn.textContent = '✅ 关闭'; }
        });
      });
    } catch (err) {
      panel.innerHTML = `<em style="color:#dc2626">加载 RootInbox 失败: ${escapeHtml(String(err))}</em>`;
    }
  }

  function wireRootInboxPanel(): void {
    const btn = document.getElementById('topo-root-inbox-toggle');
    const panel = document.getElementById('topo-root-inbox-panel');
    if (!btn || !panel) return;
    btn.addEventListener('click', () => {
      if (panel.style.display === 'none') {
        panel.style.display = 'block';
        void loadRootInboxPanel();
      } else {
        panel.style.display = 'none';
      }
    });
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
      wireMainTopicBtn();
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
    // P1 commit #9: main-topic 设置按钮，放 drawer 顶部，drawer 内有 chat
    // 上下文最自然 (vs 全局顶栏没"当前 chat"概念)。
    const mainTopicBtn = `<button class="topo-v2-main-topic-btn" data-chat-id="${escapeHtml(ctx.chatId)}" title="设为 main-bot 派子任务的主话题">🌟 设为主话题</button>`;
    return `
      <div class="topo-v2-drawer-content">
        <header class="topo-v2-drawer-head">
          <div>
            <h2>${escapeHtml(name)}</h2>
            <code class="topo-v2-drawer-id">${escapeHtml(ctx.chatId)}</code>
          </div>
          <div class="topo-v2-drawer-actions">
            ${mainTopicBtn}
            <a href="${applink(ctx.chatId)}" target="_blank" class="topo-v2-applink">${t('topo.action.openInLark')}</a>
          </div>
        </header>
        <div class="topo-v2-main-topic-status" id="topo-main-topic-status"></div>
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

  // P1 commit #9: wire 主话题按钮点击。drawer re-renders 每次 loadContext，
  // 所以在 loadContext 内调一次 wireMainTopicBtn().
  function wireMainTopicBtn(): void {
    const btn = document.querySelector<HTMLElement>('.topo-v2-main-topic-btn');
    const statusEl = document.getElementById('topo-main-topic-status');
    if (!btn || !statusEl) return;
    // Show current main-topic status next to the button
    fetch('/api/config/main-topic-chat-id').then(r => r.json()).then((d: { mainTopicChatId?: string | null }) => {
      const myChat = btn.dataset.chatId;
      if (d.mainTopicChatId === myChat) {
        statusEl.innerHTML = '<em style="color:#15803d">✅ 已是当前主话题</em>';
        btn.setAttribute('disabled', 'true');
      } else if (d.mainTopicChatId) {
        statusEl.innerHTML = `<em style="color:#94a3b8">当前主话题: <code>${escapeHtml(d.mainTopicChatId)}</code></em>`;
      } else {
        statusEl.innerHTML = '<em style="color:#94a3b8">尚未配置主话题</em>';
      }
    }).catch(() => { /* silent */ });
    btn.addEventListener('click', async () => {
      const cid = btn.dataset.chatId;
      if (!cid) return;
      if (!confirm(`确认把这个 chat (${cid}) 设为 main-bot 主话题？\n\n旧值会被覆盖；主 bot 只能从此 chat 调用 subtask-create 派子任务。`)) return;
      btn.setAttribute('disabled', 'true');
      btn.textContent = '保存中...';
      try {
        const r = await fetch('/api/config/main-topic-chat-id', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chatId: cid }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          alert(`保存失败: ${(err as any).error ?? r.status}`);
          btn.textContent = '🌟 设为主话题';
          btn.removeAttribute('disabled');
          return;
        }
        statusEl.innerHTML = '<em style="color:#15803d">✅ 已设为当前主话题</em>';
        btn.textContent = '✅ 已是主话题';
      } catch (e) {
        alert('网络错误: ' + e);
        btn.textContent = '🌟 设为主话题';
        btn.removeAttribute('disabled');
      }
    });
  }

  async function loadTopology(): Promise<void> {
    try {
      const topoRes = await fetch('/api/topology');
      const topo: ApiTopology = await topoRes.json();
      state.nodes = topo.nodes || [];
      state.rootChatId = topo.rootChatId || '';
      state.lastLoadedAt = Date.now();
      rerender();
    } catch (err) {
      streamEl.innerHTML = `<div class="topo-v2-err">加载 topology 失败: ${escapeHtml(String(err))}</div>`;
    }
  }

  // Single entry point — picks view by state.viewMode. All places that
  // previously called renderStream() directly still work (renderStream
  // delegates here).
  function rerender(): void {
    if (state.viewMode === 'graph') {
      renderGraph();
      renderTopbar();
    } else if (state.viewMode === 'tilly') {
      void renderTillyView();
      renderTopbar();
    } else {
      renderStream();
    }
  }

  // 2026-05-25 Phase A v2 commit 5 (松松/妹妹 review): "🐶 缇蕾扫读" tab
  // 整体内容追溯。从 `/api/tilly-digest` 拉 cumulative + archive，从
  // `/api/scout-inbox` 拉 pending tilly_digest_high item 的 sourceMessageId
  // 集合 → 只有这些 item 在 cumulative 列表里显示"dismiss"按钮 (妹妹 #5)。
  // 普通 cumulative item 只展示 applink，不打 dismiss API。
  async function renderTillyView(): Promise<void> {
    streamEl.innerHTML = `<div class="topo-v2-empty">${t('topo.tilly.loading')}</div>`;
    try {
      const [tdResp, siResp] = await Promise.all([
        fetch('/api/tilly-digest').then(r => r.json()),
        fetch('/api/scout-inbox').then(r => r.json()),
      ]);
      const current = tdResp.current ?? { todos: [], progress: [], blockers: [], noteworthy: [], dateId: '-', tickCount: 0, lastTickAt: '' };
      const archive = (tdResp.archive ?? []) as Array<{ dateId: string; todos: any[]; progress: any[]; blockers: any[]; noteworthy: any[]; tickCount: number }>;
      // Map: sourceMessageId → scoutInboxItem.id (only pending tilly_digest_high)
      const pendingDismissMap = new Map<string, string>();
      for (const it of (siResp.pending ?? [])) {
        if (it.type === 'tilly_digest_high' && it.status === 'pending' && it.payload?.sourceMessageId) {
          pendingDismissMap.set(it.payload.sourceMessageId, it.id);
        }
      }
      const renderItem = (it: any): string => {
        const prio = it.priority ? `<span class="tilly-prio tilly-prio-${it.priority}">${it.priority}</span> ` : '';
        const chatTag = it.sourceChatName ? `<span class="tilly-chat">· ${escapeHtml(it.sourceChatName)}</span>` : '';
        const jump = it.sourceAppLink ? ` <a href="${escapeHtml(it.sourceAppLink)}" target="_blank" rel="noopener">[→]</a>` : '';
        const inboxId = pendingDismissMap.get(it.sourceMessageId);
        const dismiss = inboxId
          ? ` <button class="tilly-dismiss" data-inbox-id="${escapeHtml(inboxId)}">${t('topo.tilly.dismiss')}</button>`
          : '';
        return `<li class="tilly-item">${prio}${escapeHtml(it.summary || '')}${chatTag}${jump}${dismiss}</li>`;
      };
      const renderCategory = (title: string, emoji: string, items: any[]): string => {
        if (!items || items.length === 0) return '';
        return `<section class="tilly-category"><h4>${emoji} ${title} <span class="tilly-count">(${items.length})</span></h4><ul>${items.map(renderItem).join('')}</ul></section>`;
      };
      const totalCurrent = current.todos.length + current.progress.length + current.blockers.length + current.noteworthy.length;
      const archiveBlock = archive.length === 0
        ? ''
        : `<details class="tilly-archive"><summary>${t('topo.tilly.archiveHeader', { n: archive.length })}</summary>${
            archive.slice().reverse().map(day => `
              <div class="tilly-archive-day">
                <h4>${escapeHtml(day.dateId)} <span class="tilly-count">(${day.todos.length + day.progress.length + day.blockers.length + day.noteworthy.length} items / ${day.tickCount} ticks)</span></h4>
                ${renderCategory(t('topo.tilly.cat.todos'), '📝', day.todos)}
                ${renderCategory(t('topo.tilly.cat.progress'), '✅', day.progress)}
                ${renderCategory(t('topo.tilly.cat.blockers'), '🚧', day.blockers)}
                ${renderCategory(t('topo.tilly.cat.noteworthy'), '💡', day.noteworthy)}
              </div>
            `).join('')
          }</details>`;
      const pendingCount = pendingDismissMap.size;
      streamEl.innerHTML = `
        <div class="topo-v2-tilly-pane">
          <header class="tilly-header">
            <h2>🐶 ${t('topo.tilly.title')} · ${escapeHtml(current.dateId)}</h2>
            <p class="tilly-meta">
              ${t('topo.tilly.meta', { n: totalCurrent, ticks: current.tickCount, lastTick: current.lastTickAt ? current.lastTickAt.slice(11, 19) + ' UTC' : '-' })}
              · <span class="tilly-pending-badge">${pendingCount} pending high-prio</span>
            </p>
          </header>
          ${renderCategory(t('topo.tilly.cat.todos'), '📝', current.todos)}
          ${renderCategory(t('topo.tilly.cat.progress'), '✅', current.progress)}
          ${renderCategory(t('topo.tilly.cat.blockers'), '🚧', current.blockers)}
          ${renderCategory(t('topo.tilly.cat.noteworthy'), '💡', current.noteworthy)}
          ${archiveBlock}
        </div>
      `;
      // wire dismiss buttons
      streamEl.querySelectorAll<HTMLButtonElement>('.tilly-dismiss').forEach(btn => {
        btn.addEventListener('click', async () => {
          const inboxId = btn.dataset.inboxId;
          if (!inboxId) return;
          btn.disabled = true;
          btn.textContent = '...';
          try {
            const r = await fetch(`/api/scout-inbox/${encodeURIComponent(inboxId)}/dismiss`, { method: 'POST' });
            if (!r.ok) { alert('dismiss failed: HTTP ' + r.status); btn.disabled = false; btn.textContent = t('topo.tilly.dismiss'); return; }
            // 2026-05-25 commit 5 follow-up (妹妹 P1 #1): 整体 re-render
            // 让 badge (pending high-prio 数) + pending map + 同 inboxId
            // 多处按钮全部跟后端状态一致；不止 btn.remove() (会让 badge
            // 和别的 render 位置不同步)。
            await renderTillyView();
          } catch (err) {
            alert('dismiss failed: ' + err);
            btn.disabled = false; btn.textContent = t('topo.tilly.dismiss');
          }
        });
      });
    } catch (err) {
      streamEl.innerHTML = `<div class="topo-v2-err">${t('topo.tilly.loadErr', { err: escapeHtml(String(err)) })}</div>`;
    }
  }

  // Compact topbar render shared between views (renderStream produces its
  // own topbar inline; renderGraph also needs counts/refresh/RootInbox).
  //
  // 2026-05-25 fix (妹妹 review #4): topbar scope 显式覆盖 "graph 视图上所有
  // active 节点"，而非 list 的 P6 bot_spawned scope。两个视图本就是不同事物
  // (list = 我自己派的 task / graph = 全拓扑 + parent 关系)，topbar 跟着当前
  // 视图的范围走比强行对齐更直觉；这里的 active 也跟 graph 的 active 一致。
  function renderTopbar(): void {
    const active = state.nodes.filter(n => n.status !== 'archived' && matchesSearchFilter(n));
    const groups: Record<CardStatus, number> = { needs_reply: 0, bot_working: 0, idle: 0 };
    for (const n of active) groups[statusOf(n)]++;
    const parts: string[] = [];
    if (groups.needs_reply) parts.push(`<span class="topo-v2-stat urgent">${t('topo.topbar.needsReply', { n: groups.needs_reply })}</span>`);
    if (groups.bot_working) parts.push(`<span class="topo-v2-stat working">${t('topo.topbar.botWorking', { n: groups.bot_working })}</span>`);
    if (groups.idle) parts.push(`<span class="topo-v2-stat idle">${t('topo.topbar.idle', { n: groups.idle })}</span>`);
    const when = state.lastLoadedAt ? formatAge(new Date(state.lastLoadedAt).toISOString()) : '-';
    parts.push(`<span class="topo-v2-stat last-refresh" id="topo-refresh-label">${t('topo.topbar.lastRefresh', { when })}</span>`);
    parts.push(`<button class="topo-v2-stat root-inbox-toggle" id="topo-root-inbox-toggle" title="主话题待处理 root-inbox 项">📥 RootInbox</button>`);
    topbarEl.innerHTML = parts.join(' · ');
    // Fix #7 (妹妹 2 轮): 深链 #/topology?view=graph 直接进只走 renderTopbar，
    // 不走 renderStream，panel 容器没有被创建 → RootInbox 按钮点不动。
    ensureRootInboxPanel();
    wireRootInboxPanel();
  }

  // Fix #7: shared by renderStream (list) 和 renderTopbar (graph)。idempotent
  // — 已存在则不动。
  function ensureRootInboxPanel(): void {
    if (document.getElementById('topo-root-inbox-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'topo-root-inbox-panel';
    panel.className = 'topo-v2-root-inbox-panel';
    panel.style.display = 'none';
    topbarEl.parentElement?.insertBefore(panel, topbarEl.nextSibling);
  }

  async function loadGroups(): Promise<void> {
    // /api/groups fans out to Lark API per daemon — keep at 60s+ TTL.
    // Used purely for chatId → human name lookup (nameOf). P6: off-tree
    // chats no longer render on the board, so we just need names.
    try {
      const groupsRes = await fetch('/api/groups');
      const groups: { chats?: GroupBrief[] } = await groupsRes.json();
      state.groupNameByChatId.clear();
      for (const g of (groups.chats || [])) {
        if (g.name) state.groupNameByChatId.set(g.chatId, g.name);
      }
      // 2026-05-25 fix (妹妹 review #2 blocker): 必须用 rerender() 否则
      // 在 graph 视图下，loadGroups 每次成功（initial + 60s 周期）都把主区
      // 替换成 list，用户根本停不在 graph。
      rerender();
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

  // Deep-link from chat-context card URL: #/topology?chat=oc_xxx[&view=graph]
  const m = location.hash.match(/[?&]chat=([^&]+)/);
  if (m) state.activeChatId = decodeURIComponent(m[1]);
  // 2026-05-25 commit 5 follow-up (妹妹 P1 #2): deep-link 加 tilly
  const vm = location.hash.match(/[?&]view=(list|graph|tilly)/);
  if (vm) state.viewMode = vm[1] as ViewMode;

  searchEl.addEventListener('input', () => {
    state.search = searchEl.value;
    rerender();
  });
  filterEl.addEventListener('change', () => {
    state.filter = filterEl.value as any;
    rerender();
  });

  // View-mode switch
  const switchEl = document.getElementById('topo-view-switch');
  if (switchEl) {
    switchEl.querySelectorAll<HTMLElement>('.topo-v2-view-btn').forEach(btn => {
      // Reflect current state on initial bind (deep-link may have set graph)
      btn.classList.toggle('active', btn.dataset.view === state.viewMode);
      btn.addEventListener('click', () => {
        const v = btn.dataset.view as ViewMode | undefined;
        if (!v || v === state.viewMode) return;
        state.viewMode = v;
        switchEl.querySelectorAll<HTMLElement>('.topo-v2-view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === v));
        const cidPart = state.activeChatId ? `chat=${encodeURIComponent(state.activeChatId)}&` : '';
        history.replaceState(null, '', `#/topology?${cidPart}view=${v}`);
        rerender();
      });
    });
  }

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

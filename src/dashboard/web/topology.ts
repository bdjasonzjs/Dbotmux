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
  // Inspection view (B): enriched by /api/topology join against subtask-store.
  // All optional — a plain chat (no subtask record) carries none of these and
  // is treated as a non-task group.
  reportingMode?: 'manager' | 'executor';
  subtaskStatus?: string;   // real SubTaskStatus: observing|reported_help|reported_done|finished|paused|error|stopped|creating|activation_failed
  subtaskGoal?: string;     // one-line "what's it doing" (compactSummary || goal)
  subtaskDepth?: number;
}

/** Extra relationship edge (chat-topology-store ChatEdge). Inspection view
 *  only consumes `parent_child` edges as ADDITIONAL parents on top of the
 *  primary `parentChatId` tree (DAG / multi-parent). */
interface ChatEdge {
  type: 'parent_child' | 'same_topic' | 'spawned_from' | 'cross_ref';
  fromChatId: string;
  toChatId: string;
  rationale?: string;
}

interface ApiTopology {
  rootChatId: string;
  nodes: ChatNode[];
  edges?: ChatEdge[];
  /** true when the subtask-store join degraded (corrupt subtasks.json); the
   *  inspection view still renders topology, just without task status. */
  subtaskJoinError?: boolean;
}

type ViewMode = 'inspect' | 'list' | 'graph' | 'tilly';

/** Inspection view group kind — drives the icon/color/layer distinction. */
type GroupKind = 'main' | 'manager' | 'executor' | 'plain';

/** Inspection status — derived from real SubTaskStatus + live metrics, with
 *  a severity used for sort/prominence (higher = more urgent → pinned top). */
interface InspectStatus { key: string; cls: string; severity: number; archivedLike: boolean }

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
  /** 2026-05-26 群聊模式: undefined/true = ON (default), false = OFF */
  chatModeGroup?: boolean;
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

// ─── Inspection view helpers (pure) ──────────────────────────────────────

/** Classify a node into main / manager / executor / plain.
 *  - main:     the topology root (= main topic). The top org node.
 *  - manager:  subtask reportingMode==='manager' (org layer, spawns children).
 *  - executor: a bot_spawned subgroup with a subtask record (leaf task layer).
 *  - plain:    everything else (human chats / p2p / no subtask record). */
function kindOf(node: ChatNode, rootChatId: string): GroupKind {
  if (node.chatId === rootChatId) return 'main';
  if (node.reportingMode === 'manager') return 'manager';
  if (node.subtaskStatus || node.reportingMode === 'executor' || node.originType === 'bot_spawned') return 'executor';
  return 'plain';
}

function kindKey(k: GroupKind): string { return `topo.kind.${k}`; }
function isOrgLayer(k: GroupKind): boolean { return k === 'main' || k === 'manager'; }

/** Map real SubTaskStatus (+ live metrics) → inspection status. severity:
 *  3 = needs human (pinned top, red), 2 = done-pending, 1 = working/observing,
 *  0 = finished/paused/idle. archivedLike → render under the archived section. */
function inspectStatusOf(node: ChatNode): InspectStatus {
  // An unanswered @human ping always means "needs you", regardless of the
  // subtask state machine — it's the most direct "look at me" signal.
  if (node.metrics.hasUnansweredPing) {
    return { key: 'topo.istatus.needs_human', cls: 'needs_human', severity: 3, archivedLike: false };
  }
  switch (node.subtaskStatus) {
    case 'reported_help':
      return { key: 'topo.istatus.needs_human', cls: 'needs_human', severity: 3, archivedLike: false };
    case 'error':
    case 'activation_failed':
      return { key: 'topo.istatus.error', cls: 'error', severity: 3, archivedLike: false };
    case 'reported_done':
      // child reported done but parent hasn't finished it — NOT archived,
      // still wants a human/parent to confirm + close.
      return { key: 'topo.istatus.done_pending', cls: 'done_pending', severity: 2, archivedLike: false };
    case 'observing':
      return { key: 'topo.istatus.observing', cls: 'working', severity: 1, archivedLike: false };
    case 'creating':
      return { key: 'topo.istatus.creating', cls: 'creating', severity: 1, archivedLike: false };
    case 'finished':
      return { key: 'topo.istatus.finished', cls: 'finished', severity: 0, archivedLike: true };
    case 'paused':
    case 'stopped':
      return { key: 'topo.istatus.paused', cls: 'paused', severity: 0, archivedLike: true };
  }
  // No subtask record (plain / main / manager-without-status): fall back to
  // the metrics-based card status so non-task groups still show liveness.
  const s = statusOf(node);
  if (s === 'needs_reply') return { key: 'topo.istatus.needs_human', cls: 'needs_human', severity: 3, archivedLike: false };
  if (s === 'bot_working') return { key: 'topo.istatus.working', cls: 'working', severity: 1, archivedLike: false };
  return { key: 'topo.istatus.idle', cls: 'idle', severity: 0, archivedLike: false };
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
          <button class="topo-v2-view-btn active" data-view="inspect">${t('topo.view.inspect')}</button>
          <button class="topo-v2-view-btn" data-view="list">${t('topo.view.list')}</button>
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
    edges: [] as ChatEdge[],
    rootChatId: '' as string,
    subtaskJoinError: false,
    groupNameByChatId: new Map<string, string>(),
    activeChatId: null as string | null,
    search: '',
    filter: 'all' as 'all' | CardStatus,
    showArchived: false,  // P5: toggle archived section
    expanded: new Set<string>(),  // inspect view: which group cards are drilled-down
    inspectSeeded: false,  // inspect view: one-time auto-expand seeding done
    lastLoadedAt: 0,  // ms epoch when latest topology data landed
    viewMode: 'inspect' as ViewMode,  // 巡检视图为默认 (邹劲松 2026-06-16)
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

  // ───── 巡检视图 (inspection view) — card drill-down over the task DAG ─────
  // Default view (邹劲松 2026-06-16). A human inspector glances this and sees:
  //   ① each group's name + one-line "what's it doing"
  //   ② active vs archived/done, visually separated
  //   ③ group kind (main / manager / executor) by icon + color + layer
  //   ④ "needs you" pinned to the top, loudest
  // Drill-down: click a group's ▸ toggle to expand its managers + subgroups;
  // recurse level by level. DAG: primary `parentChatId` builds the tree;
  // extra `parent_child` edges render as a "co-managed by X" badge on the
  // child (never a duplicated subtree).

  /** Extra (non-primary) parent chatIds for a node, from parent_child edges.
   *  Filters: source must exist, no self-loop, and never duplicate the
   *  primary parentChatId. */
  function extraParentsOf(node: ChatNode, byId: Map<string, ChatNode>): string[] {
    const out: string[] = [];
    for (const e of state.edges) {
      if (e.type !== 'parent_child') continue;
      if (e.toChatId !== node.chatId) continue;
      if (e.fromChatId === node.chatId) continue;            // self-loop
      if (e.fromChatId === node.parentChatId) continue;      // == primary, no dup
      if (!byId.has(e.fromChatId)) continue;                 // unknown source
      if (!out.includes(e.fromChatId)) out.push(e.fromChatId);
    }
    return out;
  }

  function renderInspect(): void {
    const byId = new Map<string, ChatNode>();
    for (const n of state.nodes) byId.set(n.chatId, n);

    // Primary-parent children index (the spanning tree).
    const childrenByParent = new Map<string, ChatNode[]>();
    for (const n of state.nodes) {
      const p = n.parentChatId;
      if (p && byId.has(p) && p !== n.chatId) {
        (childrenByParent.get(p) ?? childrenByParent.set(p, []).get(p)!).push(n);
      }
    }

    // Roots = no primary parent inside the set (orphans + the main topic).
    const allRoots = state.nodes.filter(n => !(n.parentChatId && byId.has(n.parentChatId) && n.parentChatId !== n.chatId));
    // ...but the inspection view is the *task orchestration* tree, not every
    // chat the daemon ever saw. Without this filter ~90 parent-less plain
    // p2p/human chats flood the top level and bury the real task roots. Keep
    // a root only if it's the main topic, carries a task (subtask record /
    // manager role), or has children. Plain childless orphans stay out of
    // inspect (they're still visible in list/graph).
    // Relevance = a task node (has a subtask record / manager role), the main
    // root, OR an *ancestor* of a task node. Defined recursively over the
    // (acyclic) parentChatId tree and memoized. Round 3 P2: the old raw
    // `hasChildren` check let a plain group with only taskless children pass
    // as a root, producing an empty top-level card; requiring a task somewhere
    // in the subtree prunes those entirely.
    const relCache = new Map<string, boolean>();
    const relInProgress = new Set<string>();
    const isInspectRelevant = (n: ChatNode): boolean => {
      const cached = relCache.get(n.chatId);
      if (cached !== undefined) return cached;
      // Cycle guard: childrenByParent is built from parentChatId (a tree in
      // healthy data), but a malformed parent loop must never blow the stack /
      // crash the dashboard render — treat a node already on the current
      // computation path as non-relevant (Round 4 non-blocking suggestion).
      if (relInProgress.has(n.chatId)) return false;
      relInProgress.add(n.chatId);
      let r: boolean;
      if (n.chatId === state.rootChatId || !!n.subtaskStatus || !!n.reportingMode) r = true;
      else r = (childrenByParent.get(n.chatId) ?? []).some(isInspectRelevant);
      relInProgress.delete(n.chatId);
      relCache.set(n.chatId, r);
      return r;
    };
    // The displayed tree only ever recurses into relevant children, so every
    // subtree-aware computation (severity, active/done routing, seeding, the
    // summary bar) must use the SAME filtered child set — otherwise a parent
    // can be classified "active" purely from hidden plain children it never
    // renders (Round 2 P2). One helper keeps every caller in lockstep.
    const relevantChildren = (id: string): ChatNode[] => (childrenByParent.get(id) ?? []).filter(isInspectRelevant);
    const roots = allRoots.filter(isInspectRelevant);
    // The set of nodes that can actually appear in the inspection tree (a
    // relevant node always has a relevant parent — having a child makes the
    // parent relevant — so all of these are reachable from `roots`).
    const relevantNodes = state.nodes.filter(isInspectRelevant);

    const isArchivedLike = (n: ChatNode): boolean => n.status === 'archived' || inspectStatusOf(n).archivedLike;

    // Memoized max severity over a node's subtree (for sort + active/archived
    // routing). Cycle-safe via `seen`. Only counts relevant (visible) children.
    const sevCache = new Map<string, number>();
    function subtreeMaxSev(n: ChatNode, seen = new Set<string>()): number {
      if (sevCache.has(n.chatId)) return sevCache.get(n.chatId)!;
      if (seen.has(n.chatId)) return 0;
      seen.add(n.chatId);
      let max = inspectStatusOf(n).severity;
      for (const c of relevantChildren(n.chatId)) max = Math.max(max, subtreeMaxSev(c, seen));
      sevCache.set(n.chatId, max);
      return max;
    }
    function subtreeHasActive(n: ChatNode, seen = new Set<string>()): boolean {
      if (seen.has(n.chatId)) return false;
      seen.add(n.chatId);
      if (!isArchivedLike(n)) return true;
      return relevantChildren(n.chatId).some(c => subtreeHasActive(c, seen));
    }

    // Seed expand state once: open the main root + every node on a path to a
    // "needs you" node, so urgent work is visible without clicking. User
    // toggles thereafter are preserved across the 5s poll.
    if (!state.inspectSeeded && state.nodes.length) {
      const seedOpen = (n: ChatNode, seen = new Set<string>()): boolean => {
        if (seen.has(n.chatId)) return false;
        seen.add(n.chatId);
        let openMe = inspectStatusOf(n).severity >= 3;
        for (const c of relevantChildren(n.chatId)) if (seedOpen(c, seen)) openMe = true;
        if (openMe) state.expanded.add(n.chatId);
        return openMe;
      };
      for (const r of roots) seedOpen(r);
      if (state.rootChatId) state.expanded.add(state.rootChatId);
      state.inspectSeeded = true;
    }

    const sortNodes = (list: ChatNode[]): ChatNode[] =>
      [...list].sort((a, b) => {
        const sd = subtreeMaxSev(b) - subtreeMaxSev(a);
        if (sd) return sd;
        const at = a.metrics.lastMessageAt ? new Date(a.metrics.lastMessageAt).getTime() : 0;
        const bt = b.metrics.lastMessageAt ? new Date(b.metrics.lastMessageAt).getTime() : 0;
        return bt - at;
      });

    const renderNodeCard = (n: ChatNode, depth: number, visited: Set<string>, flat = false): string => {
      if (visited.has(n.chatId)) return '';   // DAG cycle guard
      visited.add(n.chatId);
      const kind = kindOf(n, state.rootChatId);
      const ist = inspectStatusOf(n);
      const name = nameOf(n.chatId, n.name);
      // One-line "what's it doing": prefer the short scout summary, fall back
      // to the subtask goal. goal can be the full kickoff (≈2900 chars in
      // real data) — flatten whitespace and hard-clamp so a card stays a card,
      // not a document. Full text lives in the title tooltip.
      const oneLinerFull = (n.summary || n.subtaskGoal || '(无摘要)').replace(/\s+/g, ' ').trim();
      const ONELINER_MAX = 140;
      const oneLiner = oneLinerFull.length > ONELINER_MAX ? oneLinerFull.slice(0, ONELINER_MAX) + '…' : oneLinerFull;
      // Only task-relevant children (managers / subgroups with a subtask
      // record / containers) — same predicate as the root filter. Keeps
      // inspect = the orchestration tree, not every plain chat that happened
      // to get parentChatId set to this group.
      const kids = sortNodes(relevantChildren(n.chatId));
      // flat = search/filter result mode: render a standalone card, no
      // drill-down (the tree shape is meaningless once filtered to matches).
      const expanded = !flat && state.expanded.has(n.chatId);
      const hasKids = !flat && kids.length > 0;
      const toggle = hasKids
        ? `<button class="topo-insp-toggle" data-toggle="${escapeHtml(n.chatId)}" title="${expanded ? t('topo.inspect.collapse') : t('topo.inspect.expand')}">${expanded ? '▾' : '▸'}</button>`
        : `<span class="topo-insp-toggle-spacer"></span>`;
      // Co-parent badges (extra managers sharing this child).
      const coParents = extraParentsOf(n, byId)
        .map(pid => `<span class="topo-insp-coparent">${t('topo.inspect.coParent', { name: escapeHtml(nameOf(pid)) })}</span>`)
        .join('');
      const orgTag = isOrgLayer(kind)
        ? `<span class="topo-insp-orgtag">${t('topo.inspect.orgLayer')}</span>` : '';
      const childCount = hasKids ? `<span class="topo-insp-childcount">${t('topo.inspect.childCount', { n: kids.length })}</span>` : '';
      const card = `
        <div class="topo-insp-row kind-${kind} sev-${ist.severity} ${isArchivedLike(n) ? 'archived-like' : ''} ${n.chatId === state.activeChatId ? 'active' : ''}" style="--insp-depth:${depth}">
          ${toggle}
          <div class="topo-insp-card" data-chat-id="${escapeHtml(n.chatId)}">
            <div class="topo-insp-line1">
              <span class="topo-insp-kind kind-${kind}">${t(kindKey(kind))}</span>
              <strong class="topo-insp-name" title="${escapeHtml(n.chatId)}">${escapeHtml(name)}</strong>
              <span class="topo-insp-status st-${ist.cls}">${t(ist.key)}</span>
              ${orgTag}
            </div>
            <div class="topo-insp-line2" title="${escapeHtml(oneLinerFull)}">${escapeHtml(oneLiner)}</div>
            <div class="topo-insp-line3">
              ${childCount}
              ${coParents}
              <span class="topo-insp-age">${t('topo.meta.lastSeen', { when: formatAge(n.metrics.lastMessageAt) })}</span>
              <a class="topo-v2-applink" target="_blank" rel="noopener" href="${applink(n.chatId)}">${t('topo.action.openInLark')}</a>
            </div>
          </div>
        </div>`;
      let childrenHtml = '';
      if (hasKids && expanded) {
        // Same active/done split as the root level, applied at EVERY level:
        // the main topic alone has ~89 children (most finished) in real data;
        // without this a single expand floods the panel. Active children show
        // inline (urgent first via sortNodes); fully-done children collapse
        // into a per-parent "✅ N done" fold one click away.
        const activeKids = kids.filter(c => subtreeHasActive(c));
        const doneKids = kids.filter(c => !subtreeHasActive(c));
        const activeHtml = activeKids.map(c => renderNodeCard(c, depth + 1, visited)).join('');
        const doneHtml = doneKids.length
          ? `<details class="topo-insp-done-fold" style="--insp-depth:${depth + 1}"><summary>${t('topo.inspect.doneFold', { n: doneKids.length })}</summary>${doneKids.map(c => renderNodeCard(c, depth + 1, visited)).join('')}</details>`
          : '';
        childrenHtml = `<div class="topo-insp-children">${activeHtml}${doneHtml}</div>`;
      }
      return card + childrenHtml;
    };

    // Active vs archived routing at the root level: a root subtree with any
    // active node → active section; a fully done/archived root → archived.
    const activeRoots = sortNodes(roots.filter(r => subtreeHasActive(r)));
    const archivedRoots = sortNodes(roots.filter(r => !subtreeHasActive(r)));

    // Summary bar — count over the INSPECT-RELEVANT universe only (the nodes
    // that can actually appear in the tree), not all of topology. Counting all
    // nodes inflated "in progress" with ~130 plain chats that the view never
    // shows, contradicting "glance to see status" (Round 2 P1).
    let needsHuman = 0, working = 0, done = 0;
    for (const n of relevantNodes) {
      const s = inspectStatusOf(n);
      if (s.severity >= 3) needsHuman++;
      else if (s.severity >= 1) working++;
      else if (s.archivedLike) done++;
    }
    const summaryParts: string[] = [];
    if (needsHuman) summaryParts.push(`<span class="topo-insp-sum needs">${t('topo.inspect.summary.needsHuman', { n: needsHuman })}</span>`);
    if (working) summaryParts.push(`<span class="topo-insp-sum work">${t('topo.inspect.summary.working', { n: working })}</span>`);
    if (done) summaryParts.push(`<span class="topo-insp-sum done">${t('topo.inspect.summary.done', { n: done })}</span>`);

    const degradedBanner = state.subtaskJoinError
      ? `<div class="topo-insp-degraded">${t('topo.inspect.degraded')}</div>` : '';

    if (!state.nodes.length) {
      streamEl.innerHTML = `${degradedBanner}<div class="topo-v2-empty">${t('topo.inspect.empty')}</div>`;
      return;
    }

    // Search / status-filter wiring (Round 2 P2): the shared search box +
    // status select were dead on the default view. When either is active we
    // switch to a flat result list of matching relevant nodes (drill-down is
    // meaningless once filtered). statusOf-based filter values map onto the
    // inspect severity buckets so the existing dropdown stays meaningful.
    const matchesInspectFilter = (n: ChatNode): boolean => {
      if (state.filter === 'all') return true;
      const sev = inspectStatusOf(n).severity;
      if (state.filter === 'needs_reply') return sev >= 3;
      if (state.filter === 'bot_working') return sev === 1 || sev === 2;
      return sev === 0; // idle
    };
    const matchesInspectSearch = (n: ChatNode): boolean => {
      if (!state.search) return true;
      const needle = state.search.toLowerCase();
      const hay = (nameOf(n.chatId, n.name) + ' ' + n.chatId + ' ' + (n.summary || n.subtaskGoal || '')).toLowerCase();
      return hay.includes(needle);
    };
    const filterActive = !!state.search || state.filter !== 'all';

    let mainHtml: string;
    if (filterActive) {
      const matches = sortNodes(relevantNodes.filter(n => matchesInspectFilter(n) && matchesInspectSearch(n)));
      const visited = new Set<string>();
      mainHtml = `
        <section class="topo-insp-section">
          <h3>${t('topo.inspect.activeHeader')} · ${matches.length}</h3>
          ${matches.map(n => renderNodeCard(n, 0, visited, true)).join('') || `<div class="topo-v2-empty">${t('topo.inspect.empty')}</div>`}
        </section>`;
    } else {
      const archivedBlock = archivedRoots.length
        ? `<details class="topo-insp-archived"><summary>${t('topo.inspect.archivedHeader', { n: archivedRoots.length })}</summary>
             ${archivedRoots.map(r => renderNodeCard(r, 0, new Set<string>())).join('')}</details>`
        : '';
      mainHtml = `
        <section class="topo-insp-section">
          <h3>${t('topo.inspect.activeHeader')} (${activeRoots.length})</h3>
          ${activeRoots.map(r => renderNodeCard(r, 0, new Set<string>())).join('') || `<div class="topo-v2-empty">${t('topo.inspect.empty')}</div>`}
        </section>
        ${archivedBlock}`;
    }

    streamEl.innerHTML = `
      ${degradedBanner}
      <div class="topo-insp-pane">
        <div class="topo-insp-summary">${summaryParts.join('') || `<span class="topo-insp-sum done">${t('topo.inspect.summary.done', { n: 0 })}</span>`}</div>
        ${mainHtml}
      </div>`;
    wireInspectClicks();
  }

  function wireInspectClicks(): void {
    // Expand / collapse toggles.
    streamEl.querySelectorAll<HTMLElement>('.topo-insp-toggle').forEach(el => {
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const cid = el.dataset.toggle;
        if (!cid) return;
        if (state.expanded.has(cid)) state.expanded.delete(cid);
        else state.expanded.add(cid);
        renderInspect();
      });
    });
    // Card body click → open context drawer.
    streamEl.querySelectorAll<HTMLElement>('.topo-insp-card').forEach(el => {
      el.addEventListener('click', (ev) => {
        if ((ev.target as HTMLElement).closest('.topo-v2-applink')) return;
        const cid = el.dataset.chatId;
        if (!cid) return;
        state.activeChatId = cid;
        history.replaceState(null, '', `#/topology?chat=${encodeURIComponent(cid)}&view=inspect`);
        void loadContext(cid);
        renderInspect();
      });
    });
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
      // 嵌套子任务(子群建孙群)实测适配 (2026-06-12)：原 R1=190 圆 + R2=340 圆在
      // viewBox H=540 下，ring2 纵向必出画布 (cy±340 ∈ [-100,580])，且原 spread≤0.8
      // 给 3 孙仅 ~61px 间距 (<120px 节点宽) 必重叠（仿真 + 几何推导，见任务文档 §八）。
      // 改两环椭圆：纵向 145/210 收进画布且环间垂直间隙 65px > 节点高 44；横向 190/420。
      // fan 间距 0.30rad（横向 420×0.30=126px>宽120，纵向 210×0.30=63px>高44），并按
      // 相邻兄弟角距 85% 钳制防跨家入侵（ring1 历史堆积场景退化为轻度重叠，与存量一致）。
      // depth>2 节点仍不入图——与 G2 深度上限(默认2)联动；调大 BOTMUX_MAX_SUBTASK_DEPTH
      // 需同步扩展此处布局。
      const R1x = 190, R1y = 145;
      const R2x = 420, R2y = 210;
      const siblingGap = (2 * Math.PI) / Math.max(ring1.length, 1);
      ring1.forEach((c, i) => {
        const a = (i / Math.max(ring1.length, 1)) * 2 * Math.PI - Math.PI / 2;
        placed.push({ n: c, x: cx + R1x * Math.cos(a), y: cy + R1y * Math.sin(a), ring: 1 });
        const ring2 = childrenOf.get(c.chatId) ?? [];
        const ring2Angle = a;
        const spread = Math.min(Math.max(ring2.length - 1, 0) * 0.30, 1.2, siblingGap * 0.85);
        ring2.forEach((gc, j) => {
          const offset = ring2.length === 1 ? 0 : ((j / (ring2.length - 1)) - 0.5) * spread;
          const a2 = ring2Angle + offset;
          placed.push({ n: gc, x: cx + R2x * Math.cos(a2), y: cy + R2y * Math.sin(a2), ring: 2 });
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
      wireChatModeBtn();
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
    // 2026-05-26 群聊模式 commit 4 (commit 4 follow-up i18n): chat-level
    // toggle, undefined/true=ON。文案走 i18n 双语。
    const chatModeOn = ctx.chatModeGroup !== false;
    const chatModeLabel = chatModeOn ? t('topo.action.chatModeOn') : t('topo.action.chatModeOff');
    const chatModeBtn = `<button class="topo-v2-chat-mode-btn ${chatModeOn ? 'on' : 'off'}" data-chat-id="${escapeHtml(ctx.chatId)}" title="${escapeHtml(t('topo.action.chatModeTitle'))}">${escapeHtml(chatModeLabel)}</button>`;
    return `
      <div class="topo-v2-drawer-content">
        <header class="topo-v2-drawer-head">
          <div>
            <h2>${escapeHtml(name)}</h2>
            <code class="topo-v2-drawer-id">${escapeHtml(ctx.chatId)}</code>
          </div>
          <div class="topo-v2-drawer-actions">
            ${mainTopicBtn}
            ${chatModeBtn}
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

  // 2026-05-26 群聊模式 commit 4: chat-level toggle.
  function wireChatModeBtn(): void {
    const btn = document.querySelector<HTMLButtonElement>('.topo-v2-chat-mode-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const cid = btn.dataset.chatId;
      if (!cid) return;
      btn.disabled = true;
      try {
        const r = await fetch(`/api/contexts/${encodeURIComponent(cid)}/chat-mode`, { method: 'POST' });
        if (!r.ok) {
          const errBody = await r.json().catch(() => ({} as any));
          alert(`${t('topo.action.chatModeToggleFailed')} ${r.status}: ${errBody.hint ?? errBody.error ?? r.statusText}`);
          btn.disabled = false;
          return;
        }
        const j = await r.json();
        const on = j.chatModeGroup !== false;
        btn.classList.toggle('on', on);
        btn.classList.toggle('off', !on);
        btn.textContent = on ? t('topo.action.chatModeOn') : t('topo.action.chatModeOff');
      } catch (e) {
        alert(`${t('topo.action.chatModeNetworkErr')}: ${e}`);
      } finally {
        btn.disabled = false;
      }
    });
  }

  async function loadTopology(): Promise<void> {
    try {
      const topoRes = await fetch('/api/topology');
      const topo: ApiTopology = await topoRes.json();
      state.nodes = topo.nodes || [];
      state.edges = topo.edges || [];
      state.rootChatId = topo.rootChatId || '';
      state.subtaskJoinError = !!topo.subtaskJoinError;
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
    if (state.viewMode === 'inspect') {
      renderInspect();
      renderTopbar();
    } else if (state.viewMode === 'graph') {
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
    const parts: string[] = [];
    // In the inspect view the status counts live in the inspect summary bar
    // (scoped to relevant nodes). Showing the old whole-topology counts here
    // too produced two conflicting status lines (Round 3 P1) — so in inspect
    // mode the topbar carries only the refresh label + RootInbox toggle.
    if (state.viewMode !== 'inspect') {
      const active = state.nodes.filter(n => n.status !== 'archived' && matchesSearchFilter(n));
      const groups: Record<CardStatus, number> = { needs_reply: 0, bot_working: 0, idle: 0 };
      for (const n of active) groups[statusOf(n)]++;
      if (groups.needs_reply) parts.push(`<span class="topo-v2-stat urgent">${t('topo.topbar.needsReply', { n: groups.needs_reply })}</span>`);
      if (groups.bot_working) parts.push(`<span class="topo-v2-stat working">${t('topo.topbar.botWorking', { n: groups.bot_working })}</span>`);
      if (groups.idle) parts.push(`<span class="topo-v2-stat idle">${t('topo.topbar.idle', { n: groups.idle })}</span>`);
    }
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
  const vm = location.hash.match(/[?&]view=(inspect|list|graph|tilly)/);
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

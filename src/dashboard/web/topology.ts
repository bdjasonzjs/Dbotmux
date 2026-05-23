/**
 * P4/15 Topology page — main-bot mode dashboard view.
 *
 * v0.1 design: HTML-based list rendering (no vis-network / cytoscape.js
 * dep yet — those add ~700KB to the esbuild bundle). Two columns:
 *   - **Topology tree** (left): bot_spawned chats in parent-child layout.
 *     Each node click opens the right-side drawer.
 *   - **Sidebar "无拓扑群"** (right): p2p + human_created chats, listed
 *     flat. Per design Q1 they don't enter the topology tree.
 *
 * Drawer (slides over right column when a node is active) shows the full
 * `ChatContext` JSON returned from `/api/contexts/:chatId`. Clicking the
 * "🔗 在飞书打开" button opens the chat via Lark applink.
 *
 * Hash deep-link: `#/topology?chat=oc_xxx` auto-highlights that node and
 * opens the drawer (matches the dashboard URL inserted into the chat-
 * context welcome card by P0.5).
 */

interface ChatNode {
  chatId: string;
  name: string;
  chatType: string;
  originType: 'p2p' | 'human_created' | 'bot_spawned';
  parentChatId: string | null;
  tags: string[];
  metrics: { lastMessageAt: string | null; messages24h: number; hasUnansweredPing: boolean };
  summary: string;
}

interface ChatEdge {
  type: string;
  fromChatId: string;
  toChatId: string;
  rationale: string;
}

interface Topology { rootChatId: string; nodes: ChatNode[]; edges: ChatEdge[]; updatedAt: string }

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

const LARK_APPLINK_HOST = 'https://applink.larksuite.com/client/chat/open';

function applink(chatId: string): string {
  return `${LARK_APPLINK_HOST}?openChatId=${encodeURIComponent(chatId)}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function heatBadge(node: ChatNode): string {
  const last = node.metrics.lastMessageAt;
  if (!last) return '<span class="topo-heat cold">cold</span>';
  const age = Date.now() - new Date(last).getTime();
  if (age < 60 * 60 * 1000) return '<span class="topo-heat hot">🔥 hot</span>';
  if (age < 24 * 60 * 60 * 1000) return '<span class="topo-heat warm">🌡️ warm</span>';
  return '<span class="topo-heat cold">❄️ cold</span>';
}

function renderNodeCard(node: ChatNode, active: boolean): string {
  const pingFlag = node.metrics.hasUnansweredPing ? '<span class="topo-ping">⚠️ 未回 ping</span>' : '';
  const tagsPart = node.tags.length ? `<div class="topo-tags">${node.tags.map(t => `<span>${escapeHtml(t)}</span>`).join('')}</div>` : '';
  return `
    <div class="topo-node ${active ? 'active' : ''}" data-chat-id="${escapeHtml(node.chatId)}">
      <div class="topo-node-head">
        <strong>${escapeHtml(node.name)}</strong>
        ${heatBadge(node)}
        ${pingFlag}
      </div>
      <div class="topo-node-summary">${escapeHtml(node.summary || '(无摘要)')}</div>
      ${tagsPart}
      <div class="topo-node-meta">
        <span>${node.metrics.messages24h} 条/24h</span>
        <span><code>${escapeHtml(node.chatId)}</code></span>
      </div>
    </div>
  `;
}

function renderTopologyTree(topo: Topology, activeChatId: string | null): string {
  const botSpawned = topo.nodes.filter(n => n.originType === 'bot_spawned');
  if (botSpawned.length === 0) {
    return '<div class="topo-empty">(还没有 bot 派生的群)</div>';
  }
  // Group by parentChatId. botSpawnedIds is the set of valid parents in
  // the tree; any bot_spawned node whose parent isn't in that set (or
  // is null) is treated as a **root-level** node — otherwise it would
  // be orphaned in `byParent` and never rendered.
  const botSpawnedIds = new Set(botSpawned.map(n => n.chatId));
  const byParent = new Map<string | null, ChatNode[]>();
  for (const n of botSpawned) {
    const isOrphan = n.parentChatId !== null && !botSpawnedIds.has(n.parentChatId);
    const key = (n.parentChatId === null || isOrphan) ? null : n.parentChatId;
    const list = byParent.get(key) ?? [];
    list.push(n);
    byParent.set(key, list);
  }
  function renderLevel(parentId: string | null, depth: number): string {
    const children = byParent.get(parentId) ?? [];
    if (!children.length) return '';
    return `<div class="topo-level" style="margin-left:${depth * 24}px">` +
      children.map(c =>
        renderNodeCard(c, c.chatId === activeChatId) + renderLevel(c.chatId, depth + 1),
      ).join('') +
      '</div>';
  }
  return renderLevel(null, 0);
}

function renderSidebar(topo: Topology, activeChatId: string | null): string {
  const offTree = topo.nodes.filter(n => n.originType !== 'bot_spawned');
  if (offTree.length === 0) {
    return '<div class="topo-empty">(没有 p2p / 人手动建群)</div>';
  }
  const p2p = offTree.filter(n => n.originType === 'p2p');
  const human = offTree.filter(n => n.originType === 'human_created');
  const section = (label: string, list: ChatNode[]) =>
    list.length ? `<h3>${label} (${list.length})</h3>` + list.map(n => renderNodeCard(n, n.chatId === activeChatId)).join('') : '';
  return section('💬 1-on-1 私聊', p2p) + section('👥 人手动建群', human);
}

function renderDrawer(ctx: ChatContext | null, loading: boolean): string {
  if (loading) return '<div class="topo-drawer-loading">读取 ChatContext 中...</div>';
  if (!ctx) return '<div class="topo-drawer-empty">点击左侧节点查看详情</div>';
  const inheritedPart = ctx.inheritedFrom?.parentChatId
    ? `<dt>派生自</dt><dd><code>${escapeHtml(ctx.inheritedFrom.parentChatId)}</code></dd>
       <dt>父群摘要</dt><dd class="topo-pre">${escapeHtml(ctx.inheritedFrom.parentDigest || '(空)')}</dd>`
    : '<dt>派生自</dt><dd>(无父群)</dd>';
  const participants = ctx.participants.length
    ? ctx.participants.map(p => `<li>${escapeHtml(p.role)} · <code>${escapeHtml(p.openId)}</code></li>`).join('')
    : '<li>(待补)</li>';
  const rules = ctx.rules.length ? `<ul>${ctx.rules.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : '(无)';
  return `
    <div class="topo-drawer-content">
      <div class="topo-drawer-head">
        <h2>${escapeHtml(ctx.purpose)}</h2>
        <a href="${applink(ctx.chatId)}" target="_blank" class="topo-applink">🔗 在飞书打开</a>
      </div>
      <dl>
        <dt>chat_id</dt><dd><code>${escapeHtml(ctx.chatId)}</code></dd>
        <dt>origin_type</dt><dd><span class="topo-origin">${escapeHtml(ctx.originType)}</span></dd>
        ${inheritedPart}
        <dt>关联任务</dt><dd>${ctx.activeTodoRefs.length ? ctx.activeTodoRefs.map(escapeHtml).join(' / ') : '(无)'}</dd>
        <dt>参与者</dt><dd><ul>${participants}</ul></dd>
        <dt>规则</dt><dd>${rules}</dd>
        <dt>更新时间</dt><dd>${escapeHtml(ctx.updatedAt)}</dd>
      </dl>
    </div>
  `;
}

function parseHashChatParam(): string | null {
  const m = location.hash.match(/[?&]chat=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export function renderTopologyPage(root: HTMLElement): void {
  root.innerHTML = `
    <div class="topo-page">
      <h1>📊 Chat Topology</h1>
      <div class="topo-grid">
        <div class="topo-tree" id="topo-tree">加载中...</div>
        <aside class="topo-aside" id="topo-aside">加载中...</aside>
        <aside class="topo-drawer" id="topo-drawer">${renderDrawer(null, false)}</aside>
      </div>
    </div>
  `;

  let topo: Topology = { rootChatId: '', nodes: [], edges: [], updatedAt: '' };
  let activeChatId: string | null = parseHashChatParam();

  const treeEl = document.getElementById('topo-tree')!;
  const asideEl = document.getElementById('topo-aside')!;
  const drawerEl = document.getElementById('topo-drawer')!;

  async function loadTopology(): Promise<void> {
    try {
      const r = await fetch('/api/topology');
      topo = await r.json();
      treeEl.innerHTML = renderTopologyTree(topo, activeChatId);
      asideEl.innerHTML = renderSidebar(topo, activeChatId);
      wireNodeClicks();
    } catch (err) {
      treeEl.innerHTML = `<div class="topo-err">加载 topology 失败: ${escapeHtml(String(err))}</div>`;
    }
  }

  async function loadContext(chatId: string): Promise<void> {
    drawerEl.innerHTML = renderDrawer(null, true);
    try {
      const r = await fetch(`/api/contexts/${encodeURIComponent(chatId)}`);
      if (r.status === 404) {
        drawerEl.innerHTML = '<div class="topo-drawer-empty">该群没有 ChatContext（未注册到 main-bot 模式）</div>';
        return;
      }
      const ctx: ChatContext = await r.json();
      drawerEl.innerHTML = renderDrawer(ctx, false);
    } catch (err) {
      drawerEl.innerHTML = `<div class="topo-err">加载 context 失败: ${escapeHtml(String(err))}</div>`;
    }
  }

  function wireNodeClicks(): void {
    for (const el of root.querySelectorAll<HTMLElement>('.topo-node')) {
      el.addEventListener('click', () => {
        const cid = el.getAttribute('data-chat-id');
        if (!cid) return;
        activeChatId = cid;
        // Update URL fragment so the deep-link reflects the selection
        location.hash = `#/topology?chat=${encodeURIComponent(cid)}`;
        // Re-render to update .active class
        treeEl.innerHTML = renderTopologyTree(topo, activeChatId);
        asideEl.innerHTML = renderSidebar(topo, activeChatId);
        wireNodeClicks();
        void loadContext(cid);
      });
    }
  }

  void loadTopology().then(() => {
    if (activeChatId) void loadContext(activeChatId);
  });
}

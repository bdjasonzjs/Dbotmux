/**
 * P5 same-topic cross-chat edge inference.
 *
 * Looks at ChatTopology and infers `same_topic` ChatEdges whenever two or
 * more chats share a meaningful overlap signal. Two signals (either
 * triggers an edge):
 *
 *   1. **Shared tag**: both nodes carry the same tag in `node.tags[]`
 *      (tags are externally set — task #, PRD link, etc).
 *   2. **PRD/ticket ID in name or summary**: regex
 *      `/(?:N|T|sp|prd|ticket)\s?\d+/i` (Flumy todo task IDs).
 *
 * Output is **idempotent**: existing same_topic edges are skipped via
 * `addEdge`'s dedup. No edges between identical chatIds, no self-loops.
 * A 3rd "shared chinese keyword in summary" signal was considered but
 * not implemented — naive substring overlap fires too many false
 * positives; if needed later, implement with a TF-IDF / n-gram filter.
 *
 * Hooked from `runScoutTick` (added at the bottom of the L2 tick) so
 * cross-topic edges get refreshed every cron tick.
 */
import { readTopology, addEdge, type ChatNode } from '../services/chat-topology-store.js';

const TASK_ID_RE = /\b(?:N|T|sp|prd|ticket)\s*[-#]?\s*(\d+)\b/gi;

/** Run the inference and emit `same_topic` edges for every pair-wise
 *  match. Returns the number of `addEdge` **attempts** (not "newly added"
 *  — dedup is a per-write best-effort check inside addEdge, and we
 *  intentionally don't ask the store whether each write was novel; the
 *  topology remains correct regardless). For new-edge accounting use
 *  `readTopology().edges.length` before/after. */
export function inferSameTopicEdges(): number {
  const topo = readTopology();
  const nodes = topo.nodes;
  let added = 0;

  // Build signal indices.
  const byTag = new Map<string, ChatNode[]>();
  const byTaskId = new Map<string, ChatNode[]>();

  for (const node of nodes) {
    for (const tag of node.tags) {
      const list = byTag.get(tag) ?? [];
      list.push(node);
      byTag.set(tag, list);
    }
    for (const taskId of extractTaskIds(node)) {
      const list = byTaskId.get(taskId) ?? [];
      list.push(node);
      byTaskId.set(taskId, list);
    }
  }

  // Emit edges from each shared-signal group.
  for (const [tag, group] of byTag.entries()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (group[i].chatId === group[j].chatId) continue;
        addEdge({
          type: 'same_topic',
          fromChatId: group[i].chatId,
          toChatId: group[j].chatId,
          rationale: `shared tag: ${tag}`,
        });
        added++;
      }
    }
  }

  for (const [taskId, group] of byTaskId.entries()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (group[i].chatId === group[j].chatId) continue;
        addEdge({
          type: 'same_topic',
          fromChatId: group[i].chatId,
          toChatId: group[j].chatId,
          rationale: `shared task: ${taskId}`,
        });
        added++;
      }
    }
  }

  return added;
}

/** Extract Flumy-style task IDs from a chat's name + summary. Returns the
 *  normalized canonical form (e.g. "sp19" / "N6"). */
function extractTaskIds(node: ChatNode): string[] {
  const out = new Set<string>();
  for (const text of [node.name, node.summary]) {
    if (!text) continue;
    TASK_ID_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TASK_ID_RE.exec(text)) !== null) {
      // Normalize: e.g. "Sp 19" → "sp19", "N6" → "n6"
      out.add(m[0].replace(/\s+/g, '').replace(/[-#]/g, '').toLowerCase());
    }
  }
  return [...out];
}

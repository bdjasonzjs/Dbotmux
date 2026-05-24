#!/usr/bin/env tsx
/**
 * Backfill chat-topology.json parentChatId from chat-context-store.
 *
 * Why: 2026-05-25 松松反馈 Collaboration Board 看不到主子关系。诊断发现
 * `chat-topology.json` 里 6 个 bot_spawned 子群有 4 个 parentChatId=null，
 * 但 chat-context 里部分早期 spawn 可能仍记录了 inheritedFrom.parentChatId。
 * 这个脚本一次性回填 + 清测试占位 (`oc_new`)。
 *
 * Idempotent — 跑多次安全；只补 topology.parentChatId=null 且 context
 * 有 inheritedFrom.parentChatId 的节点。
 *
 * Run: `pnpm tsx scripts/backfill-topology-parents.ts`
 */
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DATA_DIR = join(homedir(), '.botmux', 'data');
const TOPO_FP = join(DATA_DIR, 'chat-topology.json');
const CONTEXTS_DIR = join(DATA_DIR, 'chat-contexts');

interface TopoNode {
  chatId: string;
  parentChatId: string | null;
  originType: string;
  [k: string]: any;
}
interface Topo { rootChatId: string; nodes: TopoNode[]; edges: any[]; updatedAt: string }
interface Ctx {
  originType?: string;
  parentChatId?: string | null;
  inheritedFrom?: { parentChatId?: string | null } | null;
}

function readJson<T>(fp: string): T | null {
  if (!existsSync(fp)) return null;
  try { return JSON.parse(readFileSync(fp, 'utf-8')) as T; }
  catch (e) { console.error(`[skip] failed to parse ${fp}: ${e}`); return null; }
}

function readContext(chatId: string): Ctx | null {
  return readJson<Ctx>(join(CONTEXTS_DIR, `${chatId}.json`));
}

function writeTopoAtomic(topo: Topo): void {
  const tmp = TOPO_FP + '.tmp';
  writeFileSync(tmp, JSON.stringify(topo, null, 2), 'utf-8');
  renameSync(tmp, TOPO_FP);
}

function main(): void {
  const topo = readJson<Topo>(TOPO_FP);
  if (!topo) { console.error(`[abort] ${TOPO_FP} not readable`); process.exit(1); }

  let fixedParent = 0;
  let fixedOrigin = 0;
  const skipped: string[] = [];

  for (const n of topo.nodes) {
    const ctx = readContext(n.chatId);
    if (!ctx) { skipped.push(`${n.chatId} (no context file)`); continue; }

    // 1. Backfill parentChatId if topology has null but context records a parent
    if (n.parentChatId == null) {
      const ctxParent = ctx.inheritedFrom?.parentChatId ?? ctx.parentChatId ?? null;
      if (ctxParent) {
        console.log(`[parent] ${n.chatId}: null -> ${ctxParent}`);
        n.parentChatId = ctxParent;
        fixedParent++;
      }
    }

    // 2. Originate-type discrepancy: chat-context is usually authoritative
    //    (set at create time, no bumpMessage default-poisoning), BUT the
    //    sticky precedence in dispatchChatCreated (chat-created-handler) is
    //    `bot_spawned > human_created`. Mirror it here so backfill never
    //    downgrades a bot_spawned topology node into human_created based on
    //    a (possibly placeholder) chat-context. Manual flag for inspection
    //    when sticky blocks an apparent downgrade — 松松 / 妹妹可人工 audit.
    //
    //    Reference: src/im/lark/chat-created-handler.ts lines around the
    //    `existingTopoNode?.originType === 'bot_spawned'` block.
    if (ctx.originType && ctx.originType !== n.originType) {
      const wouldDowngrade = n.originType === 'bot_spawned' && ctx.originType !== 'bot_spawned';
      if (wouldDowngrade) {
        console.log(`[origin-skip] ${n.chatId}: bot_spawned ↛ ${ctx.originType} (sticky precedence; ctx may be archive-placeholder — audit manually if needed)`);
      } else {
        console.log(`[origin] ${n.chatId}: ${n.originType} -> ${ctx.originType}`);
        n.originType = ctx.originType;
        fixedOrigin++;
      }
    }
  }

  // 3. Drop test placeholder `oc_new` if present
  const newIdx = topo.nodes.findIndex(n => n.chatId === 'oc_new');
  if (newIdx >= 0) {
    console.log(`[drop] oc_new (test placeholder)`);
    topo.nodes.splice(newIdx, 1);
    // Also nuke the stale context file
    const ctxFp = join(CONTEXTS_DIR, 'oc_new.json');
    if (existsSync(ctxFp)) { unlinkSync(ctxFp); console.log(`[drop] ${ctxFp}`); }
  }

  // 4. Rebuild parent_child edges from current nodes (idempotent — full
  //    rebuild; previous half-baked edges cleared).
  const before = topo.edges.filter(e => e.type === 'parent_child').length;
  topo.edges = topo.edges.filter(e => e.type !== 'parent_child');
  for (const n of topo.nodes) {
    if (n.parentChatId) {
      topo.edges.push({
        type: 'parent_child',
        fromChatId: n.parentChatId,
        toChatId: n.chatId,
        rationale: 'backfill-from-topology-parent',
      });
    }
  }
  const after = topo.edges.filter(e => e.type === 'parent_child').length;
  console.log(`[edges] parent_child: ${before} -> ${after}`);

  topo.updatedAt = new Date().toISOString();
  writeTopoAtomic(topo);

  console.log('');
  console.log(`✅ Done: parent +${fixedParent}, origin +${fixedOrigin}, edges ${after}`);
  if (skipped.length) console.log(`⚠️  Skipped ${skipped.length}: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? '...' : ''}`);
}

main();

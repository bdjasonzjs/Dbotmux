/**
 * Chat topology store — the L1 data layer for main-bot mode.
 *
 * Holds the global graph of `ChatNode`s and `ChatEdge`s that the topology
 * dashboard tab (P4) renders, and that the L2 缇蕾 scout reads to compose
 * her digest.
 *
 * Layout: `${config.session.dataDir}/chat-topology.json` — **global**, not
 * per-bot. All daemons read/write the same file. Writes are atomic
 * (tmp + rename); since concurrent writers from different daemons are
 * possible, we read-modify-write under a best-effort assumption (last
 * writer wins for now — P2 may add file locking if conflicts appear in
 * dogfood).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { OriginType } from './chat-context-store.js';

export type Heat = 'hot' | 'warm' | 'cold';

/** Edge type — see designs §3.1. */
export type ChatEdgeType = 'parent_child' | 'same_topic' | 'spawned_from' | 'cross_ref';

export interface ChatNodeMetrics {
  /** ISO timestamp of the last observed message in this chat. */
  lastMessageAt: string | null;
  /** Number of messages observed in the last 24h. */
  messages24h: number;
  /** True iff there's an unanswered @松松 ping currently. */
  hasUnansweredPing: boolean;
}

export interface ChatNode {
  chatId: string;
  name: string;
  chatType: 'group' | 'topic_group' | 'p2p';
  originType: OriginType;
  parentChatId: string | null;
  tags: string[];
  metrics: ChatNodeMetrics;
  /** One-line summary maintained by L2 缇蕾 scout (10-50 chars). */
  summary: string;
}

export interface ChatEdge {
  type: ChatEdgeType;
  fromChatId: string;
  toChatId: string;
  rationale: string;
}

export interface ChatTopology {
  /** Root chat (default = Flumy 主话题; can be reconfigured). */
  rootChatId: string;
  nodes: ChatNode[];
  edges: ChatEdge[];
  updatedAt: string;
}

const TOPOLOGY_FILE = 'chat-topology.json';

function filePath(): string {
  return join(config.session.dataDir, TOPOLOGY_FILE);
}

function ensureDir(): void {
  const dir = dirname(filePath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function emptyTopology(): ChatTopology {
  return {
    rootChatId: '',
    nodes: [],
    edges: [],
    updatedAt: new Date().toISOString(),
  };
}

/** Read the current topology. Returns an empty topology if the file
 *  doesn't exist or is corrupt. */
export function readTopology(): ChatTopology {
  const fp = filePath();
  if (!existsSync(fp)) return emptyTopology();
  try {
    return JSON.parse(readFileSync(fp, 'utf-8')) as ChatTopology;
  } catch (err) {
    logger.error(`[chat-topology-store] failed to parse ${fp}: ${err}`);
    return emptyTopology();
  }
}

/** Overwrite the topology file (atomic via tmp + rename). */
export function writeTopology(topo: ChatTopology): void {
  ensureDir();
  const fp = filePath();
  const tmpFp = fp + '.tmp';
  const next: ChatTopology = { ...topo, updatedAt: new Date().toISOString() };
  writeFileSync(tmpFp, JSON.stringify(next, null, 2), 'utf-8');
  renameSync(tmpFp, fp);
}

/** P1 (commit #2): set the topology's rootChatId (= mainTopicChatId).
 *  Called by main-topic-config.setMainTopicChatId so the two stay
 *  aligned — don't duplicate this rule elsewhere. */
export function setRootChatId(chatId: string): void {
  const topo = readTopology();
  if (topo.rootChatId === chatId) return;
  topo.rootChatId = chatId;
  writeTopology(topo);
}

/** Upsert a node by chatId (replaces existing node with same chatId). */
export function upsertNode(node: ChatNode): void {
  const topo = readTopology();
  const idx = topo.nodes.findIndex(n => n.chatId === node.chatId);
  if (idx >= 0) {
    topo.nodes[idx] = node;
  } else {
    topo.nodes.push(node);
  }
  writeTopology(topo);
}

/** Get a node by chatId, or null if not present. */
export function getNode(chatId: string): ChatNode | null {
  const topo = readTopology();
  return topo.nodes.find(n => n.chatId === chatId) ?? null;
}

/** Add an edge if not already present (dedup by from+to+type). */
export function addEdge(edge: ChatEdge): void {
  const topo = readTopology();
  const dup = topo.edges.find(
    e => e.fromChatId === edge.fromChatId && e.toChatId === edge.toChatId && e.type === edge.type,
  );
  if (dup) return;
  topo.edges.push(edge);
  writeTopology(topo);
}

/** Bump a node's `messages24h` and `lastMessageAt`. Creates the node with
 *  minimal defaults if it doesn't exist (filled in later by L2 scout). */
export function bumpMessage(chatId: string, name?: string, originType?: OriginType): void {
  const topo = readTopology();
  let node = topo.nodes.find(n => n.chatId === chatId);
  if (!node) {
    node = {
      chatId,
      name: name ?? chatId,
      chatType: 'group',
      originType: originType ?? 'human_created',
      parentChatId: null,
      tags: [],
      metrics: { lastMessageAt: null, messages24h: 0, hasUnansweredPing: false },
      summary: '',
    };
    topo.nodes.push(node);
  }
  node.metrics.lastMessageAt = new Date().toISOString();
  node.metrics.messages24h += 1;
  writeTopology(topo);
}

/** Mark / unmark unanswered ping for a chat. */
export function setUnansweredPing(chatId: string, value: boolean): void {
  const topo = readTopology();
  const node = topo.nodes.find(n => n.chatId === chatId);
  if (!node) return;
  node.metrics.hasUnansweredPing = value;
  writeTopology(topo);
}

/** Compute heat from `lastMessageAt`. Pure helper, no IO. */
export function heatFromLastMessage(lastMessageAt: string | null): Heat {
  if (!lastMessageAt) return 'cold';
  const age = Date.now() - new Date(lastMessageAt).getTime();
  if (age < 60 * 60 * 1000) return 'hot';        // < 1h
  if (age < 24 * 60 * 60 * 1000) return 'warm';  // < 24h
  return 'cold';
}

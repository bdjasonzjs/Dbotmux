/**
 * Shared projection helpers for workflow operator surfaces.
 *
 * Used by CLI (`botmux workflow ls` / `tail`) and the dashboard backend.
 * All readers in here are pure: they never `mkdir` and never validate
 * caller-provided runIds as filesystem paths without going through
 * `isValidRunId` first.  Callers built on top of this module can hand
 * the resulting DTOs to JSON responses or to plain stdout printers
 * without worrying about side effects.
 *
 * Side-effect contract:
 *   - listRuns / readRunSnapshot / readEventWindow all return null / []
 *     instead of throwing when a run is missing or its event log is
 *     corrupt.  Corrupt = "any line fails parseEvent" — same boundary
 *     `EventLog.readAll` uses, except we don't crash the caller.
 *   - We DO NOT use `EventLog` here; EventLog's constructor mkdirs
 *     runDir + blobDir, which is wrong for a read-only API.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import {
  parseEvent,
  type WorkflowEvent,
} from './events/schema.js';
import {
  replay,
  type ActivityState,
  type NodeState,
  type RunState,
  type Snapshot,
} from './events/replay.js';
import type { OutputRef } from './events/payloads.js';

export const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * runId allowlist — must be passed BEFORE concatenating into a path.
 *
 * The runtime generates runIds via `crypto.randomUUID()` or operator-
 * supplied slugs (CLI / dogfood scripts); both fit `[A-Za-z0-9._-]`.
 * This guard rejects `.`, `..`, slashes, and anything else that could
 * escape `runsDir` via path traversal, plus empty strings.
 */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function isValidRunId(runId: string): boolean {
  return RUN_ID_RE.test(runId);
}

// ─── list ──────────────────────────────────────────────────────────────────

export type RunRow = {
  runId: string;
  workflowId: string;
  status: string;
  lastSeq: number;
  dEf: number;
  dAct: number;
  dWait: number;
  updatedAt: number;
  failedNodeId?: string;
  chatId?: string;
  larkAppId?: string;
};

export type ListRunsOptions = {
  /** Include terminal runs.  Default false (matches `botmux workflow ls`). */
  all?: boolean;
  /** Explicit status filter.  Wins over `all` when provided. */
  statuses?: Set<string>;
  /** Read chat-binding.json per row (extra fs op per run). */
  includeBinding?: boolean;
};

/**
 * Project every run in `runsDir` to a row.  Most-recently-updated first.
 *
 * - ENOENT on `runsDir` → `[]` (nothing to list).
 * - Non-directory entries / unreadable / corrupt event logs → skipped.
 * - Filter precedence: explicit `statuses` (any) > `all` (terminal kept) >
 *   default (terminal hidden).
 */
export async function listRuns(
  runsDir: string,
  opts: ListRunsOptions = {},
): Promise<RunRow[]> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await fs.readdir(runsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const wantStatuses = opts.statuses;
  const all = !!opts.all;

  const rows: RunRow[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    if (!isValidRunId(runId)) continue;

    const events = await readRunEventsPure(join(runsDir, runId));
    if (!events || events.length === 0) continue;

    let snap: Snapshot;
    try {
      snap = replay(events);
    } catch {
      continue;
    }
    const status = snap.run.status;
    if (wantStatuses) {
      if (!wantStatuses.has(status)) continue;
    } else if (!all && TERMINAL_RUN_STATUSES.has(status)) {
      continue;
    }

    const row = projectRunRow(runId, events, snap);
    if (opts.includeBinding) {
      const binding = await readChatBindingPure(join(runsDir, runId));
      if (binding) {
        row.chatId = binding.chatId;
        row.larkAppId = binding.larkAppId;
      }
    }
    rows.push(row);
  }

  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows;
}

export function projectRunRow(
  runId: string,
  events: WorkflowEvent[],
  snap: Snapshot,
): RunRow {
  // dAct = non-wait, non-effect dangling activities (worker-style bucket;
  // gates show up in dWait, effects in dEf).
  const effectSet = new Set(snap.danglingEffectAttempted);
  const waitSet = new Set(snap.danglingWaits);
  const dAct = snap.danglingActivities.filter(
    (a) => !effectSet.has(a) && !waitSet.has(a),
  ).length;

  return {
    runId,
    workflowId: snap.run.workflowId ?? '?',
    status: snap.run.status,
    lastSeq: snap.lastSeq,
    dEf: snap.danglingEffectAttempted.length,
    dAct,
    dWait: snap.danglingWaits.length,
    updatedAt: events[events.length - 1]!.timestamp,
    failedNodeId: snap.run.failedNodeId,
  };
}

// ─── snapshot ──────────────────────────────────────────────────────────────

export type RunSnapshotDTO = {
  runId: string;
  run: RunState;
  lastSeq: number;
  nodes: NodeState[];
  activities: ActivityState[];
  dangling: {
    activities: string[];
    effectAttempted: string[];
    waits: string[];
    cancels: string[];
  };
  outputs: Record<string, OutputRef>;
  chatBinding?: { chatId: string; larkAppId: string };
  updatedAt: number;
};

/**
 * Build a JSON-serializable snapshot for a single run.  Returns null when
 * the run is missing / has no events / has a corrupt log.  Callers
 * (dashboard `/snapshot` endpoint) should map null → 404.
 */
export async function readRunSnapshot(
  runsDir: string,
  runId: string,
): Promise<RunSnapshotDTO | null> {
  if (!isValidRunId(runId)) return null;
  const runDir = join(runsDir, runId);
  const events = await readRunEventsPure(runDir);
  if (!events || events.length === 0) return null;
  let snap: Snapshot;
  try {
    snap = replay(events);
  } catch {
    return null;
  }
  const binding = await readChatBindingPure(runDir);
  const outputs: Record<string, OutputRef> = {};
  for (const [aid, ref] of snap.outputs) outputs[aid] = ref;
  return {
    runId,
    run: snap.run,
    lastSeq: snap.lastSeq,
    nodes: [...snap.nodes.values()],
    activities: [...snap.activities.values()],
    dangling: {
      activities: snap.danglingActivities,
      effectAttempted: snap.danglingEffectAttempted,
      waits: snap.danglingWaits,
      cancels: snap.danglingCancels,
    },
    outputs,
    chatBinding: binding ?? undefined,
    updatedAt: events[events.length - 1]!.timestamp,
  };
}

// ─── event window ──────────────────────────────────────────────────────────

export type EventWindowOptions = {
  /** Initial fetch: last N events.  Ignored if before/afterSeq is set. */
  tail?: number;
  /** Cursor: events with seq < beforeSeq, returned in seq-asc order. */
  beforeSeq?: number;
  /** Cursor: events with seq > afterSeq, returned in seq-asc order. */
  afterSeq?: number;
  /** Page size for before/afterSeq.  Default 200, max 1000. */
  limit?: number;
};

export type EventWindow = {
  events: WorkflowEvent[];
  oldestSeq: number | null;
  newestSeq: number | null;
  totalCount: number;
  hasOlder: boolean;
  hasNewer: boolean;
};

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const DEFAULT_TAIL = 100;

/**
 * Slice a run's event log into a paginated window.
 *
 * Mode precedence: `afterSeq` > `beforeSeq` > `tail` (default).  This
 * matches the dashboard usage: detail page first loads `?tail=100`,
 * then polls `?afterSeq=<newest>` and back-scrolls `?beforeSeq=<oldest>`.
 *
 * Pagination bookkeeping (`hasOlder` / `hasNewer`) is computed from the
 * full event list and the returned slice's bounds.  Returns null if the
 * runId is invalid or the run is missing.
 */
export async function readEventWindow(
  runsDir: string,
  runId: string,
  opts: EventWindowOptions = {},
): Promise<EventWindow | null> {
  if (!isValidRunId(runId)) return null;
  const events = await readRunEventsPure(join(runsDir, runId));
  if (!events) return null;
  const total = events.length;
  if (total === 0) {
    return {
      events: [],
      oldestSeq: null,
      newestSeq: null,
      totalCount: 0,
      hasOlder: false,
      hasNewer: false,
    };
  }

  const limit = clampLimit(opts.limit);

  if (opts.afterSeq !== undefined && Number.isFinite(opts.afterSeq)) {
    const after = opts.afterSeq;
    const idx = events.findIndex((e) => eventSeqFromId(e.eventId) > after);
    if (idx < 0) {
      return {
        events: [],
        oldestSeq: null,
        newestSeq: null,
        totalCount: total,
        hasOlder: true,
        hasNewer: false,
      };
    }
    const slice = events.slice(idx, idx + limit);
    return {
      events: slice,
      oldestSeq: eventSeqFromId(slice[0]!.eventId),
      newestSeq: eventSeqFromId(slice[slice.length - 1]!.eventId),
      totalCount: total,
      hasOlder: idx > 0,
      hasNewer: idx + slice.length < total,
    };
  }

  if (opts.beforeSeq !== undefined && Number.isFinite(opts.beforeSeq)) {
    const before = opts.beforeSeq;
    const endIdx = events.findIndex((e) => eventSeqFromId(e.eventId) >= before);
    const exclusiveEnd = endIdx < 0 ? total : endIdx;
    const startIdx = Math.max(0, exclusiveEnd - limit);
    const slice = events.slice(startIdx, exclusiveEnd);
    if (slice.length === 0) {
      return {
        events: [],
        oldestSeq: null,
        newestSeq: null,
        totalCount: total,
        hasOlder: false,
        hasNewer: true,
      };
    }
    return {
      events: slice,
      oldestSeq: eventSeqFromId(slice[0]!.eventId),
      newestSeq: eventSeqFromId(slice[slice.length - 1]!.eventId),
      totalCount: total,
      hasOlder: startIdx > 0,
      hasNewer: exclusiveEnd < total,
    };
  }

  const tail =
    opts.tail !== undefined && Number.isFinite(opts.tail) && opts.tail > 0
      ? Math.min(Math.floor(opts.tail), MAX_LIMIT)
      : DEFAULT_TAIL;
  const startIdx = Math.max(0, total - tail);
  const slice = events.slice(startIdx);
  return {
    events: slice,
    oldestSeq: eventSeqFromId(slice[0]!.eventId),
    newestSeq: eventSeqFromId(slice[slice.length - 1]!.eventId),
    totalCount: total,
    hasOlder: startIdx > 0,
    hasNewer: false,
  };
}

function clampLimit(raw?: number): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(raw), MAX_LIMIT);
}

// ─── pure readers (no mkdir side effects) ──────────────────────────────────

async function readRunEventsPure(runDir: string): Promise<WorkflowEvent[] | null> {
  const file = join(runDir, 'events.ndjson');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const events: WorkflowEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return null;
    }
    try {
      events.push(parseEvent(obj));
    } catch {
      return null;
    }
  }
  return events;
}

async function readChatBindingPure(
  runDir: string,
): Promise<{ chatId: string; larkAppId: string } | null> {
  try {
    const raw = await fs.readFile(join(runDir, 'chat-binding.json'), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<{ chatId: string; larkAppId: string }>;
    if (!parsed.chatId || !parsed.larkAppId) return null;
    return { chatId: parsed.chatId, larkAppId: parsed.larkAppId };
  } catch {
    return null;
  }
}

// ─── event helpers ─────────────────────────────────────────────────────────

/**
 * Extract `<seq>` from a WorkflowEvent `eventId` of the form
 * `<runId>-<seq>` (events doc v0.1.2 §3.1).  Returns 0 for malformed
 * ids; callers should treat that as "unknown" rather than position 0.
 */
export function eventSeqFromId(eventId: string): number {
  const dash = eventId.lastIndexOf('-');
  if (dash < 0) return 0;
  const n = Number(eventId.slice(dash + 1));
  return Number.isFinite(n) ? n : 0;
}

export function extractEventContext(
  payload: unknown,
): { nodeId?: string; activityId?: string; errorCode?: string } {
  if (!payload || typeof payload !== 'object' || 'ref' in (payload as object)) {
    return {};
  }
  const p = payload as Record<string, unknown>;
  const out: { nodeId?: string; activityId?: string; errorCode?: string } = {};
  if (typeof p.nodeId === 'string') out.nodeId = p.nodeId;
  if (typeof p.activityId === 'string') out.activityId = p.activityId;
  if (typeof p.failedNodeId === 'string') out.nodeId = p.failedNodeId;
  const err = p.error;
  if (err && typeof err === 'object' && 'errorCode' in err) {
    out.errorCode = String((err as { errorCode: unknown }).errorCode);
  }
  return out;
}

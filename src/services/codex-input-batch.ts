/**
 * Immutable Codex pending-input batches.
 *
 * Codex's interactive input treats physical newlines as Enter presses. When
 * several Lark messages have accumulated, never concatenate them into a
 * multi-line PTY write. Instead, snapshot a bounded FIFO prefix into a unique
 * file and submit a short one-line instruction that points at that file.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { config } from '../config.js';

export const CODEX_BATCH_MIN_PENDING = 3;
export const CODEX_BATCH_MAX_MESSAGES = 20;
export const CODEX_BATCH_MAX_BYTES = 128 * 1024;
export const CODEX_BATCH_OLDEST_AGE_MS = 60_000;
export const CODEX_BATCH_RETAINED_MAX_FILES = 32;
export const CODEX_BATCH_RETAINED_MAX_BYTES = 4 * 1024 * 1024;

export interface PendingInputMetadata {
  kind: 'ordinary';
  messageId: string;
  createTime: string;
  sender: {
    openId: string;
    type: 'user' | 'bot';
    name?: string;
  };
  /** Human-facing card title for the single-message path. */
  title: string;
  /** Original Lark-side text before botmux's CLI wrappers were added. */
  originalContent: string;
}

export interface PendingInput {
  content: string;
  enqueuedAt: number;
  metadata?: PendingInputMetadata;
}

export interface MaterializedCodexBatch {
  batchId: string;
  count: number;
  path: string;
  sha: string;
  stub: string;
  ids: string[];
  callers: string[];
  title: string;
  createdAtMs: number;
  sizeBytes: number;
}

export interface CodexBatchDescriptor {
  batchId: string;
  count: number;
  path: string;
  createdAtMs: number;
  sizeBytes: number;
}

export interface BoundedCodexBatchDescriptors {
  retained: CodexBatchDescriptor[];
  evicted: CodexBatchDescriptor[];
  retainedBytes: number;
}

export interface PrepareBatchOptions {
  now?: number;
  materialize?: (sessionId: string, inputs: readonly PendingInput[]) => MaterializedCodexBatch;
  onError?: (error: unknown) => void;
}

const batchCounters = new Map<string, number>();

function safeSessionId(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe || 'unknown-session';
}

function batchDir(sessionId: string): string {
  const root = join(config.session.dataDir, 'input-batches');
  const dir = join(root, safeSessionId(sessionId));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

function nextBatchId(sessionId: string, dir: string): string {
  let current = batchCounters.get(sessionId);
  if (current === undefined) {
    current = 0;
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        const match = name.match(/^batch-(\d+)\.md$/);
        if (match) current = Math.max(current, Number(match[1]));
      }
    }
  }
  do { current += 1; } while (existsSync(join(dir, `batch-${current}.md`)));
  batchCounters.set(sessionId, current);
  return String(current);
}

function renderBatchContent(batchId: string, inputs: readonly PendingInput[]): string {
  const lines: string[] = [
    '# botmux immutable Codex input batch',
    '',
    `batch_id: ${batchId}`,
    `message_count: ${inputs.length}`,
    'delivery: immutable_snapshot',
    'payload_authority: botmux_cli_input_json',
    '',
    '> Process every message below exactly once and in the listed original order.',
    '> botmux_cli_input_json is the authoritative execution payload; original_message_json is audit-only.',
    '> Do not infer one default recipient for the whole batch. Mention recipients explicitly in reply text when needed.',
    `> On success, the final non-empty line must be exactly: ${batchReceiptLine(batchId, inputs.length)}`,
    '> On read or processing failure, reply only BLOCKED and do not emit a success receipt.',
  ];
  inputs.forEach((input, index) => {
    const meta = input.metadata!;
    lines.push(
      '',
      `## Message ${index + 1}/${inputs.length}`,
      `message_id: ${JSON.stringify(meta.messageId)}`,
      `create_time: ${JSON.stringify(meta.createTime)}`,
      `sender_open_id: ${JSON.stringify(meta.sender.openId)}`,
      `sender_type: ${JSON.stringify(meta.sender.type)}`,
      `sender_name: ${JSON.stringify(meta.sender.name ?? '')}`,
      `original_order: ${index + 1}`,
      `original_message_json: ${JSON.stringify(meta.originalContent)}`,
      `botmux_cli_input_json: ${JSON.stringify(input.content)}`,
    );
  });
  lines.push('', `END batch_id=${batchId} N=${inputs.length}`, '');
  return lines.join('\n');
}

/**
 * Pick a foldable FIFO prefix without mutating `pending`.
 * Missing metadata is a barrier (initial prompts and legacy callers retain
 * their existing byte-for-byte single-message path).
 */
export function selectCodexBatchInputs(
  pending: readonly PendingInput[],
  now = Date.now(),
): PendingInput[] {
  const ordinaryPrefix: PendingInput[] = [];
  for (const input of pending) {
    if (input.metadata?.kind !== 'ordinary') break;
    ordinaryPrefix.push(input);
  }
  if (ordinaryPrefix.length === 0) return [];
  const oldestAge = Math.max(0, now - ordinaryPrefix[0].enqueuedAt);
  if (ordinaryPrefix.length < CODEX_BATCH_MIN_PENDING && oldestAge < CODEX_BATCH_OLDEST_AGE_MS) return [];

  const selected: PendingInput[] = [];
  for (const input of ordinaryPrefix.slice(0, CODEX_BATCH_MAX_MESSAGES)) {
    const trial = [...selected, input];
    // Use a deliberately long numeric id so the eventual monotonic id cannot
    // make an already-selected snapshot cross the byte ceiling.
    if (Buffer.byteLength(renderBatchContent('99999999999999999999', trial), 'utf8') > CODEX_BATCH_MAX_BYTES) break;
    selected.push(input);
  }
  return selected;
}

export function materializeImmutableCodexBatch(
  sessionId: string,
  inputs: readonly PendingInput[],
): MaterializedCodexBatch {
  if (inputs.length === 0 || inputs.some(input => !input.metadata)) {
    throw new Error('Codex batch inputs require ordinary-message metadata');
  }
  const dir = batchDir(sessionId);
  pruneRetainedCodexBatchFiles(sessionId);
  let batchId = '';
  let content = '';
  let path = '';
  let sha = '';
  let stub = '';
  for (;;) {
    batchId = nextBatchId(sessionId, dir);
    content = renderBatchContent(batchId, inputs);
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    if (sizeBytes > CODEX_BATCH_MAX_BYTES) {
      throw new Error(`Codex batch exceeds ${CODEX_BATCH_MAX_BYTES} bytes`);
    }
    path = join(dir, `batch-${batchId}.md`);
    sha = createHash('sha256').update(content).digest('hex').slice(0, 12);
    stub = `读 ${path} N=${inputs.length} sha=${sha}；成功回执 batch_id=${batchId} ${inputs.length}/${inputs.length}（规范见文件）；失败:BLOCKED`;
    if (/[\r\n]/.test(stub)) throw new Error('Codex batch stub must be one physical line');
    if (stub.length >= 200) throw new Error(`Codex batch stub too long (${stub.length} chars)`);

    // Publish by hard-linking a private temp file. link(2) is an atomic
    // no-clobber create: unlike rename(), it fails with EEXIST instead of
    // replacing an already-published immutable batch.
    const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
    try {
      writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      linkSync(tmp, path);
      unlinkSync(tmp);
      pruneRetainedCodexBatchFiles(sessionId, [path]);
      break;
    } catch (err: any) {
      try { unlinkSync(tmp); } catch { /* best effort */ }
      if (err?.code === 'EEXIST') continue;
      throw err;
    }
  }

  const callers: string[] = [];
  for (const input of inputs) {
    const caller = input.metadata!.sender.openId;
    if (caller && !callers.includes(caller)) callers.push(caller);
  }
  return {
    batchId,
    count: inputs.length,
    path,
    sha,
    stub,
    ids: inputs.map(input => input.metadata!.messageId),
    callers,
    title: callers.length > 1
      ? `合并处理 ${inputs.length} 条（多发送者）`
      : `合并处理 ${inputs.length} 条`,
    createdAtMs: Date.now(),
    sizeBytes: Buffer.byteLength(content, 'utf8'),
  };
}

export function describeCodexBatch(batch: MaterializedCodexBatch): CodexBatchDescriptor {
  return {
    batchId: batch.batchId,
    count: batch.count,
    path: batch.path,
    createdAtMs: batch.createdAtMs,
    sizeBytes: batch.sizeBytes,
  };
}

export function boundCodexBatchDescriptors(
  descriptors: readonly CodexBatchDescriptor[],
): BoundedCodexBatchDescriptors {
  const retained = [...descriptors].sort((a, b) => a.createdAtMs - b.createdAtMs);
  const evicted: CodexBatchDescriptor[] = [];
  let retainedBytes = retained.reduce((total, item) => total + item.sizeBytes, 0);
  while (retained.length > CODEX_BATCH_RETAINED_MAX_FILES || retainedBytes > CODEX_BATCH_RETAINED_MAX_BYTES) {
    const oldest = retained.shift();
    if (!oldest) break;
    retainedBytes -= oldest.sizeBytes;
    evicted.push(oldest);
  }
  return { retained, evicted, retainedBytes };
}

export function deleteCodexBatchFile(path: string): boolean {
  if (!/^batch-\d+\.md$/.test(basename(path))) return false;
  try {
    unlinkSync(path);
    return true;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return true;
    return false;
  }
}

export interface CodexBatchPruneResult {
  retainedCount: number;
  retainedBytes: number;
  deletedPaths: string[];
}

/** Bound retained/unconfirmed snapshots per session. Confirmed files are
 * deleted immediately by the worker; this cap covers missing-receipt files
 * and crash leftovers discovered by a later materialization. */
export function pruneRetainedCodexBatchFiles(
  sessionId: string,
  protectedPaths: readonly string[] = [],
): CodexBatchPruneResult {
  const dir = batchDir(sessionId);
  const protectedSet = new Set(protectedPaths);
  const files = readdirSync(dir)
    .filter(name => /^batch-\d+\.md$/.test(name))
    .map(name => {
      const path = join(dir, name);
      const stat = statSync(path);
      return { path, size: stat.size, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => Number(protectedSet.has(b.path)) - Number(protectedSet.has(a.path))
      || b.mtimeMs - a.mtimeMs
      || b.path.localeCompare(a.path));
  const deletedPaths: string[] = [];
  let retainedCount = 0;
  let retainedBytes = 0;
  for (const file of files) {
    const canRetain = protectedSet.has(file.path) || (
      retainedCount < CODEX_BATCH_RETAINED_MAX_FILES
      && retainedBytes + file.size <= CODEX_BATCH_RETAINED_MAX_BYTES
    );
    if (canRetain) {
      retainedCount += 1;
      retainedBytes += file.size;
    } else if (deleteCodexBatchFile(file.path)) {
      deletedPaths.push(file.path);
    }
  }
  return { retainedCount, retainedBytes, deletedPaths };
}

/**
 * Materialize first, then consume. A write failure leaves the queue exactly
 * untouched so the worker can fall back to its existing one-item FIFO path.
 */
export function tryPrepareCodexBatch(
  sessionId: string,
  pending: PendingInput[],
  options: PrepareBatchOptions = {},
): MaterializedCodexBatch | null {
  const selected = selectCodexBatchInputs(pending, options.now ?? Date.now());
  if (selected.length === 0) return null;
  try {
    const materialize = options.materialize ?? materializeImmutableCodexBatch;
    const batch = materialize(sessionId, selected);
    pending.splice(0, selected.length);
    return batch;
  } catch (error) {
    options.onError?.(error);
    return null;
  }
}

export function makePendingInput(
  content: string,
  metadata?: PendingInputMetadata,
  enqueuedAt = Date.now(),
): PendingInput {
  return { content, metadata, enqueuedAt };
}

export function batchReceiptLine(batchId: string, count: number): string {
  return `BOTMUX_BATCH_RECEIPT batch_id=${batchId} processed=${count}/${count} status=ok`;
}

export function hasBatchReceipt(text: string, batchId: string, count: number): boolean {
  if (/\bBLOCKED\b/i.test(text)) return false;
  for (const match of text.matchAll(/\bstatus\s*=\s*([^\s]+)/gi)) {
    if (match[1]?.toLowerCase() !== 'ok') return false;
  }
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.at(-1) === batchReceiptLine(batchId, count);
}

export function __resetBatchIdsForTesting(): void {
  batchCounters.clear();
}

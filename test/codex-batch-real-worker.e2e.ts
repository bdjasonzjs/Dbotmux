/**
 * Opt-in real-worker proof for the Codex immutable backlog batch.
 *
 * Run after `pnpm build` with BOTMUX_RUN_REAL_CODEX_BATCH_E2E=1 and the
 * current test chat/root env vars. This forks the built worker, launches the
 * real Codex TUI, queues three senders behind a live prelude turn, and waits
 * for the worker's receipt-confirmation log. It never restarts/deploys botmux.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyInputStartedMetadata } from '../src/core/input-started-metadata.js';
import { hasBatchReceipt } from '../src/services/codex-input-batch.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import type { DaemonSession } from '../src/core/types.js';

const RUN = process.env.BOTMUX_RUN_REAL_CODEX_BATCH_E2E === '1';
const CHAT_ID = process.env.BOTMUX_E2E_CHAT_ID ?? '';
const ROOT_MESSAGE_ID = process.env.BOTMUX_E2E_ROOT_MESSAGE_ID ?? '';
const OWNER_OPEN_ID = process.env.BOTMUX_E2E_OWNER_OPEN_ID ?? '';
const APP_ID = process.env.LARK_APP_ID ?? '';
const APP_SECRET = process.env.LARK_APP_SECRET ?? '';
const EVIDENCE_PATH = process.env.BOTMUX_E2E_EVIDENCE_PATH ?? join(tmpdir(), 'codex-batch-real-worker-evidence.json');

const enabled = RUN && !!CHAT_ID && !!ROOT_MESSAGE_ID && !!OWNER_OPEN_ID && !!APP_ID && !!APP_SECRET;

describe.skipIf(!enabled)('real Codex worker backlog batch', () => {
  let worker: ChildProcess | undefined;
  let tmp: string | undefined;

  afterEach(async () => {
    if (worker && worker.connected) {
      try { worker.send({ type: 'close' } satisfies DaemonToWorker); } catch { /* ignore */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    try { worker?.kill('SIGTERM'); } catch { /* ignore */ }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('drains three queued senders as one stub and confirms batch_id + 3/3', async () => {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const worktree = process.cwd();
    const workerPath = join(worktree, 'dist', 'worker.js');
    const cliPath = join(worktree, 'dist', 'cli.js');
    expect(existsSync(workerPath), 'run pnpm build before this opt-in test').toBe(true);
    expect(existsSync(cliPath), 'run pnpm build before this opt-in test').toBe(true);
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
    const gitStatusPorcelain = execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' });
    const distWorkerSha256 = createHash('sha256').update(readFileSync(workerPath)).digest('hex');
    const distCliSha256 = createHash('sha256').update(readFileSync(cliPath)).digest('hex');
    const codexVersion = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim();
    expect(gitStatusPorcelain, 'real proof must run from the final clean commit').toBe('');
    expect(distWorkerSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(distCliSha256).toMatch(/^[0-9a-f]{64}$/);

    tmp = join(tmpdir(), `botmux-real-batch-${randomUUID()}`);
    const dataDir = join(tmp, 'data');
    const binDir = join(tmp, 'bin');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const sid = randomUUID();
    const fakeSession = {
      sessionId: sid,
      chatId: CHAT_ID,
      chatType: 'group',
      rootMessageId: ROOT_MESSAGE_ID,
      scope: 'chat',
      title: 'Codex batch real-worker E2E',
      status: 'active',
      createdAt: new Date().toISOString(),
      larkAppId: APP_ID,
      ownerOpenId: OWNER_OPEN_ID,
      lastCallerOpenId: 'ou_stale_should_not_be_used',
      suppressImplicitAddressing: false,
      workingDir: worktree,
      cliId: 'codex',
    };
    const sessionsPath = join(dataDir, `sessions-${APP_ID}.json`);
    writeFileSync(sessionsPath, JSON.stringify({ [sid]: fakeSession }, null, 2));

    const botmuxWrapper = join(binDir, 'botmux');
    writeFileSync(botmuxWrapper, `#!/bin/sh\nexec node ${JSON.stringify(join(worktree, 'dist', 'cli.js'))} "$@"\n`);
    chmodSync(botmuxWrapper, 0o755);

    const ds = {
      session: fakeSession,
      worker: null, workerPort: null, workerToken: null,
      larkAppId: APP_ID, chatId: CHAT_ID, chatType: 'group', scope: 'chat',
      spawnedAt: Date.now(), cliVersion: 'real-e2e', lastMessageAt: Date.now(), hasHistory: false,
      currentTurnTitle: 'prelude',
    } as unknown as DaemonSession;

    const ipc: WorkerToDaemon[] = [];
    const logs: string[] = [];
    let preludeSent = false;
    let backlogSent = false;
    let batchStarted: Extract<WorkerToDaemon, { type: 'input_started' }> | undefined;
    let batchBody = '';
    let metadataAfterBatch: Record<string, unknown> | undefined;

    worker = fork(workerPath, [], {
      cwd: worktree,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: sid,
        BOTMUX_CODEX_INPUT_BATCH: '1',
        BOTMUX_SHOW_CARD_FOOTER: '1',
        LARK_APP_ID: APP_ID,
        LARK_APP_SECRET: APP_SECRET,
      },
    });
    worker.stdout?.on('data', data => logs.push(data.toString()));
    worker.stderr?.on('data', data => logs.push(`[stderr] ${data.toString()}`));

    const sendMessage = (content: string, id: string, caller: string, name: string) => {
      worker!.send({
        type: 'message',
        content,
        metadata: {
          kind: 'ordinary', messageId: id, createTime: String(Date.now()),
          sender: { openId: caller, type: 'user', name },
          title: content.slice(0, 50), originalContent: content,
        },
      } satisfies DaemonToWorker);
    };

    const completion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`real worker timed out\n${logs.join('')}`)), 240_000);
      worker!.on('error', reject);
      worker!.on('exit', code => {
        if (code && code !== 0) reject(new Error(`worker exited ${code}\n${logs.join('')}`));
      });
      worker!.on('message', (raw: WorkerToDaemon) => {
        ipc.push(raw);
        if (raw.type === 'prompt_ready' && !preludeSent) {
          preludeSent = true;
          sendMessage(
            '闭环前置轮：请用 shell 执行 sleep 10；完成后只在终端回复 PRELUDE_DONE，不要调用 botmux send。',
            'om_prelude', 'ou_prelude', 'prelude',
          );
        }
        if (raw.type === 'input_started' && raw.ids.includes('om_prelude') && !backlogSent) {
          backlogSent = true;
          sendMessage('闭环批次第1条：记住 token ALPHA；等待同批其余消息后统一处理。', 'om_batch_1', 'ou_owner_e2e', 'owner-e2e');
          sendMessage('闭环批次第2条：记住 token BETA；等待同批其余消息后统一处理。', 'om_batch_2', 'ou_parent_e2e', 'parent-e2e');
          sendMessage('闭环批次第3条：记住 token GAMMA。处理完三条后执行 botmux send，正文必须包含 REAL_CODEX_BATCH_E2E、ALPHA、BETA、GAMMA，且最后一行严格使用文件要求的 BOTMUX_BATCH_RECEIPT；正文不要 @ 任何人；终端最终回复同样把规范回执放在最后一行。', 'om_batch_3', 'ou_reviewer_e2e', 'reviewer-e2e');
        }
        if (raw.type === 'input_started' && raw.batch) {
          batchStarted = raw;
          batchBody = readFileSync(raw.batch.path, 'utf8');
          const applied = applyInputStartedMetadata(ds, raw);
          if (applied.title) ds.currentTurnTitle = applied.title;
          writeFileSync(sessionsPath, JSON.stringify({ [sid]: ds.session }, null, 2));
          metadataAfterBatch = {
            currentTurnTitle: ds.currentTurnTitle,
            lastCallerOpenId: ds.session.lastCallerOpenId,
            suppressImplicitAddressing: ds.session.suppressImplicitAddressing,
          };
        }
      });

      const interval = setInterval(() => {
        const all = logs.join('');
        if (/Codex batch receipt confirmed \(batch_id=\d+, 3\/3,/.test(all)) {
          clearInterval(interval);
          clearTimeout(timeout);
          resolve();
        }
      }, 250);
    });

    worker.send({
      type: 'init', sessionId: sid, chatId: CHAT_ID, rootMessageId: ROOT_MESSAGE_ID,
      workingDir: worktree, cliId: 'codex', backendType: 'pty', prompt: '',
      larkAppId: APP_ID, larkAppSecret: APP_SECRET, ownerOpenId: OWNER_OPEN_ID, webPort: 0,
      botName: 'Codex batch E2E', locale: 'zh',
    } satisfies DaemonToWorker);

    await completion;

    expect(batchStarted?.ids).toEqual(['om_batch_1', 'om_batch_2', 'om_batch_3']);
    expect(batchStarted?.callers).toEqual(['ou_owner_e2e', 'ou_parent_e2e', 'ou_reviewer_e2e']);
    expect(batchStarted?.pendingCount).toBe(0);
    expect(batchStarted?.title).toBe('合并处理 3 条（多发送者）');
    expect(batchStarted?.cliInput).not.toMatch(/[\r\n]/);
    expect(batchBody).toContain('message_id: "om_batch_1"');
    expect(batchBody).toContain('message_id: "om_batch_2"');
    expect(batchBody).toContain('message_id: "om_batch_3"');
    expect(metadataAfterBatch).toEqual({
      currentTurnTitle: '合并处理 3 条（多发送者）',
      lastCallerOpenId: 'ou_stale_should_not_be_used',
      suppressImplicitAddressing: true,
    });

    // A successful `botmux send` intentionally suppresses bridge final_output,
    // so verify the actual Lark-visible message via the origin session history.
    const history = JSON.parse(execFileSync('botmux', ['history', '--scope', 'session', '--limit', '20'], {
      encoding: 'utf8',
    })) as { messages?: Array<{ content?: string; createTime?: string }> };
    const visibleMessage = history.messages?.findLast(message =>
      Number(message.createTime ?? 0) >= startedAtMs
      && message.content?.includes('REAL_CODEX_BATCH_E2E'),
    );
    expect(visibleMessage?.content).toContain('ALPHA');
    expect(visibleMessage?.content).toContain('BETA');
    expect(visibleMessage?.content).toContain('GAMMA');
    expect(hasBatchReceipt(visibleMessage?.content ?? '', batchStarted!.batch!.batchId, 3)).toBe(true);
    expect(visibleMessage?.content).not.toContain('发送给：');
    const batchFileDeleted = !existsSync(batchStarted!.batch!.path);
    expect(batchFileDeleted).toBe(true);

    mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
    writeFileSync(EVIDENCE_PATH, JSON.stringify({
      startedAt,
      endedAt: new Date().toISOString(),
      headSha,
      worktreeClean: gitStatusPorcelain === '',
      gitStatusPorcelain,
      distWorkerSha256,
      distCliSha256,
      codexVersion,
      sessionId: sid,
      inputQueuedCounts: ipc.filter((m): m is Extract<WorkerToDaemon, { type: 'input_queued' }> => m.type === 'input_queued').map(m => m.pendingCount),
      batchStarted,
      metadataAfterBatch,
      batchFile: batchStarted?.batch?.path,
      batchFileDeleted,
      batchEndMarker: batchBody.trimEnd().split('\n').at(-1),
      receiptLog: logs.join('').split('\n').find(line => line.includes('Codex batch receipt confirmed')),
      visibleMessage,
    }, null, 2));
  }, 260_000);
});

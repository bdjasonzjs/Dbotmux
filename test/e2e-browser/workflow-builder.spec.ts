import { test, expect } from '@playwright/test';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

import { EventLog } from '../../src/workflows/events/append.js';
import { replay, type Snapshot } from '../../src/workflows/events/replay.js';
import { parseWorkflowDefinition, type WorkflowDefinition } from '../../src/workflows/definition.js';
import { runLoop } from '../../src/workflows/loop.js';
import { createRun } from '../../src/workflows/run-init.js';
import { flowWorkActivityId } from '../../src/workflows/stateflow.js';
import { resolveReviewDecision } from '../../src/workflows/wait.js';

const root = join(process.cwd(), 'dist', 'dashboard-web');
let server: Server;
let baseUrl: string;
let savedDefinition: any;
let currentRunRow: any;
let currentSnapshot: any;
let currentEvents: any[] = [];

test.use({
  launchOptions: {
    executablePath: join(
      homedir(),
      '.cache',
      'ms-playwright',
      'chromium-1208',
      'chrome-linux64',
      'chrome',
    ),
  },
});

test.beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/api/sessions') return json(res, { sessions: [] });
    if (url.pathname === '/api/schedules') return json(res, { schedules: [] });
    if (url.pathname === '/api/workflows/runs') {
      return json(res, {
        runs: [currentRunRow ?? {
          runId: 'run-review-1',
          workflowId: 'development-review-flow',
          status: 'waiting',
          lastSeq: 42,
          dEf: 0,
          dAct: 1,
          dWait: 1,
          updatedAt: Date.now(),
          chatId: 'oc_review',
          larkAppId: 'cli_app',
        }],
      });
    }
    if (url.pathname === '/api/workflows/runs/run-review-1/snapshot') {
      return json(res, currentSnapshot ?? {
        runId: 'run-review-1',
        run: {
          runId: 'run-review-1',
          status: 'waiting',
          workflowId: 'development-review-flow',
          revisionId: 'sha256:abc',
        },
        lastSeq: 42,
        nodes: [
          { nodeId: 'develop', status: 'succeeded', retryCount: 0 },
          { nodeId: 'submit', status: 'succeeded', retryCount: 0 },
          { nodeId: 'review', status: 'waiting', activityId: 'run-review-1::work::review::v2', retryCount: 0 },
        ],
        activities: [{
          activityId: 'run-review-1::work::review::v2',
          ownerNodeId: 'review',
          status: 'waiting',
          attempts: [{ attemptId: 'att-review-2', attemptNumber: 2, status: 'waiting' }],
          currentAttemptId: 'att-review-2',
        }],
        dangling: { activities: [], effectAttempted: [], waits: [], cancels: [] },
        outputs: {},
        attemptIO: {},
        chatBinding: { chatId: 'oc_review', larkAppId: 'cli_app' },
        updatedAt: Date.now(),
      });
    }
    if (url.pathname === '/api/workflows/runs/run-review-1/events') {
      return json(res, {
        events: currentEvents.length > 0 ? currentEvents : [{
          eventId: '00000000000000000042',
          runId: 'run-review-1',
          type: 'activityWaiting',
          actor: 'scheduler',
          timestamp: Date.now(),
          payload: { nodeId: 'review', activityId: 'run-review-1::work::review::v2' },
        }],
        oldestSeq: 42,
        newestSeq: 42,
        totalCount: 1,
        hasOlder: false,
        hasNewer: false,
      });
    }
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write('event: heartbeat\ndata: {"body":{}}\n\n');
      return;
    }
    if (url.pathname === '/api/workflows/definitions' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      savedDefinition = JSON.parse(Buffer.concat(chunks).toString('utf-8')).definition;
      return json(res, {
        ok: true,
        workflowId: savedDefinition.workflowId,
        path: `/tmp/${savedDefinition.workflowId}.workflow.json`,
      });
    }
    const assetAliases: Record<string, string> = {
      '/assets/app.js': 'app.js',
      '/assets/style.css': 'style.css',
    };
    const file = url.pathname === '/' ? 'index.html' : (assetAliases[url.pathname] ?? url.pathname.slice(1));
    const path = join(root, file);
    try {
      const s = await stat(path);
      if (!s.isFile()) throw new Error('not file');
      res.writeHead(200, { 'content-type': contentType(path) });
      createReadStream(path).pipe(res);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server did not bind tcp');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

test('PM can configure and save the review loop without editing JSON', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.goto(`${baseUrl}/#/workflows/builder`);
  await page.waitForTimeout(250);
  expect(pageErrors).toEqual([]);
  await expect(page.getByRole('heading', { name: /可视化工作流编排器|Visual Workflow Builder/ })).toBeVisible();
  await expect(page.getByLabel(/可视化工作流画布|Visual workflow canvas/i)).toBeVisible();
  await expect(page.locator('.builder-flowchart')).toContainText('①');
  await expect(page.locator('.builder-flowchart')).toContainText('②');
  await expect(page.locator('.builder-flowchart')).toContainText('③');
  await expect(page.locator('.builder-flowchart')).toContainText('④');
  await expect(page.locator('.builder-arrow-main')).toHaveCount(3);
  await page.locator('.builder-branch[data-transition="review-reject"]').click();
  await expect(page.locator('#builder-edge-editor')).toContainText(/Reviewer.*打回|打回.*Reviewer/);
  await expect(page.locator('#builder-edge-editor')).toContainText(/回到开发者返工/);
  await expect(page.locator('main')).not.toContainText(/outputEquals|nodeId|value\.decision|visitCountLessThan|visitCountAtLeast/i);
  await page.locator('.builder-step[data-node="develop"]').dragTo(page.locator('.builder-step[data-node="review"]'));
  await page.getByLabel(/审查轮数|Review rounds/).fill('3');
  await page.getByLabel(/添加 Observer|Add Observer/).check();
  await expect(page.locator('.builder-flowchart')).toContainText('⓪');
  await expect(page.locator('.builder-branch-map')).toContainText('打回循环');
  await page.locator('.builder-branch[data-transition="review-pass"]').click();
  await expect(page.locator('#builder-edge-editor')).toContainText(/进入汇报员总结/);
  await page.locator('.builder-branch[data-transition="review-reject-limit"]').click();
  await expect(page.locator('#builder-edge-editor')).toContainText(/人工兜底/);
  await page.getByRole('button', { name: /保存工作流|Save workflow/ }).click();
  await expect.poll(() => savedDefinition?.flow?.transitions?.length).toBeGreaterThan(0);
  expect(JSON.stringify(savedDefinition)).toContain('outputEquals');
  expect(JSON.stringify(savedDefinition)).toContain('value.decision');
  expect(JSON.stringify(savedDefinition)).toContain('visitCountLessThan');
  expect(JSON.stringify(savedDefinition)).toContain('visitCountAtLeast');
  expect(JSON.stringify(savedDefinition.nodes.review)).toContain('humanGate');
  expect(JSON.stringify(savedDefinition.nodes.review)).not.toContain('"decision":"approved"');
  expect(JSON.stringify(savedDefinition)).not.toContain('lastSeq');
});

test('full review workflow runs rework loop then approval report from builder config', async ({ page }) => {
  await page.goto(`${baseUrl}/#/workflows/builder`);
  await page.getByLabel(/审查轮数|Review rounds/).fill('2');
  await page.getByRole('button', { name: /保存工作流|Save workflow/ }).click();
  await expect.poll(() => savedDefinition?.workflowId).toBe('development-review-flow');

  const def = parseWorkflowDefinition(savedDefinition);
  const tempDir = await mkdtemp(join(tmpdir(), 'wf-full-e2e-'));
  try {
    const { log, first, second, finalSnapshot } = await runRejectThenApprove(def, tempDir);
    expect(first.activities.get(flowWorkActivityId(log.runId, 'review', 1))?.attempts.at(-1)?.wait?.waitKind)
      .toBe('human-gate');
    expect(second.activities.get(flowWorkActivityId(log.runId, 'review', 2))?.attempts.at(-1)?.wait?.waitKind)
      .toBe('human-gate');
    expect(second.outputs.has(flowWorkActivityId(log.runId, 'develop', 2))).toBe(true);
    expect(second.outputs.has(flowWorkActivityId(log.runId, 'report', 1))).toBe(false);
    expect(finalSnapshot.run.status).toBe('succeeded');
    expect(finalSnapshot.outputs.has(flowWorkActivityId(log.runId, 'report', 1))).toBe(true);

    publishSnapshot(log.runId, finalSnapshot, await log.readAll());
    await page.goto(`${baseUrl}/#/workflows`);
    await expect(page.locator('#wf-tbody')).toContainText(/流程已完成|completed|succeeded/i);
    await page.getByRole('link', { name: 'run-review-1' }).click();
    await expect(page.locator('#wf-summary')).toContainText(/流程已完成|completed/i);
    await expect(page.locator('#wf-summary')).toContainText(/汇报员|reporter/i);
    await expect(page.locator('main')).not.toContainText(/lastSeq|dangling|dEf|dAct|dWait/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('changing only workflow config changes rejected path to failed review limit', async ({ page }) => {
  await page.goto(`${baseUrl}/#/workflows/builder`);
  await page.getByLabel(/审查轮数|Review rounds/).fill('1');
  await page.getByRole('button', { name: /保存工作流|Save workflow/ }).click();
  await expect.poll(() => savedDefinition?.flow?.transitions?.length).toBeGreaterThan(0);

  const oneRound = parseWorkflowDefinition(savedDefinition);
  const tempDir = await mkdtemp(join(tmpdir(), 'wf-config-source-e2e-'));
  try {
    const { finalSnapshot } = await runSingleReject(oneRound, tempDir);
    expect(finalSnapshot.run.status).toBe('failed');
    expect(finalSnapshot.run.failedNodeId).toBe('review_failed');
    expect(finalSnapshot.outputs.has(flowWorkActivityId(finalSnapshot.run.runId, 'develop', 2))).toBe(false);
    expect(JSON.stringify(oneRound.flow?.transitions)).toContain('"count":1');

    await page.goto(`${baseUrl}/#/workflows/builder`);
    await page.getByLabel(/审查轮数|Review rounds/).fill('2');
    await page.getByRole('button', { name: /保存工作流|Save workflow/ }).click();
    await expect.poll(() => JSON.stringify(savedDefinition?.flow?.transitions ?? [])).toContain('"count":2');
    expect(JSON.stringify(savedDefinition.flow.transitions)).toContain('visitCountLessThan');
    expect(JSON.stringify(savedDefinition.flow.transitions)).toContain('visitCountAtLeast');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run board presents workflow status without internal recovery jargon', async ({ page }) => {
  resetMockWorkflowState();
  await page.goto(`${baseUrl}/#/workflows`);
  await expect(page.getByRole('columnheader', { name: /当前进展|progress/i })).toBeVisible();
  await expect(page.locator('#wf-tbody')).toContainText(/等待中|waiting/i);
  await expect(page.locator('main')).not.toContainText(/lastSeq|dangling|dEf|dAct|dWait/i);
  await page.getByRole('link', { name: 'run-review-1' }).click();
  await expect(page.locator('#wf-detail-subtitle')).toContainText(/Reviewer.*等待|Reviewer.*waiting/i);
  await expect(page.locator('#wf-summary')).toContainText(/当前进展|progress/i);
});

function json(res: any, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function contentType(path: string): string {
  if (path.endsWith('.js')) return 'application/javascript';
  if (path.endsWith('.css')) return 'text/css';
  if (path.endsWith('.html')) return 'text/html';
  return 'application/octet-stream';
}

async function runRejectThenApprove(def: WorkflowDefinition, baseDir: string): Promise<{
  log: EventLog;
  first: Snapshot;
  second: Snapshot;
  finalSnapshot: Snapshot;
}> {
  const log = new EventLog('run-review-1', baseDir);
  await createRun(log, { def, params: {}, initiator: 'e2e', botResolver: () => undefined });
  const firstResult = await runLoop(ctx(log, def), { maxTicks: 20 });
  const first = firstResult.lastSnapshot;
  const review1 = first.activities.get(flowWorkActivityId(log.runId, 'review', 1));
  expect(firstResult.reason).toBe('awaiting-wait');
  expect(review1?.attempts.at(-1)?.wait?.waitKind).toBe('human-gate');
  await resolveReviewDecision(log, {
    activityId: review1!.activityId,
    attemptId: review1!.currentAttemptId!,
    resolution: 'rejected',
    by: 'ou_reviewer',
    comment: 'needs changes',
  });

  const secondResult = await runLoop(ctx(log, def), { maxTicks: 20 });
  const second = secondResult.lastSnapshot;
  const review2 = second.activities.get(flowWorkActivityId(log.runId, 'review', 2));
  expect(secondResult.reason).toBe('awaiting-wait');
  expect(review2?.attempts.at(-1)?.wait?.waitKind).toBe('human-gate');
  await resolveReviewDecision(log, {
    activityId: review2!.activityId,
    attemptId: review2!.currentAttemptId!,
    resolution: 'approved',
    by: 'ou_reviewer',
    comment: 'approved after rework',
  });

  const finalResult = await runLoop(ctx(log, def), { maxTicks: 20 });
  expect(finalResult.reason).toBe('terminal');
  return { log, first, second, finalSnapshot: finalResult.lastSnapshot };
}

async function runSingleReject(def: WorkflowDefinition, baseDir: string): Promise<{
  log: EventLog;
  finalSnapshot: Snapshot;
}> {
  const log = new EventLog('run-review-1', baseDir);
  await createRun(log, { def, params: {}, initiator: 'e2e', botResolver: () => undefined });
  const firstResult = await runLoop(ctx(log, def), { maxTicks: 20 });
  const review1 = firstResult.lastSnapshot.activities.get(flowWorkActivityId(log.runId, 'review', 1));
  expect(firstResult.reason).toBe('awaiting-wait');
  await resolveReviewDecision(log, {
    activityId: review1!.activityId,
    attemptId: review1!.currentAttemptId!,
    resolution: 'rejected',
    by: 'ou_reviewer',
  });
  const finalResult = await runLoop(ctx(log, def), { maxTicks: 20 });
  expect(finalResult.reason).toBe('terminal');
  return { log, finalSnapshot: finalResult.lastSnapshot };
}

function ctx(log: EventLog, def: WorkflowDefinition) {
  return {
    log,
    def,
    spawnSubagent: async () => {
      throw new Error('workflow product E2E should use semantic nodes only');
    },
  };
}

function publishSnapshot(runId: string, snapshot: Snapshot, events: any[]): void {
  currentRunRow = {
    runId: 'run-review-1',
    workflowId: snapshot.run.workflowId ?? 'development-review-flow',
    status: snapshot.run.status,
    lastSeq: events.length,
    dEf: 0,
    dAct: 0,
    dWait: 0,
    updatedAt: Date.now(),
    chatId: 'oc_review',
    larkAppId: 'cli_app',
    failedNodeId: snapshot.run.failedNodeId,
  };
  currentSnapshot = {
    runId: 'run-review-1',
    run: { ...snapshot.run, runId: 'run-review-1' },
    lastSeq: events.length,
    nodes: Array.from(snapshot.nodes.values()),
    activities: Array.from(snapshot.activities.values()),
    dangling: { activities: [], effectAttempted: [], waits: [], cancels: [] },
    outputs: Object.fromEntries(snapshot.outputs.entries()),
    attemptIO: {},
    chatBinding: { chatId: 'oc_review', larkAppId: 'cli_app' },
    updatedAt: Date.now(),
  };
  currentEvents = events.map((event, index) => ({
    ...event,
    runId: 'run-review-1',
    eventId: event.eventId ?? String(index + 1).padStart(20, '0'),
  }));
  void runId;
}

function resetMockWorkflowState(): void {
  currentRunRow = undefined;
  currentSnapshot = undefined;
  currentEvents = [];
}

import { test, expect, type Page } from '@playwright/test';
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
let updatedDefinition: any;
let deletedWorkflowId: string | undefined;
let currentRunRow: any;
let currentSnapshot: any;
let currentEvents: any[] = [];
let workflowStore = new Map<string, WorkflowDefinition>();

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
    if (url.pathname === '/api/workflows/bots') {
      return json(res, {
        bots: [
          { larkAppId: 'cli_app', botName: '寇黛克斯', online: true },
          { larkAppId: 'claude_app', botName: '克劳德', online: true },
        ],
      });
    }
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
    if (url.pathname === '/api/workflows/definitions' && req.method === 'GET') {
      return json(res, {
        definitions: Array.from(workflowStore.values()).map((definition) => ({
          workflowId: definition.workflowId,
          version: definition.version,
          path: `/tmp/${definition.workflowId}.workflow.json`,
          revisionId: `test:${definition.workflowId}`,
          nodeCount: Object.keys(definition.nodes).length,
        })),
      });
    }
    if (url.pathname === '/api/workflows/definitions/validate' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const definition = parseWorkflowDefinition(body.definition);
        return json(res, {
          ok: true,
          workflowId: definition.workflowId,
          nodeCount: Object.keys(definition.nodes).length,
          transitionCount: definition.flow?.transitions.length ?? 0,
        });
      } catch (err: any) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'invalid_workflow', message: err?.message ?? String(err) }));
      }
    }
    const defMatch = url.pathname.match(/^\/api\/workflows\/definitions\/([^/]+)$/);
    if (defMatch && req.method === 'GET') {
      const workflowId = decodeURIComponent(defMatch[1]);
      const definition = workflowStore.get(workflowId);
      if (!definition) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unknown_workflow' }));
      }
      return json(res, {
        definition,
        revisionId: `test:${workflowId}`,
        path: `/tmp/${workflowId}.workflow.json`,
      });
    }
    if (defMatch && req.method === 'PUT') {
      const body = await readBody(req);
      const definition = parseWorkflowDefinition(body.definition);
      updatedDefinition = definition;
      workflowStore.set(definition.workflowId, definition);
      return json(res, { ok: true, workflowId: definition.workflowId, path: `/tmp/${definition.workflowId}.workflow.json` });
    }
    if (defMatch && req.method === 'DELETE') {
      const workflowId = decodeURIComponent(defMatch[1]);
      deletedWorkflowId = workflowId;
      workflowStore.delete(workflowId);
      return json(res, { ok: true, workflowId, deletedPath: `/tmp/${workflowId}.workflow.json.deleted` });
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
      const body = await readBody(req);
      savedDefinition = parseWorkflowDefinition(body.definition);
      workflowStore.set(savedDefinition.workflowId, savedDefinition);
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

test('PM can create, edit, connect, save, and delete a workflow on the canvas', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.goto(`${baseUrl}/#/workflows/builder`);
  await page.waitForTimeout(250);
  expect(pageErrors).toEqual([]);
  await expect(page.getByRole('heading', { name: 'Workflow 管理后台' })).toBeVisible();
  await expect(page.getByLabel('可编辑 workflow 画布')).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/outputEquals|nodeId|value\.decision|visitCountLessThan|visitCountAtLeast/i);

  await page.getByRole('button', { name: '新建' }).click();
  await page.locator('#property-panel input[name="workflowId"]').fill('qa-release-flow');
  await page.locator('#property-panel input[name="title"]').fill('QA 发布流程');
  await page.locator('#property-panel button#apply-props').click();

  await page.getByRole('button', { name: '添加角色' }).click();
  await page.locator('#property-panel input[name="label"]').fill('Reviewer');
  await selectChoice(page, 'kind', 'reviewer');
  await page.locator('#property-panel textarea[name="responsibility"]').fill('审查发布风险并给出结论');
  await page.locator('#property-panel button#apply-props').click();

  await page.getByRole('button', { name: '添加 Bot 任务' }).click();
  await page.locator('#property-panel input[name="label"]').fill('开发实现');
  await selectChoice(page, 'bot', 'cli_app');
  await page.locator('#property-panel textarea[name="prompt"]').fill('完成发布前实现与自测');
  await page.locator('#property-panel button#apply-props').click();

  await page.getByRole('button', { name: '添加流程控制' }).click();
  await page.locator('#property-panel input[name="label"]').fill('Reviewer 判定');
  await selectChoice(page, 'semanticKind', 'reviewDecision');
  await selectChoice(page, 'roleId', 'reviewer');
  await page.locator('#property-panel input[name="humanGate"]').check();
  await page.locator('#property-panel button#apply-props').click();

  await page.getByRole('button', { name: '添加自动动作' }).click();
  await page.locator('#property-panel input[name="label"]').fill('发布通知');
  await selectChoice(page, 'executor', 'shell-command');
  await page.locator('#property-panel input[name="scriptCommand"]').fill('node');
  await page.locator('#property-panel textarea[name="scriptArgs"]').fill('-e\nconsole.log("ok")');
  await page.locator('#property-panel button#apply-props').click();

  await expect(page.locator('.wf-node')).toHaveCount(3);
  await dragNode(page, 'develop', 40, 50);
  await connectNodes(page, 'develop', 'review');
  await page.locator('.wf-edge[data-edge="develop-review"] rect').click();
  await page.locator('#property-panel input[name="label"]').fill('提交审查');
  await page.locator('#property-panel button#apply-props').click();
  await connectNodes(page, 'review', 'notify');
  await page.locator('.wf-edge[data-edge="review-notify"] rect').click();
  await selectChoice(page, 'conditionKind', 'approved');
  await page.locator('#property-panel input[name="decisionValue"]').fill('approved');
  await page.locator('#property-panel button#apply-props').click();

  await page.getByRole('button', { name: '保存' }).click();
  await expect.poll(() => savedDefinition?.flow?.transitions?.length).toBeGreaterThan(0);
  expect(savedDefinition.workflowId).toBe('qa-release-flow');
  expect(savedDefinition.nodes.develop.type).toBe('subagent');
  expect(savedDefinition.nodes.develop.bot).toBe('cli_app');
  expect(savedDefinition.nodes.review.type).toBe('semantic');
  expect(savedDefinition.nodes.review.kind).toBe('reviewDecision');
  expect(savedDefinition.nodes.review.humanGate).toBeTruthy();
  expect(savedDefinition.nodes.notify.type).toBe('hostExecutor');
  expect(savedDefinition.nodes.notify.executor).toBe('shell-command');
  expect(savedDefinition.nodes.notify.input.command).toBe('node');
  expect(savedDefinition.nodes.notify.input.args).toEqual(['-e', 'console.log("ok")']);
  expect(JSON.stringify(savedDefinition)).toContain('outputEquals');

  await page.getByRole('button', { name: /qa-release-flow/ }).click();
  await page.locator('.wf-node[data-node="develop"]').click();
  await page.locator('#property-panel input[name="label"]').fill('开发实现与自测');
  await page.locator('#property-panel button#apply-props').click();
  await page.getByRole('button', { name: '保存' }).click();
  await expect.poll(() => Object.values(updatedDefinition?.nodes ?? {}).some((node: any) => node.description === '开发实现与自测')).toBe(true);

  await page.getByRole('button', { name: '删除 workflow' }).click();
  await expect.poll(() => deletedWorkflowId).toBe('qa-release-flow');
});

test('full review workflow runs rework loop then approval report from builder config', async ({ page }) => {
  await page.goto(`${baseUrl}/#/workflows/builder`);
  await page.getByRole('button', { name: '保存' }).click();
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

async function readBody(req: AsyncIterable<Buffer>): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {};
}

async function dragNode(page: Page, nodeId: string, dx: number, dy: number): Promise<void> {
  const box = await page.locator(`.wf-node[data-node="${nodeId}"]`).boundingBox();
  if (!box) throw new Error(`node ${nodeId} is not visible`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 8 });
  await page.mouse.up();
}

async function connectNodes(page: Page, from: string, to: string): Promise<void> {
  await page.locator(`.wf-node[data-node="${from}"]`).click();
  await page.getByRole('button', { name: '点击连线' }).click();
  await page.locator(`.wf-node[data-node="${to}"]`).click();
}

async function selectChoice(page: Page, name: string, value: string): Promise<void> {
  const card = page.locator(`#property-panel .choice-card[data-choice-name="${name}"][data-choice-value="${value}"]`);
  await card.evaluate((el) => {
    const menu = el.closest('details');
    if (menu) menu.open = true;
  });
  await card.click();
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

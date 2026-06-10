/**
 * Major Finding 1 (codex review HHYrdCg6...): the four-segment prompt
 * injection must be proven on the REAL dispatch path, not only via a direct
 * `renderNodePrompt` call. Earlier tests asserted only role-persona +
 * workflow-fragment; here we drive `dispatchWork` and capture exactly what
 * `spawnSubagent` (the worker) receives, asserting:
 *   - segment 1 (task goal)   from `def.goal`
 *   - segment 2 (workflow fragment) — the node's authored prompt
 *   - segment 4 (run delta)   rendered from a COMPLETED dependency's output
 *
 * Segment 3 (scoped domains) has no source until Phase 2, so it is
 * deliberately absent — the dispatch logs `(domains: pending Phase 2)` and the
 * prompt carries no Domain-knowledge header.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseWorkflowDefinition } from '../src/workflows/definition.js';
import { EventLog } from '../src/workflows/events/append.js';
import { replay } from '../src/workflows/events/replay.js';
import {
  dispatchWork,
  type WorkerSpawnFn,
  type WorkflowRuntimeContext,
} from '../src/workflows/runtime.js';
import { decideNextActions } from '../src/workflows/orchestrator.js';
import { createRun } from '../src/workflows/run-init.js';
import { upsertDomain } from '../src/services/context/domains.js';
import { resolveDomainsDir } from '../src/services/context/domain-injection.js';

const RUN_ID = 'run-inject-test';

let baseDir: string;
beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'wf-inject-'));
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('dispatchWork four-segment injection (Major Finding 1)', () => {
  it('injects task goal + run delta (from completed deps) into the dispatched prompt', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-inject',
      version: 1,
      goal: 'Fix the login bug end to end',
      nodes: {
        verify: { type: 'subagent', bot: 'bot-v', prompt: 'Reproduce the bug' },
        fix: { type: 'subagent', bot: 'bot-f', depends: ['verify'], prompt: 'Apply the fix' },
      },
    });
    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, { def, params: {}, initiator: 't', botResolver: () => ({}) });

    const prompts: Record<string, string> = {};
    const spawn: WorkerSpawnFn = async (input) => {
      prompts[input.nodeId] = input.prompt;
      return {
        kind: 'success',
        output: { passed: false, evidence: 'unit test login_spec failed' },
        session: { sessionId: 's', botName: input.botName, startedAt: 0 },
      };
    };
    const ctx: WorkflowRuntimeContext = { log, def, spawnSubagent: spawn };

    // Drive the full loop so `verify` completes before `fix` dispatches —
    // `fix`'s run-state delta can only carry verify's output once it exists.
    const { runLoop } = await import('../src/workflows/loop.js');
    const result = await runLoop(ctx, { maxTicks: 50 });
    expect(result.lastSnapshot.run.status).toBe('succeeded');

    // verify (root): task goal present; no deps → NO run-state delta, and
    // segment 3 (domains) has no Phase 1 source.
    expect(prompts.verify).toContain('## Task');
    expect(prompts.verify).toContain('Fix the login bug end to end');
    expect(prompts.verify).toContain('## Step');
    expect(prompts.verify).toContain('Reproduce the bug');
    expect(prompts.verify).not.toContain('## Run state (delta)');
    expect(prompts.verify).not.toContain('## Domain knowledge');

    // fix (depends verify): task goal + step + run delta carrying verify output
    expect(prompts.fix).toContain('## Task');
    expect(prompts.fix).toContain('Fix the login bug end to end');
    expect(prompts.fix).toContain('## Step');
    expect(prompts.fix).toContain('Apply the fix');
    expect(prompts.fix).toContain('## Run state (delta)');
    expect(prompts.fix).toContain('verify');
    expect(prompts.fix).toContain('unit test login_spec failed');
  });

  it('back-compat: a goal-less, dep-less, role-less node gets the bare fragment verbatim', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-plain',
      version: 1,
      nodes: {
        only: { type: 'subagent', bot: 'bot-x', prompt: 'just do the thing' },
      },
    });
    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, { def, params: {}, initiator: 't', botResolver: () => ({}) });

    let captured = '';
    const spawn: WorkerSpawnFn = async (input) => {
      captured = input.prompt;
      return {
        kind: 'success',
        output: {},
        session: { sessionId: 's', botName: input.botName, startedAt: 0 },
      };
    };
    const ctx: WorkflowRuntimeContext = { log, def, spawnSubagent: spawn };

    const actions = decideNextActions(replay(await log.readAll()), def);
    const action = actions.find((a) => a.kind === 'dispatchWork' && a.nodeId === 'only');
    if (!action || action.kind !== 'dispatchWork') throw new Error('no action');
    await dispatchWork(ctx, action);

    // no goal, no deps, no role → single-segment fast path: verbatim, no headers
    expect(captured).toBe('just do the thing');
  });
});

describe('dispatchWork — domain injection (segment 3, Phase 2 第三闭环)', () => {
  it('injects node-declared domains from the configured domains dir', async () => {
    const domainsDir = join(baseDir, 'domains');
    await upsertDomain(domainsDir, { topic: 'auth-jwt', scope: 'repo', body: 'JWT expires in 1h.' }, { now: '2026-06-10T00:00:00Z' });

    const def = parseWorkflowDefinition({
      workflowId: 'wf-dom', version: 1,
      nodes: { only: { type: 'subagent', bot: 'b', domains: ['auth-jwt'], prompt: 'do the step' } },
    });
    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, { def, params: {}, initiator: 't', botResolver: () => ({}) });

    let captured = '';
    const spawn: WorkerSpawnFn = async (input) => {
      captured = input.prompt;
      return { kind: 'success', output: {}, session: { sessionId: 's', botName: input.botName, startedAt: 0 } };
    };
    const ctx: WorkflowRuntimeContext = { log, def, spawnSubagent: spawn, domainsDir };

    const actions = decideNextActions(replay(await log.readAll()), def);
    const action = actions.find((a) => a.kind === 'dispatchWork' && a.nodeId === 'only');
    if (!action || action.kind !== 'dispatchWork') throw new Error('no action');
    await dispatchWork(ctx, action);

    expect(captured).toContain('## Domain knowledge');
    expect(captured).toContain('auth-jwt');
    expect(captured).toContain('JWT expires in 1h.');
    expect(captured).toContain('## Step');
  });

  it('injects nothing when no domains dir is configured (back-compat)', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-dom2', version: 1,
      nodes: { only: { type: 'subagent', bot: 'b', domains: ['auth-jwt'], prompt: 'do the step' } },
    });
    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, { def, params: {}, initiator: 't', botResolver: () => ({}) });

    let captured = '';
    const spawn: WorkerSpawnFn = async (input) => {
      captured = input.prompt;
      return { kind: 'success', output: {}, session: { sessionId: 's', botName: input.botName, startedAt: 0 } };
    };
    const ctx: WorkflowRuntimeContext = { log, def, spawnSubagent: spawn }; // no domainsDir

    const actions = decideNextActions(replay(await log.readAll()), def);
    const action = actions.find((a) => a.kind === 'dispatchWork' && a.nodeId === 'only');
    if (!action || action.kind !== 'dispatchWork') throw new Error('no action');
    await dispatchWork(ctx, action);

    // domains declared but no dir configured → no injection → verbatim fragment
    expect(captured).toBe('do the step');
  });

  it('injects via resolveDomainsDir default path (entry-point wiring shape)', async () => {
    // entry points set `domainsDir: resolveDomainsDir()`; here we exercise that
    // exact shape — default <root>/.agents/domains — end to end through dispatch.
    const repoRoot = join(baseDir, 'repo');
    const domainsDir = join(repoRoot, '.agents', 'domains');
    await upsertDomain(domainsDir, { topic: 'auth-jwt', scope: 'repo', body: 'JWT expires in 1h.' }, { now: '2026-06-10T00:00:00Z' });
    const resolvedDir = resolveDomainsDir({ cwd: repoRoot, env: {} as NodeJS.ProcessEnv });

    const def = parseWorkflowDefinition({
      workflowId: 'wf-dom3', version: 1,
      nodes: { only: { type: 'subagent', bot: 'b', domains: ['auth-jwt'], prompt: 'do the step' } },
    });
    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, { def, params: {}, initiator: 't', botResolver: () => ({}) });

    let captured = '';
    const spawn: WorkerSpawnFn = async (input) => {
      captured = input.prompt;
      return { kind: 'success', output: {}, session: { sessionId: 's', botName: input.botName, startedAt: 0 } };
    };
    const ctx: WorkflowRuntimeContext = { log, def, spawnSubagent: spawn, domainsDir: resolvedDir };

    const actions = decideNextActions(replay(await log.readAll()), def);
    const action = actions.find((a) => a.kind === 'dispatchWork' && a.nodeId === 'only');
    if (!action || action.kind !== 'dispatchWork') throw new Error('no action');
    await dispatchWork(ctx, action);

    expect(captured).toContain('## Domain knowledge');
    expect(captured).toContain('JWT expires in 1h.');
  });
});

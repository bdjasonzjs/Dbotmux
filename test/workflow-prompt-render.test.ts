/**
 * Tests for T5 — workflow prompt renderer.
 *
 * Locks: the back-compat verbatim fast path (lone fragment), the fixed
 * segment order, top-k domain inclusion, and the injection rationale.
 */

import { describe, it, expect } from 'vitest';
import { renderNodePrompt, renderRunDelta } from '../src/workflows/prompt-render.js';

describe('renderNodePrompt — back-compat', () => {
  it('returns the workflow fragment verbatim when it is the only segment', () => {
    const r = renderNodePrompt({ workflowFragment: 'do the thing' });
    expect(r.prompt).toBe('do the thing');
    expect(r.rationale.segments).toEqual(['workflowFragment']);
    expect(r.rationale.reason).toMatch(/verbatim/);
  });

  it('treats empty/whitespace extras as absent (still verbatim)', () => {
    const r = renderNodePrompt({
      workflowFragment: 'X', rolePersona: '  ', taskGoal: '', runDelta: '\n',
      domains: [{ topic: 't', text: '' }],
    });
    expect(r.prompt).toBe('X');
    expect(r.rationale.segments).toEqual(['workflowFragment']);
  });
});

describe('renderNodePrompt — fixed segment order', () => {
  it('orders rolePersona → taskGoal → fragment → domains → runDelta', () => {
    const r = renderNodePrompt({
      rolePersona: 'You are the verifier.',
      taskGoal: 'Fix the login bug.',
      workflowFragment: 'Verify the repro.',
      domains: [{ topic: 'auth', text: 'JWT expires in 1h.' }],
      runDelta: 'verify.output = {...}',
    });
    const idx = (s: string) => r.prompt.indexOf(s);
    expect(idx('## Role')).toBeGreaterThanOrEqual(0);
    expect(idx('## Role')).toBeLessThan(idx('## Task'));
    expect(idx('## Task')).toBeLessThan(idx('## Step'));
    expect(idx('## Step')).toBeLessThan(idx('## Domain knowledge'));
    expect(idx('## Domain knowledge')).toBeLessThan(idx('## Run state (delta)'));
    expect(r.prompt).toContain('### auth');
    expect(r.rationale.segments).toEqual(
      ['rolePersona', 'taskGoal', 'workflowFragment', 'domains', 'runDelta'],
    );
    expect(r.rationale.domainCount).toBe(1);
  });

  it('includes only the domains passed (caller does top-k)', () => {
    const r = renderNodePrompt({
      workflowFragment: 'step',
      domains: [
        { topic: 'a', text: 'A' },
        { topic: 'b', text: 'B' },
      ],
    });
    expect(r.rationale.domainCount).toBe(2);
    expect(r.prompt).toContain('### a');
    expect(r.prompt).toContain('### b');
  });
});

describe('renderRunDelta — completed dependency outputs', () => {
  it('returns undefined when there are no entries', () => {
    expect(renderRunDelta([])).toBeUndefined();
  });

  it('renders one compact line per dependency, preserving nodeId', () => {
    const body = renderRunDelta([
      { nodeId: 'verify', output: { passed: false, evidence: 'login_spec failed' } },
      { nodeId: 'lint', output: 'clean' },
    ]);
    expect(body).toContain('- verify: ');
    expect(body).toContain('login_spec failed');
    expect(body).toContain('- lint: clean');
    // one line per entry
    expect(body!.split('\n')).toHaveLength(2);
  });

  it('collapses whitespace and truncates oversized payloads', () => {
    const huge = { note: 'x'.repeat(5000) };
    const body = renderRunDelta([{ nodeId: 'big', output: huge }], { maxCharsPerEntry: 50 });
    expect(body!).toContain('…(truncated)');
    // line = "- big: " (7) + 50 chars + "…(truncated)"
    expect(body!.length).toBeLessThan(7 + 50 + 20);
  });

  it('feeds into renderNodePrompt as the run-state segment', () => {
    const runDelta = renderRunDelta([{ nodeId: 'verify', output: { passed: true } }]);
    const r = renderNodePrompt({ workflowFragment: 'fix it', runDelta });
    expect(r.prompt).toContain('## Run state (delta)');
    expect(r.prompt).toContain('- verify:');
    expect(r.rationale.segments).toEqual(['workflowFragment', 'runDelta']);
  });
});

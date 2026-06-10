/**
 * Round-2 proof for review Blocker 1 + Major T5: role workflows must work
 * through the REAL entry points (default loadWorkflowDefinition / catalog),
 * not just a test seam — and the role.md persona must reach the compiled def
 * (and thus dispatch), not only a direct renderNodePrompt call.
 *
 * Strategy: chdir into examples/context-platform (which has workflows/ +
 * agents.yaml + roles/) and drive the production functions with NO explicit
 * resolver, asserting the capability config is auto-discovered.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkflowDefinition } from '../src/workflows/loader.js';
import { listWorkflowDefinitions, loadCatalogDefinition } from '../src/workflows/catalog.js';
import { renderNodePrompt } from '../src/workflows/prompt-render.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'examples', 'context-platform');
let prevCwd: string;
let prevHome: string | undefined;

beforeAll(() => {
  prevCwd = process.cwd();
  prevHome = process.env.HOME;
  process.chdir(ROOT);
  // Isolate from the real $HOME/.botmux capability config.
  process.env.HOME = ROOT;
});
afterAll(() => {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
});

function node(def: { nodes: Record<string, { type: string; bot?: string; roleId?: string; rolePersona?: string; prompt?: unknown }> }, id: string) {
  return def.nodes[id];
}

describe('real entry points compile role workflows (Blocker 1)', () => {
  it('default loadWorkflowDefinition auto-resolves roles to concrete bots (no explicit resolver)', async () => {
    const def = await loadWorkflowDefinition('fix-bug');
    expect(node(def, 'verify')?.bot).toBe('cli_reviewer');
    expect(node(def, 'fix')?.bot).toBe('cli_fixer');
    expect(node(def, 'reverify')?.bot).toBe('cli_reviewer');
    // no unresolved role reaches the runtime def
    expect(JSON.stringify(def)).not.toContain('"role"');
  });

  it('catalog lists the role workflow (not silently skipped)', async () => {
    const entries = await listWorkflowDefinitions({ dirs: [join(ROOT, 'workflows')] });
    expect(entries.some((e) => e.workflowId === 'fix-bug')).toBe(true);
  });

  it('catalog detail returns a compiled concrete def', async () => {
    const loaded = await loadCatalogDefinition('fix-bug', {
      searchPaths: [join(ROOT, 'workflows', 'fix-bug.workflow.json')],
    });
    expect(loaded).toBeDefined();
    expect(node(loaded!.definition as never, 'fix')?.bot).toBe('cli_fixer');
  });
});

describe('role persona reaches the compiled def + dispatch prompt (Major T5)', () => {
  it('embeds role.md persona on the compiled node', async () => {
    const def = await loadWorkflowDefinition('fix-bug');
    const verify = node(def, 'verify');
    expect(verify?.roleId).toBe('verifier');
    expect(verify?.rolePersona).toMatch(/verifier/i);
  });

  it('the embedded persona renders into the dispatched prompt (Role segment)', async () => {
    const def = await loadWorkflowDefinition('fix-bug');
    const verify = node(def, 'verify');
    // mirrors what dispatchWork does: render persona + resolved fragment
    const rendered = renderNodePrompt({
      rolePersona: verify?.rolePersona,
      workflowFragment: typeof verify?.prompt === 'string' ? verify.prompt : '',
    });
    expect(rendered.prompt).toContain('## Role');
    expect(rendered.prompt).toContain('## Step');
    expect(rendered.rationale.segments).toEqual(['rolePersona', 'workflowFragment']);
  });
});

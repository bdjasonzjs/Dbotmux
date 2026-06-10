/**
 * T6 — end-to-end Phase 1 closure over the sample assets in
 * examples/context-platform/: load capability registries from disk, parse a
 * role-based workflow, compile roles → concrete bots, and render a node prompt
 * with the role persona. Exercises T1 (authoring + compile) + T2 (capability)
 * + T5 (prompt render) on the verify → fix → reverify chain.
 *
 * Assets live under examples/ (not the repo's real workflows/) so this sample
 * never enters the daemon's global catalog.
 */

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAuthoringWorkflowDefinition } from '../src/workflows/definition.js';
import { compileRolesToWorkflow } from '../src/workflows/role-compile.js';
import { buildRoleResolver } from '../src/workflows/capability.js';
import { loadCapabilityRegistries } from '../src/workflows/catalog.js';
import { renderNodePrompt } from '../src/workflows/prompt-render.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'examples', 'context-platform');

function botOf(def: { nodes: Record<string, { type: string; bot?: string; roleId?: string }> }, id: string) {
  const n = def.nodes[id];
  return n?.type === 'subagent' ? n.bot : undefined;
}

describe('Phase 1 end-to-end (examples/context-platform)', () => {
  it('compiles the role-based fix-bug workflow to concrete bots and renders persona', async () => {
    const registries = await loadCapabilityRegistries({ roots: [ROOT] });
    expect([...registries.agents.keys()]).toEqual(['cli_reviewer', 'cli_fixer']);
    expect(registries.roles.has('verifier')).toBe(true);
    expect(registries.roles.has('fixer')).toBe(true);

    const raw = JSON.parse(await fs.readFile(join(ROOT, 'workflows', 'fix-bug.workflow.json'), 'utf-8'));
    const authoring = parseAuthoringWorkflowDefinition(raw);
    const compiled = compileRolesToWorkflow(authoring, buildRoleResolver(registries));

    // verifier needs [repo-read, run-tests] → first match cli_reviewer;
    // fixer needs repo-write → cli_fixer. Degenerate 2-bot split.
    expect(botOf(compiled, 'verify')).toBe('cli_reviewer');
    expect(botOf(compiled, 'fix')).toBe('cli_fixer');
    expect(botOf(compiled, 'reverify')).toBe('cli_reviewer');

    // roleId metadata survives compilation (for audit + injection)
    const verify = compiled.nodes.verify;
    expect(verify?.type === 'subagent' && verify.roleId).toBe('verifier');

    // no unresolved role leaks into the runtime def
    expect(JSON.stringify(compiled)).not.toContain('"role"');

    // T5: render the verify node prompt with its role persona
    const persona = registries.roles.get('verifier')!.body;
    const fragment = (verify?.type === 'subagent' && typeof verify.prompt === 'string') ? verify.prompt : '';
    const rendered = renderNodePrompt({ rolePersona: persona, workflowFragment: fragment });
    expect(rendered.prompt).toContain('## Role');
    expect(rendered.prompt).toContain('verifier');
    expect(rendered.prompt).toContain('## Step');
    expect(rendered.rationale.segments).toEqual(['rolePersona', 'workflowFragment']);
  });
});

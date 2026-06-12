/**
 * Tests for T1 — authoring `role` schema + role compiler.
 *
 * Locks the contract that makes role compilation safe:
 *   - existing bot-authored workflows parse + compile unchanged (back-compat);
 *   - a subagent node must declare exactly one of `bot` / `role`;
 *   - `role` is resolved to a concrete `bot` BEFORE the runtime sees it, and an
 *     unresolved role is a HARD block (never reaches the runtime schema);
 *   - the compiled output satisfies the strict runtime schema (bot required)
 *     and carries `roleId` audit metadata.
 */

import { describe, it, expect } from 'vitest';
import {
  parseAuthoringWorkflowDefinition,
  parseWorkflowDefinition,
  type WorkflowDefinition,
} from '../src/workflows/definition.js';
import {
  compileRolesToWorkflow,
  RoleCompileError,
  type RoleResolver,
} from '../src/workflows/role-compile.js';

const BOT_ONLY = {
  workflowId: 'wf-bot-only',
  version: 1,
  nodes: {
    a: { type: 'subagent', bot: 'cli_a', prompt: 'do a' },
    b: { type: 'subagent', bot: 'cli_b', depends: ['a'], prompt: 'do b' },
  },
} as const;

const ROLE_BASED = {
  workflowId: 'fix-bug',
  version: 1,
  nodes: {
    verify: { type: 'subagent', role: 'verifier', prompt: 'verify' },
    fix: { type: 'subagent', role: 'fixer', depends: ['verify'], prompt: 'fix' },
    reverify: { type: 'subagent', role: 'verifier', depends: ['fix'], prompt: 're' },
  },
} as const;

const ROLE_MAP: Record<string, string> = { verifier: 'cli_v', fixer: 'cli_f' };
const mapResolver: RoleResolver = (roleId) => ROLE_MAP[roleId];

function botOf(def: WorkflowDefinition, nodeId: string): string | undefined {
  const node = def.nodes[nodeId];
  return node?.type === 'subagent' ? node.bot : undefined;
}

describe('parseAuthoringWorkflowDefinition — schema', () => {
  it('accepts a bot-only authoring def (back-compat)', () => {
    const def = parseAuthoringWorkflowDefinition(BOT_ONLY);
    expect(Object.keys(def.nodes)).toEqual(['a', 'b']);
  });

  it('accepts a role-based authoring def', () => {
    const def = parseAuthoringWorkflowDefinition(ROLE_BASED);
    const verify = def.nodes.verify;
    expect(verify?.type === 'subagent' && verify.role).toBe('verifier');
  });

  it('rejects a subagent node with neither bot nor role', () => {
    expect(() =>
      parseAuthoringWorkflowDefinition({
        workflowId: 'wf', version: 1,
        nodes: { n: { type: 'subagent', prompt: 'p' } },
      }),
    ).toThrow(/exactly one of `bot` or `role`.*neither/s);
  });

  it('rejects a subagent node with both bot and role', () => {
    expect(() =>
      parseAuthoringWorkflowDefinition({
        workflowId: 'wf', version: 1,
        nodes: { n: { type: 'subagent', bot: 'cli_x', role: 'r', prompt: 'p' } },
      }),
    ).toThrow(/exactly one of `bot` or `role`.*both/s);
  });

  it('still enforces graph invariants (unknown depends)', () => {
    expect(() =>
      parseAuthoringWorkflowDefinition({
        workflowId: 'wf', version: 1,
        nodes: { n: { type: 'subagent', role: 'r', depends: ['ghost'], prompt: 'p' } },
      }),
    ).toThrow(/unknown node 'ghost'/);
  });
});

describe('compileRolesToWorkflow — back-compat passthrough', () => {
  it('compiles a bot-only def to an equivalent runtime def with no resolver', () => {
    const authoring = parseAuthoringWorkflowDefinition(BOT_ONLY);
    const compiled = compileRolesToWorkflow(authoring);
    expect(botOf(compiled, 'a')).toBe('cli_a');
    expect(botOf(compiled, 'b')).toBe('cli_b');
    // identical to a direct strict parse of the same bot-only JSON
    const direct = parseWorkflowDefinition(BOT_ONLY);
    expect(compiled).toEqual(direct);
  });
});

describe('compileRolesToWorkflow — role resolution', () => {
  it('resolves roles to concrete bots and preserves roleId metadata', () => {
    const authoring = parseAuthoringWorkflowDefinition(ROLE_BASED);
    const compiled = compileRolesToWorkflow(authoring, mapResolver);
    expect(botOf(compiled, 'verify')).toBe('cli_v');
    expect(botOf(compiled, 'fix')).toBe('cli_f');
    expect(botOf(compiled, 'reverify')).toBe('cli_v');
    const verify = compiled.nodes.verify;
    expect(verify?.type === 'subagent' && verify.roleId).toBe('verifier');
    // compiled output satisfies the strict runtime schema (no throw)
    expect(() => parseWorkflowDefinition(compiled)).not.toThrow();
    // no `role` leaks into the runtime def
    expect(JSON.stringify(compiled)).not.toContain('"role"');
  });

  it('embeds the role persona on the compiled node when a persona provider is given', () => {
    const authoring = parseAuthoringWorkflowDefinition(ROLE_BASED);
    const personas: Record<string, string> = { verifier: 'You verify.', fixer: 'You fix.' };
    const compiled = compileRolesToWorkflow(authoring, mapResolver, (rid) => personas[rid]);
    const verify = compiled.nodes.verify;
    const fix = compiled.nodes.fix;
    expect(verify?.type === 'subagent' && verify.rolePersona).toBe('You verify.');
    expect(fix?.type === 'subagent' && fix.rolePersona).toBe('You fix.');
  });

  it('omits rolePersona when no persona provider is given (back-compat)', () => {
    const authoring = parseAuthoringWorkflowDefinition(ROLE_BASED);
    const compiled = compileRolesToWorkflow(authoring, mapResolver);
    const verify = compiled.nodes.verify;
    expect(verify?.type === 'subagent' && verify.rolePersona).toBeUndefined();
  });

  it('hard-blocks when a role has no resolver', () => {
    const authoring = parseAuthoringWorkflowDefinition(ROLE_BASED);
    expect(() => compileRolesToWorkflow(authoring)).toThrow(RoleCompileError);
    expect(() => compileRolesToWorkflow(authoring)).toThrow(/no RoleResolver was supplied/);
  });

  it('hard-blocks (unresolved role never enters runtime) when resolver returns undefined', () => {
    const authoring = parseAuthoringWorkflowDefinition(ROLE_BASED);
    const partial: RoleResolver = (roleId) => (roleId === 'verifier' ? 'cli_v' : undefined);
    expect(() => compileRolesToWorkflow(authoring, partial)).toThrow(RoleCompileError);
    expect(() => compileRolesToWorkflow(authoring, partial)).toThrow(/could not be resolved/);
  });

  it('passes the workflowId + nodeId context to the resolver', () => {
    const authoring = parseAuthoringWorkflowDefinition(ROLE_BASED);
    const seen: Array<{ roleId: string; workflowId: string; nodeId: string }> = [];
    const spy: RoleResolver = (roleId, ctx) => {
      seen.push({ roleId, ...ctx });
      return ROLE_MAP[roleId];
    };
    compileRolesToWorkflow(authoring, spy);
    expect(seen).toContainEqual({ roleId: 'verifier', workflowId: 'fix-bug', nodeId: 'verify' });
    expect(seen).toContainEqual({ roleId: 'fixer', workflowId: 'fix-bug', nodeId: 'fix' });
  });
});

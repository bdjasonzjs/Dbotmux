/**
 * Tests for T2 — capability mapping (agents.yaml / roles/*.md → bot).
 *
 * Locks: YAML/frontmatter parsing, superset capability matching, degenerate
 * topologies (1 bot plays many roles), and the HARD block on unknown role or
 * no capable bot.
 */

import { describe, it, expect } from 'vitest';
import {
  parseAgentsYaml,
  parseRoleMarkdown,
  resolveRoleToBot,
  buildRoleResolver,
  CapabilityError,
  type CapabilityRegistries,
} from '../src/workflows/capability.js';
import {
  parseAuthoringWorkflowDefinition,
} from '../src/workflows/definition.js';
import { compileRolesToWorkflow } from '../src/workflows/role-compile.js';

const AGENTS_YAML = `
agents:
  - botId: cli_generalist
    capabilities: [repo-read, repo-write, run-tests, lark-send]
  - botId: cli_reader
    capabilities: [repo-read]
`;

const ctx = { workflowId: 'wf', nodeId: 'n' };

function registriesFrom(agentsYaml: string, roleDocs: string[]): CapabilityRegistries {
  const roles = new Map();
  for (const doc of roleDocs) {
    const r = parseRoleMarkdown(doc);
    roles.set(r.roleId, r);
  }
  return { agents: parseAgentsYaml(agentsYaml), roles };
}

describe('parseAgentsYaml', () => {
  it('parses bots + capabilities preserving order', () => {
    const reg = parseAgentsYaml(AGENTS_YAML);
    expect([...reg.keys()]).toEqual(['cli_generalist', 'cli_reader']);
    expect(reg.get('cli_reader')?.capabilities).toEqual(['repo-read']);
  });

  it('rejects duplicate botId', () => {
    expect(() =>
      parseAgentsYaml(`agents:\n  - botId: cli_x\n  - botId: cli_x\n`),
    ).toThrow(CapabilityError);
  });
});

describe('parseRoleMarkdown', () => {
  it('parses frontmatter + body', () => {
    const role = parseRoleMarkdown(
      `---\nroleId: verifier\ncapabilities: [repo-read, run-tests]\n---\nYou verify things.\n`,
    );
    expect(role.roleId).toBe('verifier');
    expect(role.capabilities).toEqual(['repo-read', 'run-tests']);
    expect(role.body.trim()).toBe('You verify things.');
  });

  it('throws when frontmatter block is missing', () => {
    expect(() => parseRoleMarkdown('no frontmatter here')).toThrow(CapabilityError);
  });
});

describe('resolveRoleToBot — superset matching', () => {
  const reg = registriesFrom(AGENTS_YAML, [
    `---\nroleId: verifier\ncapabilities: [repo-read, run-tests]\n---\nverify`,
    `---\nroleId: fixer\ncapabilities: [repo-write]\n---\nfix`,
    `---\nroleId: reader\ncapabilities: [repo-read]\n---\nread`,
  ]);

  it('binds a role to the first bot whose capabilities are a superset', () => {
    expect(resolveRoleToBot('verifier', ctx, reg)).toBe('cli_generalist');
    expect(resolveRoleToBot('fixer', ctx, reg)).toBe('cli_generalist');
    // reader is satisfiable by the generalist (first) — order decides
    expect(resolveRoleToBot('reader', ctx, reg)).toBe('cli_generalist');
  });

  it('hard-blocks an unknown role', () => {
    expect(() => resolveRoleToBot('ghost', ctx, reg)).toThrow(/unknown role 'ghost'/);
  });

  it('hard-blocks when no bot has all required capabilities', () => {
    const reg2 = registriesFrom(
      `agents:\n  - botId: cli_reader\n    capabilities: [repo-read]\n`,
      [`---\nroleId: fixer\ncapabilities: [repo-write]\n---\nfix`],
    );
    expect(() => resolveRoleToBot('fixer', ctx, reg2)).toThrow(/no registered bot provides all/);
  });
});

describe('degenerate topology — 1 bot plays many roles', () => {
  it('all roles resolve to the single capable bot, end-to-end through compile', () => {
    const reg = registriesFrom(AGENTS_YAML, [
      `---\nroleId: verifier\ncapabilities: [repo-read]\n---\nv`,
      `---\nroleId: fixer\ncapabilities: [repo-write]\n---\nf`,
    ]);
    const authoring = parseAuthoringWorkflowDefinition({
      workflowId: 'fix-bug', version: 1,
      nodes: {
        verify: { type: 'subagent', role: 'verifier', prompt: 'v' },
        fix: { type: 'subagent', role: 'fixer', depends: ['verify'], prompt: 'f' },
      },
    });
    const compiled = compileRolesToWorkflow(authoring, buildRoleResolver(reg));
    const verify = compiled.nodes.verify;
    const fix = compiled.nodes.fix;
    expect(verify?.type === 'subagent' && verify.bot).toBe('cli_generalist');
    expect(fix?.type === 'subagent' && fix.bot).toBe('cli_generalist');
    expect(verify?.type === 'subagent' && verify.roleId).toBe('verifier');
  });
});

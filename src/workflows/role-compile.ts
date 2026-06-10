/**
 * Role compiler — resolves an *authoring* WorkflowDefinition (where subagent
 * nodes may reference an abstract `role`) into a concrete runtime
 * WorkflowDefinition (every subagent node has a `bot`).
 *
 * Why a compile step (DEV-CONTEXT §4.1, Finding 1):
 *   The runtime — loop.ts (per-bot serialization keyed on `node.bot`),
 *   runtime.dispatchWork (writes input blob, resolves snapshot, spawns the
 *   bot) — treats `bot` as a hard, required identity key.  An unresolved
 *   `role` must therefore NEVER reach the runtime.  We resolve roles up front,
 *   then re-validate the result against the strict runtime schema
 *   (`parseWorkflowDefinition`), which guarantees `subagent.bot` is present and
 *   the graph is still valid before anything is dispatched.
 *
 * Backward compatibility:
 *   A node that already carries `bot` (no `role`) is passed through untouched —
 *   no resolver call, no behavioral change.  A workflow with zero role
 *   references compiles to itself and needs no resolver at all.
 *
 * Layering:
 *   This module owns the *mechanism* (walk nodes, swap role→bot, preserve
 *   roleId, re-validate).  The *policy* — how a roleId maps to a concrete bot —
 *   is the injected `RoleResolver`, wired by the capability layer (T2,
 *   capability.ts / catalog.ts).  Keeping the resolver injectable lets T1 be
 *   tested in isolation with a trivial map.
 */

import {
  parseWorkflowDefinition,
  type AuthoringWorkflowDefinition,
  type WorkflowDefinition,
} from './definition.js';

/** Context handed to the resolver so it can produce helpful diagnostics. */
export interface RoleResolveContext {
  workflowId: string;
  nodeId: string;
}

/**
 * Maps an abstract roleId to a concrete bot id (larkAppId, the runtime
 * identity key).  Return `undefined` when the role cannot be filled — the
 * compiler turns that into a hard block (the run never starts).
 */
export type RoleResolver = (
  roleId: string,
  ctx: RoleResolveContext,
) => string | undefined;

/**
 * Maps a roleId to its role.md persona body (for prompt injection, T5).
 * Optional — when absent or returning undefined, the node simply carries no
 * persona and the renderer falls back to the workflow fragment verbatim.
 */
export type RolePersonaProvider = (roleId: string) => string | undefined;

/** Thrown when an authoring role cannot be compiled to a concrete bot. */
export class RoleCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleCompileError';
  }
}

/**
 * Compile an authoring definition into a concrete runtime definition.
 *
 * - subagent node with `bot` → passed through (role-free, no resolver needed).
 * - subagent node with `role` → resolver(role) must return a bot, else
 *   `RoleCompileError` (HARD block — unresolved role does not enter runtime).
 *   The original roleId is preserved on the compiled node as `roleId` audit /
 *   injection metadata.
 * - hostExecutor node → passed through.
 *
 * The assembled definition is re-parsed through `parseWorkflowDefinition` so
 * the strict runtime invariants (bot required, DAG valid, gates) are enforced
 * on the compiled output — not just trusted from the authoring parse.
 */
export function compileRolesToWorkflow(
  authoring: AuthoringWorkflowDefinition,
  resolver?: RoleResolver,
  personaProvider?: RolePersonaProvider,
): WorkflowDefinition {
  const compiledNodes: Record<string, unknown> = {};

  for (const [nodeId, node] of Object.entries(authoring.nodes)) {
    if (node.type !== 'subagent') {
      compiledNodes[nodeId] = node;
      continue;
    }

    if (node.bot) {
      // Already concrete. Strip the (absent) role; keep any author-set roleId.
      const { role: _role, ...rest } = node;
      compiledNodes[nodeId] = rest;
      continue;
    }

    // parseAuthoringWorkflowDefinition guarantees exactly one of bot|role,
    // so reaching here means `role` is set.
    const roleId = node.role!;
    if (!resolver) {
      throw new RoleCompileError(
        `Node '${nodeId}' references role '${roleId}' but no RoleResolver was ` +
        `supplied to compile workflow '${authoring.workflowId}'. Wire the ` +
        `capability resolver (agents.yaml) before loading role-based workflows.`,
      );
    }

    const bot = resolver(roleId, { workflowId: authoring.workflowId, nodeId });
    if (!bot) {
      throw new RoleCompileError(
        `Node '${nodeId}': role '${roleId}' in workflow '${authoring.workflowId}' ` +
        `could not be resolved to a concrete bot (no capable bot registered). ` +
        `This is a hard block — the role would otherwise enter the runtime as ` +
        `an undefined bot.`,
      );
    }

    const { role: _role, ...rest } = node;
    const persona = personaProvider?.(roleId)?.trim();
    compiledNodes[nodeId] = {
      ...rest,
      bot,
      roleId: node.roleId ?? roleId,
      ...(persona ? { rolePersona: persona } : {}),
    };
  }

  const compiled = { ...authoring, nodes: compiledNodes };
  // Strict runtime validation: guarantees subagent.bot present + graph valid.
  return parseWorkflowDefinition(compiled);
}

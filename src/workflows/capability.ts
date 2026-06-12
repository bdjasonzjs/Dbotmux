/**
 * Capability mapping (T2) — turns abstract roles into concrete bots.
 *
 * Two config sources (DEV-CONTEXT §4.1/§4.2):
 *   - `agents.yaml`  — for the program: each bot's `botId` (larkAppId, the
 *     runtime identity key) + the `capabilities` it can fill.
 *   - `roles/*.md`   — for the model: frontmatter `roleId` + `capabilities`
 *     (the capability slots the role demands) + a markdown body (persona /
 *     responsibilities / boundaries, consumed by the prompt renderer in T5).
 *
 * `resolveRoleToBot` is the policy plugged into the role compiler's
 * `RoleResolver` slot (T1): a role binds to the first registered bot whose
 * capabilities are a superset of the role's required slots.  Missing role or
 * no capable bot is a HARD block (`CapabilityError`) — surfaced at compile
 * time, never at runtime.
 *
 * Degenerate topologies (DEV-CONTEXT §3.2) fall out for free: with one capable
 * bot, every role resolves to it (one bot plays many roles, serially); with
 * specialised bots, roles split across them. No branching code per topology.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import type { RoleResolveContext, RoleResolver } from './role-compile.js';

// ─── Schemas / types ────────────────────────────────────────────────────────

const AgentEntrySchema = z.object({
  botId: z.string().min(1),
  capabilities: z.array(z.string().min(1)).default([]),
});
const AgentsFileSchema = z.object({
  agents: z.array(AgentEntrySchema).min(1),
});

export interface AgentEntry {
  botId: string;
  capabilities: string[];
}
/** botId → entry, insertion order preserved (first capable bot wins). */
export type AgentRegistry = Map<string, AgentEntry>;

export interface RoleDef {
  roleId: string;
  capabilities: string[];
  /** Markdown body after frontmatter — persona/boundaries for the renderer. */
  body: string;
}
/** roleId → role definition. */
export type RoleRegistry = Map<string, RoleDef>;

export interface CapabilityRegistries {
  agents: AgentRegistry;
  roles: RoleRegistry;
}

/** Thrown when a role cannot be filled — a hard block (run never starts). */
export class CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityError';
  }
}

// ─── Pure parsers (no fs — unit-testable) ───────────────────────────────────

export function parseAgentsYaml(text: string): AgentRegistry {
  const parsed = AgentsFileSchema.parse(parseYaml(text) ?? {});
  const registry: AgentRegistry = new Map();
  for (const entry of parsed.agents) {
    if (registry.has(entry.botId)) {
      throw new CapabilityError(`agents.yaml: duplicate botId '${entry.botId}'`);
    }
    registry.set(entry.botId, { botId: entry.botId, capabilities: entry.capabilities });
  }
  return registry;
}

const RoleFrontmatterSchema = z.object({
  roleId: z.string().min(1),
  capabilities: z.array(z.string().min(1)).default([]),
});

/**
 * Parse one `roles/*.md`: a `---`-delimited YAML frontmatter block followed by
 * a markdown body.  Frontmatter must declare `roleId` + `capabilities`.
 */
export function parseRoleMarkdown(text: string): RoleDef {
  const fm = extractFrontmatter(text);
  if (!fm) {
    throw new CapabilityError(
      'role markdown missing `---` frontmatter block (need roleId + capabilities)',
    );
  }
  const meta = RoleFrontmatterSchema.parse(parseYaml(fm.frontmatter) ?? {});
  return { roleId: meta.roleId, capabilities: meta.capabilities, body: fm.body };
}

function extractFrontmatter(
  text: string,
): { frontmatter: string; body: string } | undefined {
  // Leading `---\n ... \n---` then the rest. Tolerate CRLF and a BOM.
  const normalized = text.replace(/^﻿/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(normalized);
  if (!match) return undefined;
  return { frontmatter: match[1]!, body: match[2] ?? '' };
}

// ─── Resolution ─────────────────────────────────────────────────────────────

/**
 * Resolve a role to a concrete botId: the first registered agent whose
 * capabilities ⊇ the role's required slots.  Throws `CapabilityError` (hard
 * block) on unknown role or when no agent qualifies.
 */
export function resolveRoleToBot(
  roleId: string,
  ctx: RoleResolveContext,
  registries: CapabilityRegistries,
): string {
  const role = registries.roles.get(roleId);
  if (!role) {
    const known = [...registries.roles.keys()].join(', ') || '(none)';
    throw new CapabilityError(
      `unknown role '${roleId}' (workflow '${ctx.workflowId}', node '${ctx.nodeId}'). ` +
      `Known roles: ${known}.`,
    );
  }
  for (const agent of registries.agents.values()) {
    const have = new Set(agent.capabilities);
    if (role.capabilities.every((c) => have.has(c))) {
      return agent.botId;
    }
  }
  throw new CapabilityError(
    `role '${roleId}' (node '${ctx.nodeId}') requires capabilities ` +
    `[${role.capabilities.join(', ')}], but no registered bot provides all of them. ` +
    `This is a hard block — fill agents.yaml with a capable bot.`,
  );
}

/** Build the `RoleResolver` the compiler consumes from loaded registries. */
export function buildRoleResolver(registries: CapabilityRegistries): RoleResolver {
  return (roleId, ctx) => resolveRoleToBot(roleId, ctx, registries);
}

// ─── Filesystem loaders ──────────────────────────────────────────────────────

export async function loadAgentRegistry(path: string): Promise<AgentRegistry> {
  const text = await fs.readFile(path, 'utf-8');
  return parseAgentsYaml(text);
}

/**
 * Config roots holding `agents.yaml` + `roles/` — the per-project root (cwd)
 * and the global daemon root (`$HOME/.botmux`), mirroring where `workflows/`
 * lives. cwd wins over HOME on conflicts, matching workflow search priority.
 */
export function capabilityConfigRoots(): string[] {
  const home = process.env.HOME;
  const roots = [process.cwd()];
  if (home) roots.push(join(home, '.botmux'));
  return roots;
}

/**
 * Load + merge `agents.yaml` and `roles/*.md` across the config roots into a
 * single set of registries. Earlier roots (cwd) win per botId / roleId.
 * Missing files are tolerated (empty registry) — callers that actually need a
 * role get a clear CapabilityError at resolve time.
 *
 * `opts.roots` is a test seam; production callers use the default roots.
 */
export async function loadCapabilityRegistries(
  opts: { roots?: string[] } = {},
): Promise<CapabilityRegistries> {
  const roots = opts.roots ?? capabilityConfigRoots();
  const agents: AgentRegistry = new Map();
  const roles: RoleRegistry = new Map();
  for (const root of roots) {
    try {
      const fileAgents = await loadAgentRegistry(join(root, 'agents.yaml'));
      for (const [botId, entry] of fileAgents) if (!agents.has(botId)) agents.set(botId, entry);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const fileRoles = await loadRoleRegistry(join(root, 'roles'));
    for (const [roleId, def] of fileRoles) if (!roles.has(roleId)) roles.set(roleId, def);
  }
  return { agents, roles };
}

/**
 * Discover the capability config from disk and return the `RoleResolver` the
 * workflow loader feeds to the role compiler. Memoizable by callers; here it
 * re-reads each call (cheap; agents.yaml + a small roles dir).
 */
export async function loadRoleResolver(opts: { roots?: string[] } = {}): Promise<RoleResolver> {
  const registries = await loadCapabilityRegistries(opts);
  return buildRoleResolver(registries);
}

/**
 * Persona provider for the prompt renderer (T5): roleId → role.md body. Shares
 * the same registry load shape as `loadRoleResolver` so runtime ctx builders
 * can inject role personas without a second config format.
 */
export async function loadRolePersonaProvider(
  opts: { roots?: string[] } = {},
): Promise<(roleId: string) => string | undefined> {
  const registries = await loadCapabilityRegistries(opts);
  return (roleId: string) => registries.roles.get(roleId)?.body;
}

/** Load every `*.md` in `dir` as a role; throws on duplicate roleId. */
export async function loadRoleRegistry(dir: string): Promise<RoleRegistry> {
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.md'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw err;
  }
  const registry: RoleRegistry = new Map();
  for (const name of names.sort()) {
    const text = await fs.readFile(join(dir, name), 'utf-8');
    const role = parseRoleMarkdown(text);
    if (registry.has(role.roleId)) {
      throw new CapabilityError(
        `duplicate roleId '${role.roleId}' (second occurrence in ${name})`,
      );
    }
    registry.set(role.roleId, role);
  }
  return registry;
}

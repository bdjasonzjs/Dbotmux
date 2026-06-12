import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalJsonStringify,
  parseAuthoringWorkflowDefinition,
  type AuthoringWorkflowDefinition,
  type WorkflowDefinition,
} from './definition.js';
import {
  buildRoleResolver,
  loadCapabilityRegistries,
  type CapabilityRegistries,
} from './capability.js';
import {
  compileRolesToWorkflow,
  type RolePersonaProvider,
  type RoleResolver,
} from './role-compile.js';
import { ensureRunDir } from './runs-dir.js';

export type RunChatBinding = {
  chatId: string;
  larkAppId: string;
};

type RunFileOptions = {
  runDir?: string;
  runsDir?: string;
};

export function workflowDefinitionSearchPaths(workflowId: string): string[] {
  const home = process.env.HOME;
  return [
    join(process.cwd(), 'workflows', `${workflowId}.workflow.json`),
    join(home ?? '', '.botmux', 'workflows', `${workflowId}.workflow.json`),
  ];
}

export type LoadWorkflowOptions = {
  /**
   * Resolver for authoring `role` references. When omitted, a workflow that
   * actually uses roles auto-loads the capability registries from disk
   * (agents.yaml + roles/) — so the real CLI / IM / dashboard / trigger paths
   * all support role workflows (and get role personas) without each wiring a
   * resolver. Bot-only workflows never touch the registries. Either way roles
   * are resolved BEFORE the def is returned, so the runtime never sees a role.
   */
  roleResolver?: RoleResolver;
  /** Optional persona provider; auto-derived from registries when omitted. */
  rolePersonaProvider?: RolePersonaProvider;
};

/** True if any subagent node declares an authoring `role`. */
function authoringHasRole(def: AuthoringWorkflowDefinition): boolean {
  return Object.values(def.nodes).some((n) => n.type === 'subagent' && !!n.role);
}

/**
 * Parse raw authoring JSON → concrete runtime def. Shared by the loader and
 * the dashboard catalog so both resolve roles the same way. When no resolver
 * is supplied and the def uses roles, the capability registries are
 * auto-loaded once and used for BOTH bot resolution and persona embedding.
 */
export async function compileWorkflowFromRaw(
  raw: unknown,
  opts: LoadWorkflowOptions = {},
): Promise<WorkflowDefinition> {
  const authoring = parseAuthoringWorkflowDefinition(raw);
  let resolver = opts.roleResolver;
  let personaProvider = opts.rolePersonaProvider;
  if (!resolver && authoringHasRole(authoring)) {
    const registries: CapabilityRegistries = await loadCapabilityRegistries();
    resolver = buildRoleResolver(registries);
    personaProvider = personaProvider ?? ((roleId) => registries.roles.get(roleId)?.body);
  }
  return compileRolesToWorkflow(authoring, resolver, personaProvider);
}

export async function loadWorkflowDefinition(
  workflowId: string,
  opts: LoadWorkflowOptions = {},
): Promise<WorkflowDefinition> {
  const paths = workflowDefinitionSearchPaths(workflowId);
  for (const path of paths) {
    try {
      const raw = await fs.readFile(path, 'utf-8');
      return await compileWorkflowFromRaw(JSON.parse(raw), opts);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(
        `Failed to load workflow '${workflowId}' from ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  throw new Error(
    `Workflow '${workflowId}' not found. Looked in:\n${paths.map((p) => `- ${p}`).join('\n')}`,
  );
}

export async function snapshotWorkflowDefinition(
  runId: string,
  def: WorkflowDefinition,
  opts: RunFileOptions = {},
): Promise<string> {
  const dir = await getOrEnsureRunDir(runId, opts);
  const path = join(dir, 'workflow.json');
  await fs.writeFile(path, canonicalJsonStringify(def), 'utf-8');
  return path;
}

export async function writeRunChatBinding(
  runId: string,
  binding: RunChatBinding,
  opts: RunFileOptions = {},
): Promise<string> {
  const dir = await getOrEnsureRunDir(runId, opts);
  const path = join(dir, 'chat-binding.json');
  await fs.writeFile(path, JSON.stringify(binding, null, 2), 'utf-8');
  return path;
}

export async function readRunChatBinding(
  runId: string,
  opts: RunFileOptions = {},
): Promise<RunChatBinding> {
  const dir = await getOrEnsureRunDir(runId, opts);
  const path = join(dir, 'chat-binding.json');
  const raw = await fs.readFile(path, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<RunChatBinding>;
  if (!parsed.chatId || !parsed.larkAppId) {
    throw new Error(`Invalid workflow chat binding at ${path}`);
  }
  return { chatId: parsed.chatId, larkAppId: parsed.larkAppId };
}

async function getOrEnsureRunDir(runId: string, opts: RunFileOptions): Promise<string> {
  if (opts.runDir) {
    await fs.mkdir(opts.runDir, { recursive: true });
    return opts.runDir;
  }
  return ensureRunDir(runId, opts.runsDir);
}

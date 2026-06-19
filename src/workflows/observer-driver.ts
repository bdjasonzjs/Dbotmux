import type { WorkflowDefinition, WorkflowRole } from './definition.js';

export const DEFAULT_OBSERVER_DRIVER_ROLE_ID = '__observer_driver';

export type WorkflowDriverRoleKind =
  | WorkflowRole['kind']
  | 'executor';

export type WorkflowDriverContext = {
  actorId: string;
  roleKind: WorkflowDriverRoleKind;
  roleId?: string;
  source?: string;
};

export function defaultObserverDriver(
  def?: WorkflowDefinition,
  source = 'workflow-runtime',
): WorkflowDriverContext {
  const roleId = findObserverRoleId(def) ?? DEFAULT_OBSERVER_DRIVER_ROLE_ID;
  return {
    actorId: roleId,
    roleId,
    roleKind: 'observer',
    source,
  };
}

export function assertObserverDriver(
  driver: WorkflowDriverContext | undefined,
  def: WorkflowDefinition | undefined,
  operation: string,
): WorkflowDriverContext {
  if (!driver) {
    const roleId = findObserverRoleId(def) ?? DEFAULT_OBSERVER_DRIVER_ROLE_ID;
    throw new Error(
      `${operation} requires observer driver; no driver supplied` +
        ` (definition observer role: ${roleId})`,
    );
  }
  const resolved = driver;
  if (resolved.roleKind !== 'observer') {
    throw new Error(
      `${operation} requires observer driver; got roleKind=${resolved.roleKind}` +
        (resolved.actorId ? ` actorId=${resolved.actorId}` : ''),
    );
  }
  return resolved;
}

export function hasObserverRole(def: WorkflowDefinition): boolean {
  return !!findObserverRoleId(def);
}

function findObserverRoleId(def: WorkflowDefinition | undefined): string | undefined {
  if (!def?.roles) return undefined;
  for (const [roleId, role] of Object.entries(def.roles)) {
    if (role.kind === 'observer') return roleId;
  }
  return undefined;
}

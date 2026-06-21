export type TaskTeamId = `tt_team_${string}`;
export type TaskTeamRoleId = `tt_role_${string}`;
export type TaskTeamRuleId = `tt_rule_${string}`;
export type TaskTeamTypeId = `tt_type_${string}`;
export type TaskTeamSlotId = `tt_slot_${string}`;
export type TaskTeamRoleInstanceId = `tt_ri_${string}`;
export type TaskTeamBindingId = `tt_binding_${string}`;
export type TaskTeamCompanyId = `tt_company_${string}`;
export type TaskTeamDepartmentId = `tt_dept_${string}`;
export type TaskTeamActionId = `tt_action_${string}`;

export type TaskTeamVisibility = 'full' | 'review-only' | 'progress-only';
export type TaskTeamActionType =
  | 'submit'
  | 'review-pass'
  | 'review-reject'
  | 'rework'
  | 'ask-help'
  | 'escalate'
  | 'report'
  | 'consult'
  | 'finish';

export type TaskTeamStatus =
  | 'forming'
  | 'running'
  | 'reviewing'
  | 'blocked'
  | 'awaiting-acceptance'
  | 'done'
  | 'archived';

export type TaskTeamActionStatus = 'pending' | 'claimed' | 'sent' | 'acked' | 'failed';

export interface TaskTeamModelOverride {
  model?: string;
  reasoningEffort?: string;
}

export interface TaskTeamRoleRef {
  roleId: TaskTeamRoleId;
}

export interface TaskTeamActivationRule {
  trigger: string;
  description?: string;
}

export interface TaskTeamSeatHint {
  engine?: string;
  displayName?: string;
}

export interface TaskTeamRole {
  roleId: TaskTeamRoleId;
  name: string;
  responsibility: string;
  activation: TaskTeamActivationRule;
  visibility: TaskTeamVisibility;
  actions: TaskTeamActionType[];
  io: { from: TaskTeamRoleRef[]; to: TaskTeamRoleRef[] };
  model?: TaskTeamModelOverride;
  seatHint?: TaskTeamSeatHint;
  isObserver?: boolean;
}

export interface TaskTeamRoleSlot {
  slotId: TaskTeamSlotId;
  roleId: TaskTeamRoleId;
  label?: string;
}

export interface TaskTeamTriggerCondition {
  event: string;
  status?: TaskTeamStatus;
  fromSlotId?: TaskTeamSlotId;
}

export interface TaskTeamCollabRule {
  ruleId: TaskTeamRuleId;
  when: TaskTeamTriggerCondition;
  whoSlot: TaskTeamSlotId;
  do: TaskTeamActionType;
}

export interface TaskTeamCollabPolicy {
  reviewRounds: number;
  reviewQuorum: number;
  maxRework: number;
  escalateAfterStallMs: number;
  reviewOrder: TaskTeamSlotId[];
}

export interface TaskTeamType {
  typeId: TaskTeamTypeId;
  name: string;
  roleSlots: TaskTeamRoleSlot[];
  rules: TaskTeamRuleId[];
  policy: TaskTeamCollabPolicy;
}

export interface TaskTeamOrgStructureShape {
  companyId: TaskTeamCompanyId;
  companyName: string;
  departments: { deptId: TaskTeamDepartmentId; deptName: string; teamTypeIds: TaskTeamTypeId[] }[];
}

export interface TaskTeamOrgRuntimeBinding {
  companyId: TaskTeamCompanyId;
  rootChatId: string;
  ceoBotOpenId: string;
  deptBindings: { deptId: TaskTeamDepartmentId; managerChatId?: string; managerBotOpenId?: string }[];
}

export interface TaskTeamRoleBinding {
  bindingId: TaskTeamBindingId;
  botOpenId: string;
  larkAppId: string;
  modelOverride?: TaskTeamModelOverride;
}

export interface TaskTeamRoleInstance {
  roleInstanceId: TaskTeamRoleInstanceId;
  slotId: TaskTeamSlotId;
  roleId: TaskTeamRoleId;
  binding?: TaskTeamRoleBinding;
}

export interface TaskTeamReviewVote {
  byInstanceId: TaskTeamRoleInstanceId;
  verdict: 'pass' | 'reject';
  reason?: string;
}

export interface TaskTeamInstance {
  teamId: TaskTeamId;
  typeId: TaskTeamTypeId;
  companyId: TaskTeamCompanyId;
  deptId?: TaskTeamDepartmentId;
  chatId: string;
  goal: string;
  acceptance: string;
  roleInstances: TaskTeamRoleInstance[];
  status: TaskTeamStatus;
  progress: string;
  reviewState: {
    round: number;
    reworkCount: number;
    pendingInstanceId?: TaskTeamRoleInstanceId;
    votes: TaskTeamReviewVote[];
  };
  cursor?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskTeamAction {
  actionId: TaskTeamActionId;
  teamId: TaskTeamId;
  actionType: TaskTeamActionType;
  sourceRoleInstanceId?: TaskTeamRoleInstanceId;
  targetRoleInstanceId?: TaskTeamRoleInstanceId;
  targetSlotId?: TaskTeamSlotId;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  status: TaskTeamActionStatus;
  retryCount: number;
  leaseExpiresAt: string | null;
  dispatchAttemptId: string | null;
  deliveredMessageId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskTeamConfigFile {
  version: number;
  roles: TaskTeamRole[];
  rules: TaskTeamCollabRule[];
  teamTypes: TaskTeamType[];
  orgStructures: TaskTeamOrgStructureShape[];
  orgRuntimeBindings: TaskTeamOrgRuntimeBinding[];
  updatedAt: string;
}

export interface TaskTeamInstanceFile {
  version: number;
  teams: TaskTeamInstance[];
  updatedAt: string;
}

export interface TaskTeamOutboxFile {
  version: number;
  actions: TaskTeamAction[];
  updatedAt: string;
}

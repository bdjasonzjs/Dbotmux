export type ProductWorkflowRoleKind = 'developer' | 'reviewer' | 'reporter' | 'observer';

export type ProductWorkflowDraft = {
  workflowId: string;
  developerTask: string;
  reviewerTask: string;
  reportTask: string;
  maxReviewRounds: number;
  includeObserver?: boolean;
  observerTask?: string;
  approvedDecision?: string;
  rejectedDecision?: string;
};

type ProductNode = {
  type: 'semantic';
  kind: 'submitGate' | 'reviewDecision' | 'report' | 'observer' | 'milestone' | 'fail';
  roleId: string;
  description?: string;
  humanGate?: {
    stage: 'before';
    prompt: string;
    onTimeout?: 'fail' | 'success';
  };
  output?: unknown;
};

export function createDevelopmentReviewWorkflow(draft: ProductWorkflowDraft) {
  const maxReviewRounds = Math.max(1, Math.floor(draft.maxReviewRounds || 1));
  const approvedDecision = (draft.approvedDecision || 'approved').trim() || 'approved';
  const rejectedDecision = (draft.rejectedDecision || 'rejected').trim() || 'rejected';
  const nodes: Record<string, ProductNode> = {
    develop: {
      type: 'semantic',
      kind: 'milestone',
      roleId: 'developer',
      description: draft.developerTask,
      output: { action: 'develop', task: draft.developerTask },
    },
    submit: {
      type: 'semantic',
      kind: 'submitGate',
      roleId: 'developer',
      description: 'Submit current development output for review.',
      output: { action: 'submit_for_review' },
    },
    review: {
      type: 'semantic',
      kind: 'reviewDecision',
      roleId: 'reviewer',
      description: draft.reviewerTask,
      humanGate: {
        stage: 'before',
        prompt: `${draft.reviewerTask}\n\n请选择通过或打回。第 {{visit}} 轮，最多 ${maxReviewRounds} 轮。`,
        onTimeout: 'fail',
      },
    },
    report: {
      type: 'semantic',
      kind: 'report',
      roleId: 'reporter',
      description: draft.reportTask,
      output: { action: 'report', task: draft.reportTask },
    },
    review_failed: {
      type: 'semantic',
      kind: 'fail',
      roleId: 'reviewer',
      description: `Reviewer 连续 ${maxReviewRounds} 轮打回，流程进入人工兜底`,
      output: { action: 'review_failed', maxReviewRounds },
    },
  };
  if (draft.includeObserver) {
    nodes.observer = {
      type: 'semantic',
      kind: 'observer',
      roleId: 'observer',
      description: draft.observerTask || 'Observe all rounds without blocking the main flow.',
      output: { action: 'observe', task: draft.observerTask || 'Observe progress' },
    };
  }

  return {
    workflowId: sanitizeWorkflowId(draft.workflowId),
    version: 1,
    params: {
      goal: { type: 'string', required: false, description: 'Human-readable task goal' },
    },
    roles: {
      developer: {
        id: 'developer',
        kind: 'developer',
        label: '开发者',
        responsibility: draft.developerTask,
        icon: 'code',
      },
      reviewer: {
        id: 'reviewer',
        kind: 'reviewer',
        label: 'Reviewer',
        responsibility: draft.reviewerTask,
        icon: 'search',
      },
      reporter: {
        id: 'reporter',
        kind: 'reporter',
        label: '汇报员',
        responsibility: draft.reportTask,
        icon: 'clipboard',
      },
      ...(draft.includeObserver
        ? {
            observer: {
              id: 'observer',
              kind: 'observer',
              label: 'Observer',
              responsibility: draft.observerTask || 'Observe without blocking',
              icon: 'eye',
            },
          }
        : {}),
    },
    flow: {
      start: draft.includeObserver ? 'observer' : 'develop',
      transitions: [
        ...(draft.includeObserver
          ? [{ id: 'observer-start', from: 'observer', to: 'develop', label: '开始开发', when: { type: 'always' as const } }]
          : []),
        { id: 'develop-submit', from: 'develop', to: 'submit', label: '提审', when: { type: 'always' as const } },
        { id: 'submit-review', from: 'submit', to: 'review', label: '开始审查', when: { type: 'always' as const } },
        {
          id: 'review-reject',
          from: 'review',
          to: 'develop',
          label: '打回返工',
          when: {
            type: 'all' as const,
            conditions: [
              { type: 'outputEquals' as const, nodeId: 'review', path: 'value.decision', value: rejectedDecision },
              { type: 'visitCountLessThan' as const, nodeId: 'review', count: maxReviewRounds },
            ],
          },
        },
        {
          id: 'review-reject-limit',
          from: 'review',
          to: 'review_failed',
          label: '超出审查轮数',
          when: {
            type: 'all' as const,
            conditions: [
              { type: 'outputEquals' as const, nodeId: 'review', path: 'value.decision', value: rejectedDecision },
              { type: 'visitCountAtLeast' as const, nodeId: 'review', count: maxReviewRounds },
            ],
          },
        },
        {
          id: 'review-pass',
          from: 'review',
          to: 'report',
          label: '通过并汇报',
          when: { type: 'outputEquals' as const, nodeId: 'review', path: 'value.decision', value: approvedDecision },
        },
      ],
    },
    nodes,
  };
}

export function sanitizeWorkflowId(raw: string): string {
  const safe = raw.trim().replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'development-review-flow';
}

export function humanWorkflowStatus(input: {
  status: string;
  workflowId?: string;
  failedNodeId?: string;
  activities?: Array<{ ownerNodeId?: string; status: string; attempts?: Array<{ attemptNumber?: number }> }>;
  nodes?: Array<{ nodeId: string; status: string }>;
}): string {
  if (input.status === 'succeeded') return '流程已完成，汇报员已产出总结';
  if (input.status === 'failed') return `流程异常，卡在 ${input.failedNodeId || '某个步骤'}`;
  if (input.status === 'cancelled') return '流程已取消';
  const active = input.activities?.find((activity) =>
    ['pending', 'acquired', 'running', 'waiting', 'effectAttempting'].includes(activity.status),
  );
  if (active?.ownerNodeId) {
    return `${roleLabel(active.ownerNodeId)}正在${verbFor(active.ownerNodeId, active.status)}`;
  }
  const waitingNode = input.nodes?.find((node) => node.status === 'waiting');
  if (waitingNode) return `${roleLabel(waitingNode.nodeId)}等待处理`;
  return '流程准备中';
}

function roleLabel(nodeId: string): string {
  if (nodeId.includes('reproduce')) return '复现者';
  if (nodeId.includes('diagnose')) return '定位者';
  if (nodeId.includes('fix')) return '修复者';
  if (nodeId.includes('verify')) return '验证者';
  if (nodeId.includes('develop')) return '开发者';
  if (nodeId.includes('review')) return 'Reviewer';
  if (nodeId.includes('report')) return '汇报员';
  if (nodeId.includes('observer')) return 'Observer';
  return nodeId;
}

function verbFor(nodeId: string, status: string): string {
  if (status === 'waiting') return '等待确认';
  if (nodeId.includes('reproduce')) return '复现';
  if (nodeId.includes('diagnose')) return '定位';
  if (nodeId.includes('fix')) return '修复';
  if (nodeId.includes('verify')) return '验证';
  if (nodeId.includes('develop')) return '开发';
  if (nodeId.includes('review')) return '审查';
  if (nodeId.includes('report')) return '汇报';
  if (nodeId.includes('observer')) return '旁路观察';
  return '处理';
}

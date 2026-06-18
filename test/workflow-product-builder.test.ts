import { describe, expect, it } from 'vitest';

import {
  createDevelopmentReviewWorkflow,
  humanWorkflowStatus,
  sanitizeWorkflowId,
} from '../src/dashboard/web/workflow-product-builder.js';
import { parseWorkflowDefinition } from '../src/workflows/definition.js';

describe('workflow product builder', () => {
  it('creates a valid role-based flow definition without requiring JSON editing', () => {
    const def = createDevelopmentReviewWorkflow({
      workflowId: '开发 流程 MVP',
      developerTask: '实现功能',
      reviewerTask: '审查并决定通过或打回',
      reportTask: '汇报结果',
      maxReviewRounds: 2,
      includeObserver: true,
      observerTask: '旁路观察',
    });
    expect(def.workflowId).toBe('MVP');
    expect(def.roles.reviewer.kind).toBe('reviewer');
    expect(def.flow.transitions.some((t) => t.label === '打回返工')).toBe(true);
    expect(JSON.stringify(def.flow.transitions)).toContain('outputEquals');
    expect(JSON.stringify(def.flow.transitions)).toContain('value.decision');
    expect(JSON.stringify(def.flow.transitions)).toContain('visitCountLessThan');
    expect(JSON.stringify(def.flow.transitions)).toContain('visitCountAtLeast');
    expect(JSON.stringify(def.nodes.review)).toContain('humanGate');
    expect(JSON.stringify(def.nodes.review)).not.toContain('"decision":"approved"');
    expect(() => parseWorkflowDefinition(def)).not.toThrow();
  });

  it('sanitizes workflow IDs for saved files', () => {
    expect(sanitizeWorkflowId(' team review / flow ')).toBe('team-review-flow');
    expect(sanitizeWorkflowId('中文')).toBe('development-review-flow');
  });

  it('renders human language status without engine jargon', () => {
    const text = humanWorkflowStatus({
      status: 'running',
      activities: [{ ownerNodeId: 'review', status: 'waiting', attempts: [{ attemptNumber: 2 }] }],
    });
    expect(text).toContain('Reviewer');
    expect(text).not.toMatch(/runId|lastSeq|dangling|dEf|dAct|dWait/i);
  });
});

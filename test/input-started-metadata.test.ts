import { describe, expect, it } from 'vitest';
import { applyInputStartedMetadata } from '../src/core/input-started-metadata.js';
import { buildFooterAddressing } from '../src/services/reply-addressing.js';
import type { DaemonSession } from '../src/core/types.js';
import type { WorkerToDaemon } from '../src/types.js';

function session(): DaemonSession {
  return {
    session: {
      sessionId: 'sid', chatId: 'oc', rootMessageId: 'om_root', title: 'old title',
      status: 'active', createdAt: new Date(0).toISOString(), lastCallerOpenId: 'ou_previous',
      ownerOpenId: 'ou_owner',
    },
    worker: null, workerPort: null, workerToken: null, larkAppId: 'app', chatId: 'oc',
    chatType: 'group', scope: 'thread', spawnedAt: 0, cliVersion: 'test',
    lastMessageAt: 0, hasHistory: true,
  };
}

type InputStarted = Extract<WorkerToDaemon, { type: 'input_started' }>;

describe('input_started metadata transition', () => {
  it('keeps plural callers and never writes one batch member to lastCallerOpenId', () => {
    const ds = session();
    const event: InputStarted = {
      type: 'input_started',
      ids: ['om_owner', 'om_parent', 'om_review'],
      title: '合并处理 3 条（多发送者）',
      pendingCount: 0,
      callers: ['ou_owner', 'ou_parent', 'ou_reviewer'],
      originalContent: 'batch_id=9 N=3',
      cliInput: '必须先读 /tmp/batch-9.md',
      batch: { batchId: '9', count: 3, path: '/tmp/batch-9.md' },
    };

    const applied = applyInputStartedMetadata(ds, event);

    expect(event.callers).toEqual(['ou_owner', 'ou_parent', 'ou_reviewer']);
    expect(ds.session.lastCallerOpenId).toBe('ou_previous');
    expect(ds.session.suppressImplicitAddressing).toBe(true);
    expect(applied.title).toBe('合并处理 3 条（多发送者）');
    expect(applied.remember?.cliInput).toBe(event.cliInput);
  });

  it('updates the scalar caller only for an ordinary single input', () => {
    const ds = session();
    const event: InputStarted = {
      type: 'input_started', ids: ['om_single'], title: 'single', pendingCount: 0,
      callers: ['ou_single'], originalContent: 'raw', cliInput: 'wrapped',
    };

    applyInputStartedMetadata(ds, event);

    expect(ds.session.lastCallerOpenId).toBe('ou_single');
    expect(ds.session.suppressImplicitAddressing).toBe(false);
  });

  it('disables implicit footer addressing for a batch while preserving explicit mentions', () => {
    expect(buildFooterAddressing({
      ownerOpenId: 'ou_owner',
      lastCallerOpenId: 'ou_previous',
      suppressImplicitAddressing: true,
    }, { workingDir: '/tmp' })).toEqual({ sendTo: undefined, cc: [] });
  });
});

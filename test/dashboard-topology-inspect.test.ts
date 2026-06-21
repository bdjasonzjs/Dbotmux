import { describe, expect, it } from 'vitest';
import { inspectStatusOf } from '../src/dashboard/web/topology.js';

function node(over: Record<string, unknown>) {
  return {
    chatId: 'oc_x',
    name: 'task',
    chatType: 'group',
    originType: 'bot_spawned',
    parentChatId: 'oc_parent',
    tags: [],
    metrics: { lastMessageAt: null, messages24h: 0, hasUnansweredPing: false },
    summary: '',
    ...over,
  } as any;
}

describe('topology inspectStatusOf', () => {
  it('paused executor is still surfaced as needs-human, not archived', () => {
    expect(inspectStatusOf(node({ subtaskStatus: 'paused' }))).toMatchObject({
      key: 'topo.istatus.needs_human',
      severity: 3,
      archivedLike: false,
    });
  });

  it('stale paused executor goes to stale-help bucket, not done bucket', () => {
    expect(inspectStatusOf(node({ subtaskStatus: 'paused', subtaskHelpStale: true }))).toMatchObject({
      key: 'topo.istatus.stale_help',
      staleHelp: true,
      archivedLike: false,
    });
  });

  it('stopped remains archived-like', () => {
    expect(inspectStatusOf(node({ subtaskStatus: 'stopped' }))).toMatchObject({
      key: 'topo.istatus.paused',
      archivedLike: true,
    });
  });

  it('paused manager is also visible as waiting for human', () => {
    expect(inspectStatusOf(node({ reportingMode: 'manager', subtaskStatus: 'paused' }))).toMatchObject({
      key: 'topo.istatus.needs_human',
      severity: 3,
      archivedLike: false,
    });
  });
});

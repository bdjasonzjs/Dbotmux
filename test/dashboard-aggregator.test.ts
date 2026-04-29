import { describe, it, expect } from 'vitest';
import { Aggregator } from '../src/dashboard/aggregator.js';

describe('Aggregator cache merge', () => {
  it('upsert via session.spawned and session.update', () => {
    const a = new Aggregator();
    a.applyEvent('appA', {
      type: 'session.spawned',
      body: { session: { sessionId: 's1', larkAppId: 'appA', status: 'starting' } as any },
    });
    expect(a.getSessions().length).toBe(1);
    a.applyEvent('appA', {
      type: 'session.update',
      body: { sessionId: 's1', patch: { status: 'idle' } },
    });
    expect(a.getSessions()[0].status).toBe('idle');
  });

  it('marks closed on session.exited (keeps row for closed-session view)', () => {
    const a = new Aggregator();
    a.applyEvent('appA', {
      type: 'session.spawned',
      body: { session: { sessionId: 's1', larkAppId: 'appA' } as any },
    });
    a.applyEvent('appA', { type: 'session.exited', body: { sessionId: 's1' } });
    expect(a.getSessions().length).toBe(1);
    expect(a.getSessions()[0].status).toBe('closed');
  });

  it('schedule lifecycle', () => {
    const a = new Aggregator();
    a.applyEvent('appA', {
      type: 'schedule.created',
      body: { schedule: { id: 't1', enabled: true } as any },
    });
    a.applyEvent('appA', {
      type: 'schedule.updated',
      body: { id: 't1', patch: { enabled: false } },
    });
    expect(a.getSchedules()[0].enabled).toBe(false);
    a.applyEvent('appA', { type: 'schedule.deleted', body: { id: 't1' } });
    expect(a.getSchedules().length).toBe(0);
  });

  it('hydrate seeds the cache', () => {
    const a = new Aggregator();
    a.hydrateSessions('appA', [{ sessionId: 's1', larkAppId: 'appA' } as any]);
    a.hydrateSchedules([{ id: 't1' } as any]);
    expect(a.getSessions().length).toBe(1);
    expect(a.getSchedules().length).toBe(1);
  });

  it('ownerOf returns larkAppId for known sessionId', () => {
    const a = new Aggregator();
    a.applyEvent('appA', {
      type: 'session.spawned',
      body: { session: { sessionId: 's1', larkAppId: 'appA' } as any },
    });
    expect(a.ownerOf('s1')).toBe('appA');
    expect(a.ownerOf('nonexistent')).toBeUndefined();
  });

  it('listeners receive events with larkAppId attached', () => {
    const a = new Aggregator();
    const seen: any[] = [];
    a.on(e => seen.push(e));
    a.applyEvent('appB', { type: 'session.spawned', body: { session: { sessionId: 's2' } as any } });
    expect(seen).toHaveLength(1);
    expect(seen[0].larkAppId).toBe('appB');
    expect(seen[0].type).toBe('session.spawned');
  });
});

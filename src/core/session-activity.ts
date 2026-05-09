// src/core/session-activity.ts
//
// Small helper for keeping dashboard activity timestamps durable.  The
// DaemonSession fields are process-local and get rebuilt after a daemon
// restart, so user-visible activity time must also be persisted on Session.
import * as sessionStore from '../services/session-store.js';
import { dashboardEventBus } from './dashboard-events.js';
import type { DaemonSession } from './types.js';

export function markSessionActivity(ds: DaemonSession, at: number = Date.now()): void {
  ds.lastMessageAt = at;
  const iso = new Date(at).toISOString();
  if (ds.session.lastMessageAt !== iso) {
    ds.session.lastMessageAt = iso;
    sessionStore.updateSession(ds.session);
  }
  dashboardEventBus.publish({
    type: 'session.update',
    body: { sessionId: ds.session.sessionId, patch: { lastMessageAt: at } },
  });
}

import { describe, expect, it } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';
import {
  applyNoMentionReplySentinelToDaemonSession,
  applyNoMentionReplySentinelToSession,
} from '../src/daemon.js';

const SENTINEL = '本条消息的回复不圈任何人';

function makeSession(): Session {
  return {
    sessionId: 'relay-session',
    chatId: 'oc_relay',
    rootMessageId: 'om_relay',
    title: 'relay',
    status: 'active',
    createdAt: new Date(0).toISOString(),
  };
}

describe('relay no-mention sentinel', () => {
  it('sets and latches relay suppression on an existing daemon session', () => {
    const ds = { session: makeSession() } as Pick<DaemonSession, 'session'>;
    const changed = applyNoMentionReplySentinelToDaemonSession(ds, {
      content: `请处理（${SENTINEL}）`,
      senderAppId: 'app_relay',
    });

    expect(changed).toBe(true);
    expect(ds.session.suppressRelayMentions).toBe(true);
    expect(ds.session.suppressRelayMentionAppId).toBe('app_relay');
    expect(applyNoMentionReplySentinelToDaemonSession(ds, {
      content: SENTINEL,
      senderAppId: 'app_other',
    })).toBe(false);
    expect(ds.session.suppressRelayMentionAppId).toBe('app_relay');
  });

  it('does not modify a new session when the sentinel is absent', () => {
    const session = makeSession();
    expect(applyNoMentionReplySentinelToSession(session, {
      content: 'normal message',
      senderAppId: 'app_relay',
    })).toBe(false);
    expect(session.suppressRelayMentions).toBeUndefined();
    expect(session.suppressRelayMentionAppId).toBeUndefined();
  });
});

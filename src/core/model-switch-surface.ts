/**
 * Whether a session card may RENDER the 「⚙ 模型」 button (design rev16 §6):
 * the chat must be PROVEN internal (p2p / persisted internal / cached
 * internal — unknown renders nothing until the background chat.get lands), the
 * session must not be adopt/remote, and the (wrapper-first) capability must be
 * switchable. Click handling re-checks all of this plus the human gate.
 */
import type { DaemonSession } from './types.js';
import { isProvenInternalChat } from './external-chat.js';
import { isSharedAdoptSession } from './shared-adopt.js';
import { isRemoteBackendSession } from './persistent-backend.js';
import { sessionSupportsModelSwitch } from './model-switch.js';

export function modelSwitchAllowedForSession(ds: DaemonSession, cliId?: string): boolean {
  if (isSharedAdoptSession(ds) || isRemoteBackendSession(ds)) return false;
  if (!sessionSupportsModelSwitch(cliId ?? ds.session.cliId, ds.session.wrapperCli)) return false;
  return isProvenInternalChat(ds);
}

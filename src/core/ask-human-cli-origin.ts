/** Local, non-isolated source transport for an EXISTING daemon-owned origin.
 * This is not an authentication alternative: the IPC endpoint still compares
 * the capability with the live worker's current origin on every operation.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { askHumanHash } from './ask-human-preflight.js';
import { readManagedOriginAuthorityFile } from './managed-origin-capability.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
const claimSchema = z.object({ appId: z.string().min(1), sessionId: z.string().min(1),
  capability: z.string().regex(/^[a-f0-9]{32,128}$/i), turnId: z.string().min(1),
  expiresAt: z.number().int().positive(),
}).strict();
type Claim = z.infer<typeof claimSchema>;
const claimPath = (dataDir: string, appId: string, sessionId: string) =>
  join(dataDir, 'human-session-cli-origins', `${askHumanHash(JSON.stringify([appId, sessionId]))}.json`);
/** Only invoked AFTER current-worker IPC validation and live source admission. */
export function publishAskHumanCliOrigin(dataDir: string, value: Claim): void {
  const claim = claimSchema.parse(value);
  mkdirSync(join(dataDir, 'human-session-cli-origins'), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(claimPath(dataDir, claim.appId, claim.sessionId), JSON.stringify(claim),
    { mode: 0o600, durable: true, followTargetSymlink: false });
}
export function readAskHumanCliOrigin(dataDir: string, appId: string, sessionId: string, now = Date.now()): Claim | null {
  try {
    const raw = readManagedOriginAuthorityFile(claimPath(dataDir, appId, sessionId), 8192);
    if (!raw) return null;
    const c = claimSchema.parse(JSON.parse(raw));
    return c.appId === appId && c.sessionId === sessionId && now < c.expiresAt ? c : null;
  } catch { return null; }
}

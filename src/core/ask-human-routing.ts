/** Same-source single-writer lease and output decision. No message scanning,
 * inference, cross-app aggregation, or runtime hooks are installed here.
 * Inputs must come from the daemon's verified event/session, never model JSON.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { askHumanHash, AskHumanPreflightError } from './ask-human-preflight.js';

const text = z.string().min(1);
const routeSchema = z.object({
  tenantId: text, humanId: text, chatId: text, messageId: text,
  mentionedAppIds: z.array(text).min(1), responsibleAppId: text.optional(),
  classification: z.enum(['information_question', 'instruction', 'confirmation', 'dedicated_routine', 'ambiguous']),
  verifiedHuman: z.boolean(), deleted: z.boolean(), completeMentionsVerified: z.boolean(),
  requiresMultiplePerspectives: z.boolean(),
  outputPathsGuarded: z.boolean(),
}).strict();
export type AskHumanRouteInput = z.infer<typeof routeSchema>;
const leaseSchema = z.object({ key: text, fingerprint: text, ownerAppId: text }).strict();

export class AskHumanRouting {
  constructor(private readonly root: string) { mkdirSync(root, { recursive: true, mode: 0o700 }); }
  claim(input: AskHumanRouteInput, runtimeAppId: string): 'ANSWER_IN_NEW_ROOM' | 'ABSTAIN' | 'ORIGINAL_BUSINESS' | 'ROUTING_REVIEW_REQUIRED' | 'OUTPUT_GUARD_UNAVAILABLE' {
    const r = routeSchema.parse(input);
    if (!r.verifiedHuman || r.deleted || !r.mentionedAppIds.includes(runtimeAppId)) return 'ABSTAIN';
    if (['instruction', 'confirmation', 'dedicated_routine'].includes(r.classification)) return 'ORIGINAL_BUSINESS';
    if (r.classification === 'ambiguous' || !r.completeMentionsVerified || r.requiresMultiplePerspectives) return 'ROUTING_REVIEW_REQUIRED';
    if (!r.outputPathsGuarded) return 'OUTPUT_GUARD_UNAVAILABLE';
    const apps = [...new Set(r.mentionedAppIds)].sort();
    if (r.responsibleAppId && !apps.includes(r.responsibleAppId)) return 'ROUTING_REVIEW_REQUIRED';
    const ownerAppId = r.responsibleAppId ?? apps[0];
    if (runtimeAppId !== ownerAppId) return 'ABSTAIN';
    const key = askHumanHash(JSON.stringify([r.tenantId, r.humanId, r.chatId, r.messageId]));
    const fingerprint = askHumanHash(JSON.stringify({ ...r, mentionedAppIds: apps }));
    const path = join(this.root, `${key}.json`);
    return withFileLockSync(path, () => {
      try {
        const old = leaseSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
        if (old.key !== key || old.fingerprint !== fingerprint) return 'ROUTING_REVIEW_REQUIRED';
        return old.ownerAppId === runtimeAppId ? 'ANSWER_IN_NEW_ROOM' : 'ABSTAIN';
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new AskHumanPreflightError('STORE_UNREADABLE', '同源租约无法读取，禁止重建');
      }
      atomicWriteFileSync(path, JSON.stringify({ key, fingerprint, ownerAppId }), { durable: true, mode: 0o600, followTargetSymlink: false });
      return 'ANSWER_IN_NEW_ROOM';
    });
  }
}

export interface AskHumanOutputBinding {
  sessionId: string; turnId: string; sourceChatId: string; roomId: string;
}
/** Must be invoked by ALL output paths after trusted turn lookup. A missing
 * binding for an already-routed turn fails closed, not ordinary output.
 */
export function askHumanOutputAllowed(routedTurn: boolean, binding: AskHumanOutputBinding | undefined, output: {
  sessionId: string; turnId: string; chatId: string;
  path: 'final' | 'stream' | 'explicit_send' | 'service_send';
}): boolean {
  if (!routedTurn) return true;
  return !!binding && !!binding.roomId && binding.roomId !== binding.sourceChatId &&
    output.sessionId === binding.sessionId && output.turnId === binding.turnId && output.chatId === binding.roomId;
}

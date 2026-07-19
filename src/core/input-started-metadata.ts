import type { WorkerToDaemon } from '../types.js';
import type { DaemonSession } from './types.js';

type InputStarted = Extract<WorkerToDaemon, { type: 'input_started' }>;

export interface InputStartedMetadataResult {
  title?: string;
  remember?: { userPrompt: string; cliInput: string };
}

/**
 * Apply only the scalar/session metadata that becomes authoritative at the
 * worker's real dequeue boundary. Card freezing and persistence stay with the
 * daemon caller so this transition remains unit-testable.
 */
export function applyInputStartedMetadata(
  ds: DaemonSession,
  msg: InputStarted,
): InputStartedMetadataResult {
  if (msg.batch) {
    // Never pick one member of a multi-message batch as lastCallerOpenId.
    ds.session.suppressImplicitAddressing = true;
    return {
      title: msg.title,
      remember: {
        userPrompt: msg.title ?? `batch_id=${msg.batch.batchId}`,
        cliInput: msg.cliInput,
      },
    };
  }
  if (msg.ids.length > 0) {
    ds.session.suppressImplicitAddressing = false;
    if (msg.callers.length === 1) ds.session.lastCallerOpenId = msg.callers[0];
    return {
      title: msg.title,
      remember: { userPrompt: msg.originalContent, cliInput: msg.cliInput },
    };
  }
  // Initial prompts / explicit retry stubs have no inbound Lark metadata.
  return {};
}

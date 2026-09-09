/** Exact, capability-authenticated entry point. Importing this module neither
 * constructs runtime dependencies nor enables any Lark operation. */
import { ZodError } from 'zod';
import type { AskHumanApi } from './ask-human-api.js';
import { AskHumanPreflightError } from './ask-human-preflight.js';

export const ASK_HUMAN_IPC_ROUTE = '/api/human-session';
export const ASK_HUMAN_IPC_MAX_BYTES = 256 * 1024;

export type AskHumanIpcResult = { status: number; body: { ok: true; result: unknown } | { ok: false; error: string } };

/** The setter is process-local composition, not a remotely callable route.
 * The daemon must build a real AskHumanApi (slice 2). Even after installation,
 * Api's missing assertEnabled policy denies ALL operations by default.
 */
export class AskHumanIpcEndpoint {
  private api: Pick<AskHumanApi, 'handle'> | null = null;
  install(api: Pick<AskHumanApi, 'handle'> | null): void { this.api = api; }
  async handle(input: unknown): Promise<AskHumanIpcResult> {
    const api = this.api;
    if (!api) return { status: 503, body: { ok: false, error: 'NOT_ENABLED' } };
    try {
      return { status: 200, body: { ok: true, result: (await api.handle(input)) ?? null } };
    } catch (error) {
      // Never reflect input, rotating capabilities, filesystem paths or SDK
      // exception text into an IPC response or log. Report only stable codes.
      if (error instanceof ZodError) return { status: 400, body: { ok: false, error: 'INVALID_REQUEST' } };
      if (error instanceof AskHumanPreflightError && /^[A-Z0-9_]{1,64}$/.test(error.code)) {
        const status = error.code === 'NOT_ENABLED' ? 503 : error.code === 'ORIGIN_UNPROVEN' ? 403
          : ['INVALID_REQUEST', 'RUNTIME_PATH_INVALID'].includes(error.code) ? 400 : 409;
        return { status, body: { ok: false, error: error.code } };
      }
      return { status: 500, body: { ok: false, error: 'INTERNAL_ERROR' } };
    }
  }
}

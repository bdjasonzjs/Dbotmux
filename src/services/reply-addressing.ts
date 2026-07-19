export interface ReplyAddressingSession {
  ownerOpenId?: string;
  lastCallerOpenId?: string;
  suppressImplicitAddressing?: boolean;
}

/** Resolve footer-only implicit addressing. Explicit mentions in reply text
 * are handled independently and remain available during batch turns. */
export function buildFooterAddressing(
  session: ReplyAddressingSession,
  oncall: { workingDir: string } | undefined,
): { sendTo: string | undefined; cc: string[] } {
  if (session.suppressImplicitAddressing) return { sendTo: undefined, cc: [] };
  const owner = session.ownerOpenId;
  const caller = session.lastCallerOpenId ?? owner;
  if (!oncall) return { sendTo: owner, cc: [] };
  return { sendTo: caller, cc: [] };
}

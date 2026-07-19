export interface ReplyAddressingSession {
  ownerOpenId?: string;
  lastCallerOpenId?: string;
  suppressImplicitAddressing?: boolean;
  /** 用于判定解析出的收件人是不是「本 app 视角下的某个 bot」——见下方 isKnownBot。 */
  larkAppId?: string;
}

/** Resolve footer-only implicit addressing. Explicit mentions in reply text
 * are handled independently and remain available during batch turns.
 *
 * `isKnownBot`（2026-07-19 合并时补回）：本机长期生效的既定行为是**footer 绝不 @ 到
 * 一个 bot 身上**（原先由 dist 补丁里的 isKnownBotOpenIdForApp 强制，本次还原成源码）。
 * 本模块保持纯函数、不碰文件系统，所以把判定以谓词形式注入；调用方（cli.ts）传入真正
 * 会读 bots-info / bot-openids 映射的实现。**不传 = 不做该过滤**，仅用于单测等场景。 */
export function buildFooterAddressing(
  session: ReplyAddressingSession,
  oncall: { workingDir: string } | undefined,
  isKnownBot?: (larkAppId: string | undefined, openId: string | undefined) => boolean,
): { sendTo: string | undefined; cc: string[] } {
  if (session.suppressImplicitAddressing) return { sendTo: undefined, cc: [] };
  const owner = session.ownerOpenId;
  const caller = session.lastCallerOpenId ?? owner;
  const sendTo = oncall ? caller : owner;
  if (isKnownBot?.(session.larkAppId, sendTo)) return { sendTo: undefined, cc: [] };
  return { sendTo, cc: [] };
}

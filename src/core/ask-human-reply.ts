/** Human-session reply transport. The existing ledger owns attempts and UUIDs. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AskHumanPreflightError } from './ask-human-preflight.js';

export interface AskHumanReplyConfig {
  userProfile: string;
  fallbackProfile: string;
  fallbackAppId: string;
}
export interface AskHumanSendReceipt {
  messageId: string;
  sender?: { type: 'user' | 'bot'; id: string };
}
export interface AskHumanReplyOrigin { appId: string; sessionId: string; chatId: string }
export class AskHumanUserUnavailable extends Error {}
/** A read-only preparation failed, so no message-send call was entered. */
export class AskHumanReplyNotSent extends AskHumanPreflightError {
  constructor() { super('REPLY_NOT_SENT', '回复尚未发送：发送前的原提问 bot 成员查询失败'); }
}

/** Only a definite identity refusal permits switching sender. Timeouts and
 * unknown results remain with the original attempt; they can already be sent. */
export async function sendAskHumanReply(input: { userOpenId: string }, ports: {
  user(): Promise<string>;
  fallback(): Promise<string>;
  fallbackAppId: string;
}): Promise<AskHumanSendReceipt> {
  try {
    return { messageId: await ports.user(), sender: { type: 'user', id: input.userOpenId } };
  } catch (error) {
    if (!(error instanceof AskHumanUserUnavailable)) throw error;
    return { messageId: await ports.fallback(), sender: { type: 'bot', id: ports.fallbackAppId } };
  }
}

const run = promisify(execFile);
export function askHumanUserIdentityRefused(error: { type?: string; code?: number }, operation?: 'read' | 'send'): boolean {
  return !!operation && (error.type === 'authentication'
    || (operation === 'send' && (error.type === 'authorization' || error.code === 230027)));
}
async function larkCli(args: string[], userOperation?: 'read' | 'send', origin?: AskHumanReplyOrigin): Promise<Record<string, any>> {
  let stdout: string;
  // PM2's IPC descriptor belongs to the daemon, not this non-IPC child.
  // Inheriting it makes the CLI abort even after a successful API read.
  const env: NodeJS.ProcessEnv = { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' };
  // A daemon has no ambient chat. Carry the already-bound SOURCE session,
  // so local CLI routing/audit sees the real caller, not a missing/stale turn.
  if (origin) Object.assign(env, { BOTMUX_LARK_APP_ID: origin.appId, BOTMUX_SESSION_ID: origin.sessionId, BOTMUX_CHAT_ID: origin.chatId });
  delete env.NODE_CHANNEL_FD;
  delete env.NODE_CHANNEL_SERIALIZATION_MODE;
  try {
    ({ stdout } = await run('lark-cli', args, { timeout: 30_000, maxBuffer: 1024 * 1024, env }));
  } catch (error) {
    const e = error as { stderr?: string; killed?: boolean };
    let response: { error?: { type?: string; code?: number; subtype?: string } } | undefined;
    try { response = JSON.parse(e.stderr ?? ''); } catch { /* unknown delivery */ }
    if (!e.killed && response?.error && askHumanUserIdentityRefused(response.error, userOperation)) throw new AskHumanUserUnavailable('USER_IDENTITY_UNAVAILABLE');
    // execFile errors include argv and message content: never propagate those.
    throw new AskHumanPreflightError('REPLY_TRANSPORT_UNCERTAIN', '回复发送调用已启动但结果未确定，保留原发送意图');
  }
  let response: Record<string, any>;
  try { response = JSON.parse(stdout); } catch { throw new AskHumanPreflightError('REPLY_SEND_UNCERTAIN', '发送回执不可解析'); }
  if (response.ok !== true) throw new AskHumanPreflightError('REPLY_TRANSPORT_UNCERTAIN', '回复传输未获确定回执');
  return response;
}

/** Resolve the source app in the actual sending profile's member view.
 * Member records carry app_id, so no display-name or cross-app open_id reuse. */
export async function askHumanReplyMention(profile: string, identity: 'user' | 'bot', chatId: string, sourceAppId: string): Promise<string> {
  try {
    const response = await larkCli(['im', '+chat-members-list', '--profile', profile, '--as', identity,
      '--chat-id', chatId, '--member-types', 'bot', '--page-all', '--format', 'json'], identity === 'user' ? 'read' : undefined);
    const bots = response.data?.bots as Array<{ app_id?: string; member_id?: string }> | undefined;
    const source = bots?.find(b => b.app_id === sourceAppId);
    if (!source?.member_id) throw new AskHumanReplyNotSent();
    return source.member_id;
  } catch (error) {
    if (error instanceof AskHumanUserUnavailable) throw error;
    throw new AskHumanReplyNotSent();
  }
}

export async function sendAskHumanViaProfile(profile: string, identity: 'user' | 'bot', chatId: string, text: string, uuid: string,
  replyTo?: string, origin?: AskHumanReplyOrigin): Promise<string> {
  const response = await larkCli(['im', replyTo ? '+messages-reply' : '+messages-send', '--profile', profile, '--as', identity,
    ...(replyTo ? ['--message-id', replyTo, '--reply-in-thread'] : ['--chat-id', chatId]),
    '--text', text, '--idempotency-key', uuid, '--format', 'json'], identity === 'user' ? 'send' : undefined, origin);
  if (!response.data?.message_id) throw new AskHumanPreflightError('REPLY_SEND_UNCERTAIN', '发送缺少消息回执');
  return response.data.message_id;
}

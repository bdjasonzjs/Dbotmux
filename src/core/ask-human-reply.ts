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
export class AskHumanUserUnavailable extends Error {}

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
async function larkCli(args: string[], userOperation?: 'read' | 'send'): Promise<Record<string, any>> {
  let stdout: string;
  try {
    ({ stdout } = await run('lark-cli', args, { timeout: 30_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } }));
  } catch (error) {
    const e = error as { stderr?: string; killed?: boolean };
    let response: { error?: { type?: string; code?: number; subtype?: string } } | undefined;
    try { response = JSON.parse(e.stderr ?? ''); } catch { /* unknown delivery */ }
    if (!e.killed && response?.error && askHumanUserIdentityRefused(response.error, userOperation)) throw new AskHumanUserUnavailable('USER_IDENTITY_UNAVAILABLE');
    // execFile errors include argv and message content: never propagate those.
    throw new AskHumanPreflightError('REPLY_TRANSPORT_UNCERTAIN', '回复传输未获确定结果，保留原发送意图');
  }
  let response: Record<string, any>;
  try { response = JSON.parse(stdout); } catch { throw new AskHumanPreflightError('REPLY_SEND_UNCERTAIN', '发送回执不可解析'); }
  if (response.ok !== true) throw new AskHumanPreflightError('REPLY_TRANSPORT_UNCERTAIN', '回复传输未获确定回执');
  return response;
}

/** Resolve the source app in the actual sending profile's member view.
 * Member records carry app_id, so no display-name or cross-app open_id reuse. */
export async function askHumanReplyMention(profile: string, identity: 'user' | 'bot', chatId: string, sourceAppId: string): Promise<string> {
  const response = await larkCli(['im', '+chat-members-list', '--profile', profile, '--as', identity,
    '--chat-id', chatId, '--member-types', 'bot', '--page-all', '--format', 'json'], identity === 'user' ? 'read' : undefined);
  const bots = response.data?.bots as Array<{ app_id?: string; member_id?: string }> | undefined;
  const source = bots?.find(b => b.app_id === sourceAppId);
  if (!source?.member_id) throw new AskHumanPreflightError('REPLY_MENTION_UNAVAILABLE', '发送方成员视角未找到原提问 bot');
  return source.member_id;
}

export async function sendAskHumanViaProfile(profile: string, identity: 'user' | 'bot', chatId: string, text: string, uuid: string,
  replyTo?: string): Promise<string> {
  const response = await larkCli(['im', replyTo ? '+messages-reply' : '+messages-send', '--profile', profile, '--as', identity,
    ...(replyTo ? ['--message-id', replyTo, '--reply-in-thread'] : ['--chat-id', chatId]),
    '--text', text, '--idempotency-key', uuid, '--format', 'json'], identity === 'user' ? 'send' : undefined);
  if (!response.data?.message_id) throw new AskHumanPreflightError('REPLY_SEND_UNCERTAIN', '发送缺少消息回执');
  return response.data.message_id;
}

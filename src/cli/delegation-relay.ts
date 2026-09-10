/**
 * `botmux delegate` / `botmux bubble` — the two moves a delegation node makes.
 *
 * Both are one thing underneath: post a message into a chat with a real @ on
 * the right bot. Everything that made that hard was knowledge an agent had to
 * *remember* rather than *decide*:
 *
 *   - `open_id` is app-scoped, so the mention target must be read from the
 *     destination chat's roster through the sending app's own eyes. Copying an
 *     id from anywhere else silently mentions nobody.
 *   - event-dispatcher's isSelfMessage check is app-wide, not per-chat, so a
 *     message from the same app as its recipient is dropped as that app's own
 *     echo — the @ wakes no one, in any chat. (`create-group` already knew
 *     this; it refuses with `creator_cannot_kickoff_self`. Refusing is not
 *     enough: the caller then has to know what to do instead.)
 *   - a successful send is not a delivered mention, so the message has to be
 *     read back.
 *
 * None of that needs intelligence, only accuracy — which is exactly what a
 * model is worst at and code is best at. So it lives here, and the caller says
 * only what it actually decided: who to talk to, and what to say.
 *
 * The parent link falls out of delegation itself: handing work down *is* what
 * makes one chat the parent of another, so `delegate` records it and `bubble`
 * needs no address at all.
 */
import { readFileSync } from 'node:fs';
import * as chatContextStore from '../services/chat-context-store.js';
import { loadBotConfigs } from '../bot-registry.js';
import {
  listChatBotMembers,
  sendMessage,
  getMessageDetail,
} from '../im/lark/client.js';

export interface RelayContext {
  /** Chat the calling session lives in. */
  chatId: string;
  /** Lark app of the calling session. */
  larkAppId: string;
}

export interface RelayIo {
  context: () => Promise<RelayContext>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Injectable for tests; defaults to reading process.stdin. */
  readStdin?: () => Promise<string>;
}

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function readStdinAll(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function resolveBody(argv: string[], io: RelayIo): Promise<string> {
  const file = argValue(argv, '--file') ?? argValue(argv, '--content-file');
  if (file) return readFileSync(file, 'utf8');
  const inline = argValue(argv, '--text');
  if (inline) return inline;
  const read = io.readStdin ?? readStdinAll;
  return await read();
}

/** Apps this machine holds credentials for — the set we can actually send as. */
function localAppIds(): string[] {
  try {
    return loadBotConfigs()
      .map(b => (b as { larkAppId?: string }).larkAppId)
      .filter((id): id is string => !!id);
  } catch {
    return [];
  }
}

/**
 * Pick the app that sends this message.
 *
 * Same app on both ends means the recipient's daemon discards the message as
 * its own echo, so when the preferred sender *is* the target we must hand the
 * send to some third app that is present in the chat and credentialed here.
 * Returns null when no such app exists, which is a hard failure: sending
 * anyway would look like success and wake nobody.
 */
export function pickSender(
  preferred: string,
  targetApp: string,
  appsInChat: string[],
  credentialed: string[],
): string | null {
  if (preferred !== targetApp) return preferred;
  const relay = appsInChat.find(app => app !== targetApp && credentialed.includes(app));
  return relay ?? null;
}

/** True iff the read-back message really carries a mention of `openId`. */
export function mentionLanded(detail: any, openId: string): boolean {
  // Lark returns the message under `data.items[0]`; the client already unwraps
  // `data`, so `items` is the normal shape. Fall back to the bare object so a
  // caller holding an already-unwrapped message still gets a real answer
  // instead of a silent false.
  const items = detail?.items ?? detail?.data?.items;
  const msg = Array.isArray(items) && items.length > 0 ? items[0] : detail;
  const mentions = msg?.mentions;
  if (!Array.isArray(mentions) || mentions.length === 0) return false;
  return mentions.some((m: any) => m?.id === openId || m?.id?.open_id === openId);
}

interface DeliverResult {
  messageId: string;
  senderApp: string;
  targetOpenId: string;
  relayed: boolean;
}

async function deliver(
  senderPreferred: string,
  chatId: string,
  targetApp: string,
  body: string,
): Promise<DeliverResult> {
  const text = body.trim();
  if (!text) throw new Error('正文为空：用 --file/--text 给内容，或从 stdin 传入');

  // Roster first: it answers both "is the target here" and "who else could
  // relay", and it is the only source of a usable, app-scoped open_id.
  const roster = await listChatBotMembers(senderPreferred, chatId);
  const appsInChat = roster.map(m => m.larkAppId).filter((v): v is string => !!v);
  const senderApp = pickSender(senderPreferred, targetApp, appsInChat, localAppIds());
  if (!senderApp) {
    throw new Error(
      `发送方与接收方是同一个应用（${targetApp}），而群里没有第三个可用应用能代发。`
      + '同应用的消息会被当成自己的回声丢弃，@ 谁都叫不醒——所以这里必须失败，不能假装发成功了。',
    );
  }

  // Re-read the roster through the relay's eyes when we switched apps: open_id
  // is app-scoped, so the id seen by the preferred app is meaningless to it.
  const effectiveRoster = senderApp === senderPreferred
    ? roster
    : await listChatBotMembers(senderApp, chatId);
  const target = effectiveRoster.find(m => m.larkAppId === targetApp);
  if (!target?.openId) {
    throw new Error(`目标应用 ${targetApp} 不在群 ${chatId} 里，或它在本视角下没有可 @ 的 id`);
  }

  const messageId = await sendMessage(
    senderApp,
    chatId,
    `<at user_id="${target.openId}"></at> ${text}`,
    'text',
  );

  // A send that returns an id still may not have mentioned anyone. Read it back.
  const detail = await getMessageDetail(senderApp, messageId);
  if (!mentionLanded(detail, target.openId)) {
    throw new Error(
      `消息已发出（${messageId}）但回读发现 @ 没有生效，对方不会被唤醒。别把它当作已送达。`,
    );
  }

  return { messageId, senderApp, targetOpenId: target.openId, relayed: senderApp !== senderPreferred };
}

/** Record "who handed work to whom" so bubble needs no address later. */
function rememberParent(childChatId: string, parentChatId: string, parentExecutorApp: string): void {
  const existing = chatContextStore.read(childChatId);
  const inheritedFrom = {
    parentChatId,
    parentDigest: existing?.inheritedFrom?.parentDigest ?? '',
    parentExecutorApp,
  };
  if (existing) {
    chatContextStore.update(childChatId, { inheritedFrom });
    return;
  }
  // No context yet — typical for chats created outside `botmux create-group`
  // (spawn scripts, hand-made groups). Create a minimal one so the parent link
  // has somewhere to live; the rest of the context fills in later on its own.
  chatContextStore.create(childChatId, {
    purpose: '',
    originType: 'bot_spawned',
    participants: [],
    parentChatId,
  });
  chatContextStore.update(childChatId, { inheritedFrom });
}

const DELEGATE_HELP = `botmux delegate — 把任务派给子群

用法:
  botmux delegate --to <chat_id> --to-app <lark_app_id> [--file <路径> | --text "正文"]
  cat task.md | botmux delegate --to <chat_id> --to-app <lark_app_id>

参数:
  --to <chat_id>       目标子群
  --to-app <app_id>    子群里要 @ 的执行者所属应用（cli_xxx；全局唯一，不随视角变）
  --file / --text      任务正文；都不给则从 stdin 读

它替你做的事:
  - 到目标群成员表里把应用编号翻译成该视角能 @ 的 id（open_id 是 app-scoped，别处抄来的无效）
  - 发送方与接收方同应用时自动换一个第三方应用代发（同应用消息会被当成自己的回声丢掉）
  - 发完回读，确认 @ 真的生效；没生效就报错，不会假装成功
  - 记住"本群是目标群的父群"，之后子群 botmux bubble 不需要任何地址参数
`;

export async function runDelegateCli(argv: string[], io: RelayIo): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(DELEGATE_HELP);
    return 0;
  }
  const to = argValue(argv, '--to');
  const toApp = argValue(argv, '--to-app');
  if (!to || !toApp) {
    io.stderr('缺参数：--to <chat_id> 和 --to-app <lark_app_id> 都是必须的。看 botmux delegate --help');
    return 2;
  }
  try {
    const ctx = await io.context();
    const body = await resolveBody(argv, io);
    const r = await deliver(ctx.larkAppId, to, toApp, body);
    rememberParent(to, ctx.chatId, ctx.larkAppId);
    io.stdout(JSON.stringify({
      ok: true,
      messageId: r.messageId,
      chatId: to,
      mentioned: toApp,
      sentAs: r.senderApp,
      relayed: r.relayed,
      parentRecorded: ctx.chatId,
    }));
    return 0;
  } catch (e: any) {
    io.stderr(`delegate 失败：${e?.message ?? String(e)}`);
    return 1;
  }
}

const BUBBLE_HELP = `botmux bubble — 把结论往上冒泡给父群

用法:
  botmux bubble [--file <路径> | --text "正文"]
  echo "卡住了，原因是…" | botmux bubble

不需要地址参数：父群和该 @ 谁，都是当初父群向本群派活时记下来的。

它替你做的事:
  - 查出本群的父群、以及当初派活给本群的那个执行者
  - 用机器人自己的身份发（向上绝不能用 owner 身份：既是冒充，而且他收不到自己 @ 自己的提醒）
  - 与对方同应用时自动换一个第三方应用代发
  - 发完回读，确认 @ 真的生效
`;

export async function runBubbleCli(argv: string[], io: RelayIo): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(BUBBLE_HELP);
    return 0;
  }
  try {
    const ctx = await io.context();
    const inherited = chatContextStore.read(ctx.chatId)?.inheritedFrom as
      | { parentChatId?: string; parentExecutorApp?: string }
      | null
      | undefined;
    const parentChatId = inherited?.parentChatId;
    if (!parentChatId) {
      io.stderr(
        '本群没有登记父群，不知道该报给谁。父群用 botmux delegate 派活时会自动登记；'
        + '历史群没有这条记录，需要父群先 delegate 一次。',
      );
      return 3;
    }
    const targetApp = inherited?.parentExecutorApp
      ?? argValue(argv, '--to-app');
    if (!targetApp) {
      io.stderr(
        `本群登记了父群 ${parentChatId}，但没记下父群该 @ 谁（旧记录）。`
        + '这次先用 --to-app <lark_app_id> 指定；父群下次用 delegate 派活会自动补上。',
      );
      return 3;
    }
    const body = await resolveBody(argv, io);
    const r = await deliver(ctx.larkAppId, parentChatId, targetApp, body);
    io.stdout(JSON.stringify({
      ok: true,
      messageId: r.messageId,
      chatId: parentChatId,
      mentioned: targetApp,
      sentAs: r.senderApp,
      relayed: r.relayed,
    }));
    return 0;
  } catch (e: any) {
    io.stderr(`bubble 失败：${e?.message ?? String(e)}`);
    return 1;
  }
}

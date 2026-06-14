/**
 * Chat-native clone (方案 块 2): run the clone flow from a Feishu chat — render
 * the device-flow QR as an image into the owner's thread, drive the scan, and
 * write the clone. Owner-gated (only the bot's owner may clone).
 *
 * Scope: this is the chat primitive. It does NOT regenerate the PM2 ecosystem /
 * start the new daemon (the "daemon 生效" step) nor recognise the CEO intent
 * that triggers it (the end-to-end orchestration block) — those wire this in.
 */
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import QRCode from 'qrcode';
import type { BotConfig } from '../bot-registry.js';
import { cloneBot, type CloneBotResult } from './bot-clone.js';
import { tryRegisterApp, type RegisterAppOptions, type RegisterAppResult } from '../setup/register-app.js';

export interface CloneBotInChatArgs {
  /** The CEO bot's app id (whose Lark client posts into the chat + owns the gate). */
  ceoAppId: string;
  /** Chat the clone was requested in. */
  chatId: string;
  /** The owner's trigger message id — kept for traceability only (NOT used as a
   *  thread anchor; QR is posted as fresh messages into targetChatId, 蔻黛 blocker1). */
  rootMessageId: string;
  /** Chat to post the QR + status into. For #5 this is the freshly-built
   *  SUBGROUP chat (not the main-topic request chat) — a valid anchor in that
   *  chat, so replies don't cross-thread (蔻黛 blocker1). Defaults to chatId. */
  targetChatId?: string;
  /** open_id of whoever triggered the clone (CEO-app-scope; gated against owner). */
  senderOpenId: string;
  /** Source bot to clone. */
  sourceBot: BotConfig;
  /** Source 本体's display name (probed Lark botName) → clone's『本体名（N号机）』. */
  sourceDisplayName?: string;
  /** bots-info botName per appId (legacy clone-count supplement, round-3 #2). */
  botNamesByAppId?: Record<string, string>;
  configDir: string;
  botsJsonPath: string;
}

export interface CloneBotInChatDeps {
  /** Owner open_id for the CEO app (same-app scope → safe `===` gate). */
  getOwnerOpenId: (appId: string) => string | undefined;
  /** Upload a local image, returns image_key. */
  uploadImage: (appId: string, imagePath: string) => Promise<string>;
  /** Post a fresh message into a chat (= lark sendMessage, receive_id=chat_id).
   *  Used for QR image + status so we never thread-reply to a foreign
   *  rootMessageId (蔻黛 blocker1). */
  postToChat: (
    appId: string, chatId: string, content: string, msgType?: string,
  ) => Promise<string>;
  /** Injectable device-flow scan (defaults to the real tryRegisterApp). */
  registerApp?: (opts?: RegisterAppOptions) => Promise<RegisterAppResult>;
  /** PNG renderer (injectable for tests); defaults to qrcode.toBuffer. */
  renderQrPng?: (url: string) => Promise<Buffer>;
}

export type CloneBotInChatResult =
  | CloneBotResult
  | { ok: false; error: 'not_owner' | 'qr_delivery_failed'; message: string };

const REPLY_IN_THREAD = true;

export async function renderQrPng(url: string): Promise<Buffer> {
  return QRCode.toBuffer(url, { type: 'png', width: 320, margin: 2, errorCorrectionLevel: 'M' });
}
const defaultRenderQrPng = renderQrPng;

/**
 * Run the clone end-to-end inside a chat thread. Owner-gated; posts the QR as an
 * image reply, then writes the clone via cloneBot. Returns the clone result, a
 * not_owner refusal, or a qr_delivery_failed result.
 *
 * QR delivery is a HARD precondition (not best-effort): if rendering/uploading/
 * replying the QR fails, the device-flow scan is aborted so nothing is written
 * to bots.json. The function itself does not throw — failures surface as a
 * non-ok result plus an owner-facing reply.
 */
export async function cloneBotInChat(
  args: CloneBotInChatArgs,
  deps: CloneBotInChatDeps,
): Promise<CloneBotInChatResult> {
  const targetChatId = args.targetChatId ?? args.chatId;
  const reply = (content: string, msgType = 'text') =>
    deps.postToChat(args.ceoAppId, targetChatId, content, msgType).catch(() => '');

  // ── Owner gate (方案 owner-model B): same-app-scope open_id, clean `===`. ──
  const owner = deps.getOwnerOpenId(args.ceoAppId);
  if (!owner || args.senderOpenId !== owner) {
    await reply('⚠️ 只有 owner 能克隆 bot，已拒绝。');
    return { ok: false, error: 'not_owner', message: 'sender is not the bot owner' };
  }

  const renderQrPng = deps.renderQrPng ?? defaultRenderQrPng;
  const baseRegister = deps.registerApp ?? tryRegisterApp;

  // QR delivery is a HARD precondition: if we can't show the QR in chat, the
  // owner can't scan, so abort the device-flow scan (→ cloneBot returns before
  // any bots.json write) rather than polling silently for 10 minutes.
  const ac = new AbortController();
  let qrDeliveryFailed = false;

  const registerApp = (opts: RegisterAppOptions = {}): Promise<RegisterAppResult> =>
    baseRegister({
      ...opts,
      signal: ac.signal,
      onQRCodeReady: (info) => {
        void postQrToChat(info.url).then(
          () => { /* posted */ },
          () => { qrDeliveryFailed = true; ac.abort(); },
        );
      },
      onStatusChange: (s) => {
        if (s.status === 'slow_down') void reply('（扫码轮询变慢，请耐心等待…）');
        else if (s.status === 'domain_switched') void reply('（识别到国际版租户，已切换域名继续…）');
      },
    });

  // Throws on any failure (render / upload / image reply) → caller aborts the scan.
  async function postQrToChat(url: string): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'botclone-qr-'));
    try {
      const png = await renderQrPng(url);
      const p = join(dir, 'qr.png');
      writeFileSync(p, png);
      const imageKey = await deps.uploadImage(args.ceoAppId, p);
      await deps.postToChat(args.ceoAppId, targetChatId, JSON.stringify({ image_key: imageKey }), 'image');
      await reply(`👆 请用飞书扫码创建${args.sourceDisplayName ? `${args.sourceDisplayName}分身` : '分身'}（二维码有效期约 10 分钟）。`);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    }
  }

  // UX compensation for #3 (Lark app display name 不可程序化设置): hint the owner
  // to name the new app『本体名（N号机）』so the Feishu-visible name matches the
  // botmux displayName. This is a hint only — NOT a link dependency (蔻黛 守点).
  await reply(
    `正在克隆「${args.sourceDisplayName ?? args.sourceBot.name ?? args.sourceBot.larkAppId}」，二维码马上发出，请扫码…\n` +
    `（提示：扫码新建应用时，应用名请按「本体名（N号机）」格式填写，使飞书显示名与分身可寻址名一致）`,
  );

  const result = await cloneBot(
    {
      sourceBot: args.sourceBot,
      configDir: args.configDir,
      botsJsonPath: args.botsJsonPath,
      // sourceClaudeHome omitted → cloneBot derives it engine-aware (codex 本体 →
      // ~/.codex, not ~/.claude). Round-4 B4.
      sourceDisplayName: args.sourceDisplayName,
      botNamesByAppId: args.botNamesByAppId,
    },
    { registerApp },
  );

  // QR couldn't be delivered → we aborted the scan; report it as the real cause
  // (cloneBot will have returned `aborted` with nothing written).
  if (!result.ok && qrDeliveryFailed) {
    await reply('❌ 二维码发送到聊天失败，已中止克隆（未写入任何配置）。请稍后重试。');
    return { ok: false, error: 'qr_delivery_failed', message: 'failed to deliver QR image to chat; scan aborted' };
  }

  if (result.ok) {
    await reply(`✅ 已克隆分身：${result.slug}（${result.appId}），bots.json 索引 ${result.botIndex}。\n注意：新分身尚未生效——需起新进程（不会重启现有 daemon），该步骤单独执行。`);
  } else {
    await reply(`❌ 克隆失败：${result.error} — ${result.message}`);
  }
  return result;
}

/**
 * Session manager — session helper functions extracted from daemon.ts.
 * Handles working directory resolution, attachment downloads, prompt building,
 * session restoration, and scheduled task execution.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expandHome } from './working-dir.js';
import { config } from '../config.js';
import * as sessionStore from '../services/session-store.js';
import * as messageQueue from '../services/message-queue.js';
import { downloadMessageResource, listChatBotMembers } from '../im/lark/client.js';
import { logger } from '../utils/logger.js';
import { forkWorker, forkAdoptWorker, killStalePids, getCurrentCliVersion, restoreUsageLimitRuntimeState } from './worker-pool.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import { buildBotmuxShellHints } from '../adapters/cli/shared-hints.js';
import { TmuxBackend } from '../adapters/backend/tmux-backend.js';
import { getBot, getAllBots } from '../bot-registry.js';
import { getMainTopicChatId, isTillyMainTopicConversationDenied } from '../services/main-topic-config.js';
import { getChatMode } from '../services/chat-mode-store.js';
import type { CliId } from '../adapters/cli/types.js';
import { validateAdoptTarget } from './session-discovery.js';
import type { LarkAttachment, LarkMention, ScheduledTask } from '../types.js';
import type { MessageResource } from '../im/lark/message-parser.js';
import type { ResolvedSender } from '../im/lark/identity-cache.js';
import { sessionKey, sessionAnchorId } from './types.js';
import type { DaemonSession } from './types.js';
import { markSessionActivity } from './session-activity.js';
import { usageLimitStateKey } from '../utils/cli-usage-limit.js';
import { t, localeForBot, type Locale } from '../i18n/index.js';
import { parseWorkingDirList } from '../utils/working-dir.js';
import * as chatContextStore from '../services/chat-context-store.js';
import * as subtaskStore from '../services/subtask-store.js';
import { renderCollabNorms } from '../services/subtask-norms.js';
import { recordMention, getRecentMentions, MAX_RECENT_MENTIONS } from '../services/mention-history-store.js';

function sessionCreatedAtMs(session: { createdAt?: string }): number {
  return session.createdAt ? (Date.parse(session.createdAt) || Date.now()) : Date.now();
}

function sessionLastMessageAtMs(session: { createdAt?: string; lastMessageAt?: string }): number {
  return session.lastMessageAt ? (Date.parse(session.lastMessageAt) || sessionCreatedAtMs(session)) : sessionCreatedAtMs(session);
}

function sameUsageLimit(a: DaemonSession['usageLimit'], b: DaemonSession['usageLimit']): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return usageLimitStateKey(a) === usageLimitStateKey(b) && a.retryReady === b.retryReady;
}

// ─── Path helpers ────────────────────────────────────────────────────────────

export { expandHome };

export function getSessionWorkingDir(ds?: DaemonSession): string {
  if (ds?.workingDir) return expandHome(ds.workingDir);
  if (ds?.larkAppId) {
    const bot = getBot(ds.larkAppId);
    return expandHome(bot.config.workingDir ?? '~');
  }
  // Fallback for calls without a session (e.g. during restore)
  return expandHome(config.daemon.workingDir);
}

export function getProjectScanDir(ds?: DaemonSession): string {
  // 从 workingDir 自身开始向下扫描 git 仓库 (scanProjects 会向下递归).
  // 早期版本扫的是 workingDir 的父目录, 会把无关的同级兄弟仓库一起列出来,
  // 语义反直觉; 现在把扫描根钉在 workingDir 本身: 指向仓库集合根目录
  // (如 ~/projects) 就列出其下所有仓库, 指向单个仓库就只列该仓库及其嵌套.
  // (PROJECT_SCAN_DIR / projectScanDir 显式覆盖字段早已在
  // PR feature/setup-bot-management 收尾时下线, 此处不再涉及.)
  return getSessionWorkingDir(ds);
}

/**
 * Return all directories to scan for projects (supports multi-dir WORKING_DIR).
 * Each configured workingDir is used as the scan root AS-IS — scanProjects
 * recurses downward from it. See getProjectScanDir for why we no longer climb
 * to the parent directory.
 */
export function getProjectScanDirs(ds?: DaemonSession): string[] {
  if (ds?.larkAppId) {
    const bot = getBot(ds.larkAppId);
    const dirs = new Set<string>();
    const workingDirs = bot.config.workingDirs?.length
      ? bot.config.workingDirs
      : parseWorkingDirList(bot.config.workingDir ?? '~');
    for (const wd of workingDirs) {
      dirs.add(expandHome(wd));
    }
    if (ds.workingDir) {
      dirs.add(expandHome(ds.workingDir));
    }
    return [...dirs];
  }
  // Fallback to global config
  const dirs = new Set<string>();
  for (const wd of config.daemon.workingDirs) {
    dirs.add(expandHome(wd));
  }
  if (ds?.workingDir) {
    dirs.add(expandHome(ds.workingDir));
  }
  return [...dirs];
}

// ─── Attachment download ─────────────────────────────────────────────────────

export function getAttachmentsDir(messageId: string): string {
  return join(resolve(config.session.dataDir), 'attachments', messageId);
}

export async function downloadResources(larkAppId: string, messageId: string, resources: MessageResource[]): Promise<{ attachments: LarkAttachment[]; needLogin: boolean }> {
  if (resources.length === 0) return { attachments: [], needLogin: false };

  const attachments: LarkAttachment[] = [];
  const dir = getAttachmentsDir(messageId);
  let needLogin = false;

  for (const res of resources) {
    const savePath = join(dir, res.name);
    try {
      const resMessageId = res.messageId ?? messageId;
      await downloadMessageResource(larkAppId, resMessageId, res.key, res.type, savePath);
      attachments.push({ type: res.type, path: savePath, name: res.name });
    } catch (err: any) {
      // Download failure usually means missing User Token scope or a
      // legitimately revoked attachment — the caller surfaces `needLogin`
      // to the user. Per-failure log stays at info to aid retries.
      logger.info(`Failed to download ${res.type} ${res.key}: ${err.message}`);
      if (err.message?.includes('User Token')) needLogin = true;
    }
  }

  return { attachments, needLogin };
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

/** Get bots actually present in the chat (excludes current bot).
 *  Calls Lark OpenAPI to list chat members, then cross-references with
 *  registered bots to enrich with cliId. Falls back to empty on API error. */
export async function getAvailableBots(
  currentAppId: string,
  chatId: string,
): Promise<Array<{ name: string; displayName: string; openId: string }>> {
  try {
    const currentBot = getBot(currentAppId);
    const myCliId = currentBot.config.cliId;
    const chatBots = await listChatBotMembers(currentAppId, chatId);

    return chatBots
      .filter(b => b.name !== myCliId)
      .map(b => ({
        name: b.name,
        displayName: b.displayName,
        openId: b.openId,
      }));
  } catch (err) {
    logger.warn(`Failed to list chat bot members, skipping bot section: ${err}`);
    return [];
  }
}

/** XML-escape a string for use as element text content or attribute value.
 *  Covers the five XML-mandated entities; sufficient for our use case
 *  (paths, names, open_ids, bot identifiers) since we never embed raw user
 *  input in attribute values. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Render a `<sender>` tag for prompt injection. Caller resolves the sender
 * (open_id + type + optional name) via `resolveSender(...)` in identity-cache.
 * Returns empty string when no sender data is available so the prompt stays
 * clean for synthetic flows (scheduled tasks, no-op spawns).
 */
export function renderSenderTag(sender?: ResolvedSender): string {
  if (!sender || !sender.openId) return '';
  const attrs: string[] = [`type="${xmlEscape(sender.type)}"`, `open_id="${xmlEscape(sender.openId)}"`];
  if (sender.name) attrs.push(`name="${xmlEscape(sender.name)}"`);
  return `<sender ${attrs.join(' ')} />`;
}

export function formatAttachmentsHint(attachments?: LarkAttachment[], locale?: Locale): string {
  if (!attachments || attachments.length === 0) return '';
  let imgN = 0, fileN = 0;
  const items = attachments.map(a => {
    const tag = a.type === 'image' ? 'image' : 'file';
    const n = a.type === 'image' ? ++imgN : ++fileN;
    return `  <${tag} n="${n}" path="${xmlEscape(a.path)}" />`;
  });
  return `<attachments hint="${xmlEscape(t('ai.attach.hint', undefined, locale))}">\n${items.join('\n')}\n</attachments>`;
}

/** P1 main-bot mode: build the `<chat_context>` block to prepend to a
 *  spawned bot's first user message. Returns empty string when no
 *  ChatContext exists for this chat. */
/**
 * P1 commit #8 (spec §6) — main-bot prompt block. Injected at session
 * spawn time when:
 *   - chat is the configured mainTopicChatId (松松's Flumy 主话题)
 *   - bot is the main bot (cliId='claude-code')
 *
 * Tells the spawned Claude session it's in main-bot mode and should
 * route complex tasks via `botmux subtask-start` instead of doing them
 * inline. Heuristic (松松 Q3=b): short Q's get answered directly; PRDs /
 * bug lists / multi-bot collab get spawned subgroups.
 *
 * Returns empty string when conditions don't match — block is omitted
 * from the prompt.
 */
export function buildMainBotPromptBlock(chatId: string | undefined, larkAppId: string | undefined): string {
  if (!chatId || !larkAppId) return '';
  const mainTopic = getMainTopicChatId();
  if (!mainTopic || chatId !== mainTopic) return '';
  // Verify bot is Claude (cliId='claude-code') via bot-registry.
  let isMainBot = false;
  try {
    const bot = getBot(larkAppId);
    isMainBot = bot.config.cliId === 'claude-code';
  } catch { return ''; }
  if (!isMainBot) return '';
  return `<main_bot_routing>
你在 Flumy 主话题工作（mainTopicChatId）。

**定位：你是 CEO** —— 以**决策和分派**为主。能交给子群解决的问题就**尽量分派出去**，自己不必亲自下场干每件细活。邹劲松是**董事长**：只有**真正重要的问题**（重大方向 / 高风险 / 不可逆决策）才找他拍板；其余不是非常重要的事，你**自行决断、自主推进**，别事事等他。

**任务分派（核心，默认倾向分派）**：
- 能用子群解决的 → **尽量 subtask-start 分派出去**（这是常态，不是例外）。复杂任务（PRD 分析 / bug 清单 / 跨多群事项 / 需多 bot 协作 / 预期多轮）尤其要拉子群。
  → 调用 \`botmux subtask-start --goal "..." [--acceptance "..."] [--bots <ref>[:role],...]\`（ref=c|k|t / 名字 / appId，含分身；role=main|collab|observer；可选 \`--task-type prd|bug|misc\`、\`--name "<群名>"\`）
  → 阻塞等待返回 chatId
  → 主话题简短回报「✅ 已建子群 [群名]（oc_xxx），进展会自动汇报回来」
- 只有一句话能搞定的即时答疑 / 闲聊（拉群纯属浪费）才自己直接答。

**决策与上报**：
- 不是非常重要的问题 → **自行决断、自主推进**，不必上报
- 真正重要的（重大 / 高风险 / 不可逆）→ 才找邹劲松；走 RootInbox（P2），**不在子群直接 @ 他**（他不在群里）
- 同一任务不重复调 subtask-start（idempotencyKey 自动夹）

工具自动从 env 注入 sessionId — 你**不需要**手动带 \`--session-id\` flag。
</main_bot_routing>`;
}

/**
 * 输出纪律注入（每轮，所有会话 / 所有 bot 通用，无 gate）。
 *
 * 把「对外说话」和「执行命令(工具调用)」分成两个独立回合，降低工具调用在底层被
 * 损坏（malformed）的概率：同一回合里既写正文又紧跟工具调用，会把工具调用结构
 * 搅乱，导致解析失败 + 残片泄漏到群里。2026-06-01 邹劲松要求每轮、每群都注入。
 * adopt/bridge 模式（botmux-unaware）走 buildBridgeInputContent，不经过此函数。
 */
/**
 * 「被圈时间感知」块（2026-06-04 邹劲松要求）。仅当本 bot 这一轮确实被 @（被圈）时
 * 才记录 + 渲染：先把这次时间戳记进存储，再列出本群最近 MAX_RECENT_MENTIONS 次被圈的
 * 东八区时间（最新在前）。非被圈轮次返 ''（不注入），贴合"被圈的时候才感知"。
 * 时间戳取 build 时刻（≈ 收到消息时刻，误差秒级），东八区格式化与系统时区无关。
 *
 * 「是否被圈」的权威判定（蔻黛克斯 review Finding 1）：daemon 路由层用 isBotMentioned
 * 判定，它除了 message.mentions 还覆盖 post content 里的 inline `at` 节点（bot 发的
 * post 消息常不填 message.mentions）。所以这里**优先**用调用方传入的 selfMentionedThisTurn
 * （由 isBotMentioned 算好），避免和路由判定分叉漏触发；没传时才回退到只看 text mentions。
 */
export function buildRecentMentionsBlock(
  larkAppId: string | undefined,
  chatId: string | undefined,
  selfOpenId: string | undefined,
  mentions: LarkMention[] | undefined,
  nowMs: number,
  selfMentionedThisTurn?: boolean,
): string {
  if (!larkAppId || !chatId || !selfOpenId) return '';
  const mentioned = selfMentionedThisTurn ?? !!mentions?.some(m => m.openId === selfOpenId);
  if (!mentioned) return '';
  recordMention(larkAppId, chatId, nowMs);
  const recent = getRecentMentions(larkAppId, chatId);
  if (recent.length === 0) return '';
  const lines = recent
    .slice()
    .sort((a, b) => b - a) // 最新在前
    .map(ts => `- ${new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`);
  return `<recent_mentions hint="你最近 ${MAX_RECENT_MENTIONS} 次在本群被 @（被圈）的时间，东八区，最新在前；最上面这条就是这一次">\n${lines.join('\n')}\n</recent_mentions>`;
}

export function buildOutputDisciplineBlock(): string {
  return `<output_discipline>
【输出纪律 · 每轮必读】把"对外说话"和"执行命令(工具调用)"严格分成两个独立回合：
- 一个回合里，要么只对外说话（只调用一次 botmux send，不带任何其他工具调用），要么只执行（正文留空、直接发工具调用）。
- 不要在同一回合里先写一段正文、再紧跟工具调用 —— 二者混在一起会在底层把工具调用结构搅乱、导致 malformed，既执行失败、残片又泄漏到群里。
- 需要既汇报又执行时：先用一个回合 botmux send 把话说完，再用下一个回合（正文留空）执行。
- 发长消息优先"先写进临时文件，再 botmux send 读取该文件"，让工具调用本身保持最短。
- 给用户发的消息要考虑他的接受能力：凡是需要他做事或要他回答问题的，必须一项一项说，一次只抛一件，等他处理完再说下一件，绝不一股脑堆一大堆要求/问题给他；日常进度、结论也尽量短、只说他需要知道的。
</output_discipline>`;
}

/**
 * 子任务子群成员注入 (v3 #84，见 task-context「🔴 v3 设计纠偏」)：检测 chatId 是某个 **active**
 * 子任务的子群 → 注入 `<subtask_member_routing>`（4 部分：子任务目标/验收、你的角色职责、群里其他
 * bot 职责、求助机制）。**每轮注入**（首轮 buildNewTopicPrompt + 后续 buildFollowUpContent）——
 * 因为 MCP 工具不是 skill，多轮对话后 bot 会丢失「可以向主 bot 求助」「自己/别人的角色」等信息。
 * getByChatId corrupt 会抛 StoreCorruptError → try/catch 兜住，**注入失败绝不阻塞 spawn / 发消息**。
 */
export function buildSubtaskMemberBlock(chatId: string | undefined, larkAppId: string | undefined): string {
  if (!chatId || !larkAppId) return '';
  let task: ReturnType<typeof subtaskStore.getByChatId>;
  try { task = subtaskStore.getByChatId(chatId); }
  catch (err) { logger.warn(`[session-manager] subtask member lookup failed for ${chatId}: ${err}`); return ''; }
  if (!task) return '';
  if (task.status === 'finished' || task.status === 'stopped') return ''; // 终态不再注入

  // 角色定义 (v3：claude=执行者 / codex=Reviewer / coco=超级Subagent)
  // 优化 #1：把角色说硬——executor 驱动+产出主交付物、产出后唤 reviewer；reviewer 三句负约束、不抢执行。
  const ROLE_BY_CLI: Record<string, string> = {
    'claude-code': '执行者(主推进者) —— 你驱动任务、方案/代码/文档都由你产出。产出第一份可 review 物后，用 `botmux subtask-request-review --task-id <id> --summary "<可打开的链接/绝对路径>"` 唤起 reviewer；别闷头到底。对 reviewer 的意见要独立思考、别轻易全盘接受——reviewer 经常给过于保守、不一定合理的建议；逐条判断是不是真正值得改的，值得才改、不值得就简述理由驳回，不被它带着无谓地反复返工。想清楚、改完就直接推进并 push。',
    codex: 'Reviewer —— 只 review/challenge：**不驱动任务、不产主交付物、不直接实现**。只在执行者已有方案/代码/明确请求 review 时再 review，发现问题挑出来交执行者改，别自己上手抢执行。',
    coco: '超级 Subagent —— Token 不限量，承接 token 消耗大但相对简单的活',
  };
  const ROLE_BY_NAME: Record<string, string> = {
    克劳德: ROLE_BY_CLI['claude-code'], 蔻黛克斯: ROLE_BY_CLI['codex'], 缇蕾: ROLE_BY_CLI['coco'],
  };
  let selfOpenId: string | null = null;
  let selfRole = '(未识别角色，按子任务目标干活)';
  try { const b = getBot(larkAppId); selfOpenId = b.botOpenId ?? null; selfRole = ROLE_BY_CLI[b.config.cliId] ?? selfRole; } catch { /* xref 缺失 → 用兜底 */ }

  const others = task.bots
    .filter(b => b.openId !== selfOpenId)
    .map(b => `  - ${b.name}：${ROLE_BY_NAME[b.name] ?? (b.role === 'observer' ? '观测/盯群、触发唤醒（不参与执行）' : '协作')}`);
  const accLine = task.acceptance ? `\n【验收标准】${task.acceptance}` : '';

  // 嵌套裂变授权（双帽角色重述）：仅 task.spawnable===true 且本 bot 是执行者(main) 时注入；
  // 其余场景（含全部存量任务）输出与此前**逐字一致**（快照测试钉死）。
  let spawnableBlock = '';
  const mainBot = task.bots.find(b => b.role === 'main');
  if (task.spawnable === true && selfOpenId && selfOpenId === mainBot?.openId) {
    const rawMaxDepth = Number.parseInt(process.env.BOTMUX_MAX_SUBTASK_DEPTH ?? '', 10);
    const maxDepth = Number.isFinite(rawMaxDepth) && rawMaxDepth >= 1 ? rawMaxDepth : 2;
    const depth = task.depth ?? 1;
    spawnableBlock = `

【裂变授权（spawnable）】本任务已被授权在本群再派子任务（孙群）。你戴两顶帽子，边界=「上报永远只报直接父群；决策 scope 内自治、scope 外上报」：
- 对上（不变）：你仍是父群派下任务的执行者，卡住/超出本任务边界就 subtask-askforhelp 报父群。
- 对下（新增）：可用 \`botmux subtask-start --goal "..."\` 在本群派子任务（当前深度 ${depth}/${maxDepth}，再往下还能开 ${Math.max(0, maxDepth - depth)} 层；数量预算与限速由命令自动把守，422/429 时按提示收尾或上报，别自旋重试）。你派的子群上报会流到**本群**：收到 🛰️ 子任务状态卡片 → \`botmux subtask-query --command-id <id>\` 查详情并 ack；属于本任务范围内的执行细节自己 supplement/finish 拍掉，超出边界的（花钱/部署/方案级岔路）打包成**你自己的** askforhelp 上报父群——不许把子群问题原样转发当传话筒，不许拿到任务转手即裂。
- 收尾纪律：finish 本任务前先收尾你派的全部子任务（系统硬拦，--cascade 才级联）；孙群必须复用本群同一 worktree / 工作副本，禁止新 clone。`;
  }

  return `<subtask_member_routing>
你现在在一个**子任务子群**里干活（不是主话题，零主话题上下文，背景以这里为准）。

【子任务目标】${task.goal}${accLine}

【你的角色】${selfRole}${spawnableBlock}

【群里其他成员】
${others.length ? others.join('\n') : '  (只有你和观测者)'}

${renderCollabNorms('【协作 norms（每轮提醒，务必遵守）】')}

【卡住 / 缺信息怎么办】
- 用 \`botmux subtask-askforhelp --task-id ${task.taskId} --summary "卡在哪/需要什么"\` 向主 bot 求助。
- 求助会写进共享内存，由观测者(缇蕾/coco)触发急急如律令唤主 bot 来处理 —— 你不用自己 @ 谁。
- **别硬扛、别编**：信息不足就求助，不要臆测或编造结果。
</subtask_member_routing>

<subtask_escalation_protocol>
你是子任务群的成员，在这个子群和共享 store 上完成被指派的子任务。关于「找人决策」有一条铁律：

- 你**无权直接惊动项目 owner（邹劲松）**。子群里任何卡点、岔路、需要人拍板的决策（例如「MR 要不要合并」「方案选 A 还是 B」「是否继续往下做」），一律**不能**直接 @ 他、不能在消息里问他、不能停下来等他回复。
- 需要决策或卡住时，唯一正确的动作是**逐级上报**：用 \`subtask-askforhelp\`（或进度上报）把「卡点 / 待决策项」写进共享 store，上报到**父群**。
- 之后由**父群的主 bot** 感知这个信号，并自行判断是否需要惊动邹劲松。是否真的请他介入，**由父群主 bot 决定，不由你决定**。
- 链路：**子群（你）→ 父群主 bot →（主 bot 判断后）→ 邹劲松**。你只负责把信号准确送到父群这一跳，**严禁跨级**直接找人。

所以，干完一个阶段、或遇到需要人决策的岔路口，正确动作是「写 store 上报父群、等主 bot 接管」，而**不是**「停下来问邹劲松 A/B/C」。
</subtask_escalation_protocol>`;
}

export function buildChatContextBlock(chatId: string): string {
  try {
    const ctx = chatContextStore.read(chatId);
    if (!ctx) return '';
    const lines: string[] = ['<chat_context>'];
    lines.push(`  <chat_id>${chatId}</chat_id>`);
    lines.push(`  <purpose>${xmlEscape(ctx.purpose)}</purpose>`);
    lines.push(`  <origin_type>${ctx.originType}</origin_type>`);
    if (ctx.inheritedFrom?.parentChatId) {
      lines.push(`  <parent_chat_id>${ctx.inheritedFrom.parentChatId}</parent_chat_id>`);
      if (ctx.inheritedFrom.parentDigest) {
        lines.push(`  <parent_digest>${xmlEscape(ctx.inheritedFrom.parentDigest)}</parent_digest>`);
      }
    }
    if (ctx.activeTodoRefs.length > 0) {
      lines.push(`  <active_todo_refs>${ctx.activeTodoRefs.map(xmlEscape).join(' / ')}</active_todo_refs>`);
    }
    if (ctx.rules.length > 0) {
      const ruleItems = ctx.rules.map(r => `    <rule>${xmlEscape(r)}</rule>`).join('\n');
      lines.push(`  <rules>\n${ruleItems}\n  </rules>`);
    }
    lines.push('</chat_context>');
    return lines.join('\n');
  } catch (err) {
    logger.warn(`[session-manager] buildChatContextBlock failed for chat ${chatId}: ${err}`);
    return '';
  }
}

export function buildNewTopicPrompt(
  userMessage: string,
  sessionId: string,
  cliId: CliId,
  cliPathOverride?: string,
  attachments?: LarkAttachment[],
  mentions?: LarkMention[],
  availableBots?: Array<{ name: string; displayName: string; openId: string }>,
  followUps?: string[],
  botIdentity?: { name?: string; openId?: string },
  locale?: Locale,
  sender?: ResolvedSender,
  /** P1 main-bot mode: chatId for ChatContext lookup. When provided and a
   *  ChatContext exists, a `<chat_context>` block is appended to the prompt
   *  parts so the spawned bot knows what this chat is about. */
  chatId?: string,
  /** P1 commit #8: larkAppId of the spawning bot. When provided AND chatId
   *  matches mainTopicChatId AND larkAppId is Claude's, a `<main_bot_routing>`
   *  block is appended telling the bot to use subtask-start. */
  larkAppId?: string,
  /** 2026-05-26 群聊模式 commit 2: 群聊上下文 timeline block (来自
   *  buildRecentChatTimelineBlock). caller (spawn 路径) async fetch 后
   *  传入; 空字符串 / undefined → 不注入。p2p 不应该传 (caller 自己
   *  gate)，buildNewTopicPrompt 只负责拼。 */
  ambientContextBlock?: string,
  /** 被圈时间感知（2026-06-04）：本轮本 bot 是否被 @（被圈）的权威判定，由 daemon
   *  用 isBotMentioned 算好传入（覆盖 post inline at）。不传则回退到只看 text mentions。 */
  selfMentionedThisTurn?: boolean,
): string {
  const adapter = createCliAdapterSync(cliId, cliPathOverride);
  // Non-Claude CLIs receive the botmux routing hints inline via the prompt
  // (Claude Code builds its own via --append-system-prompt). Source hints
  // freshly from i18n so they respect the resolved locale instead of the
  // static `adapter.systemHints` array that was baked at module load.
  const hints = adapter.injectsSessionContext ? [] : buildBotmuxShellHints(locale);

  const routingBlock = hints.length > 0
    ? `<botmux_routing>\n${hints.join('\n')}\n</botmux_routing>`
    : '';

  const unknown = t('ai.identity.unknown', undefined, locale);
  let identityBlock = '';
  if (botIdentity && (botIdentity.name || botIdentity.openId)) {
    identityBlock = [
      '<identity>',
      `  <name>${xmlEscape(botIdentity.name ?? unknown)}</name>`,
      `  <open_id>${xmlEscape(botIdentity.openId ?? unknown)}</open_id>`,
      `  <routing_rules>${t('ai.identity.short_routing', undefined, locale)}</routing_rules>`,
      '</identity>',
    ].join('\n');
  }

  let mentionBlock = '';
  if (mentions && mentions.length > 0) {
    const items = mentions.map(m => {
      const oid = m.openId ? ` open_id="${xmlEscape(m.openId)}"` : '';
      return `  <mention name="${xmlEscape(m.name)}"${oid} />`;
    });
    mentionBlock = `<mentions>\n${items.join('\n')}\n</mentions>`;
  }

  let botBlock = '';
  if (availableBots && availableBots.length > 0) {
    const mentionedOpenIds = new Set(mentions?.map(m => m.openId).filter(Boolean));
    const unmentionedBots = availableBots.filter(b => !mentionedOpenIds.has(b.openId));
    if (unmentionedBots.length > 0) {
      const items = unmentionedBots.map(
        b => `  <bot name="${xmlEscape(b.displayName)}" open_id="${xmlEscape(b.openId)}" />`,
      );
      botBlock = `<available_bots hint="${xmlEscape(t('ai.available_bots.hint', undefined, locale))}">\n${items.join('\n')}\n</available_bots>`;
    }
  }

  const userBlock = `<user_message>\n${userMessage}\n</user_message>`;
  const parts: string[] = [userBlock];

  // 2026-05-26 群聊模式 commit 2: 紧跟 user_message 后注入 ambient
  // chat timeline，让 bot 在读"被 @ 这条消息"时已经看到群里前后文
  // (类比人类进群往上滑)。caller 已 gate (group chat + chat-mode ON)。
  if (ambientContextBlock && ambientContextBlock.trim()) {
    parts.push(ambientContextBlock);
  }

  // P1 main-bot mode: append `<chat_context>` block when a ChatContext
  // exists for this chat. Spawned session reads it from the first user
  // message — no separate system prompt injection needed.
  if (chatId) {
    const ctxBlock = buildChatContextBlock(chatId);
    if (ctxBlock) parts.push(ctxBlock);
  }

  // P1 commit #8: when this is the main bot (Claude) running in the
  // configured main topic, append routing guidance (subtask-start
  // heuristic). Returns '' when conditions don't match.
  const mainBotBlock = buildMainBotPromptBlock(chatId, larkAppId);
  if (mainBotBlock) parts.push(mainBotBlock);

  // v3 #84: 子任务子群成员注入（目标/角色/其他bot/求助机制）。首轮。
  const subtaskMemberBlock = buildSubtaskMemberBlock(chatId, larkAppId);
  if (subtaskMemberBlock) parts.push(subtaskMemberBlock);

  // 输出纪律（每轮）—— 2026-06-01 邹劲松要求每群都塞；2026-06-10 加 chat 模式 gate：
  // 闲聊群（mode=chat）不注入工作纪律块，保持裸聊。缺省 work → 照旧注入。
  if (getChatMode(chatId) !== 'chat') parts.push(buildOutputDisciplineBlock());

  // 被圈时间感知（2026-06-04 邹劲松要求）：仅当本 bot 这轮被 @ 时注入最近 N 次被圈时间。
  const selfOpenIdForMentions = botIdentity?.openId ?? (larkAppId ? getBot(larkAppId)?.botOpenId ?? undefined : undefined);
  const recentMentionsBlock = buildRecentMentionsBlock(larkAppId, chatId, selfOpenIdForMentions, mentions, Date.now(), selfMentionedThisTurn);
  if (recentMentionsBlock) parts.push(recentMentionsBlock);

  const senderBlock = renderSenderTag(sender);
  if (senderBlock) parts.push(senderBlock);

  if (followUps && followUps.length > 0) {
    for (const fu of followUps) {
      parts.push(`<follow_up_message>\n${fu}\n</follow_up_message>`);
    }
  }

  const attachHint = formatAttachmentsHint(attachments, locale);
  if (attachHint) parts.push(attachHint);

  // CLIs with injectsSessionContext (Claude Code) get Lark routing/identity
  // and session ID via system prompt, so skip those blocks here.
  if (!adapter.injectsSessionContext) {
    parts.push(`<session_id>${xmlEscape(sessionId)}</session_id>`);
    if (routingBlock) parts.push(routingBlock);
    if (identityBlock) parts.push(identityBlock);
  }
  if (mentionBlock) parts.push(mentionBlock);
  if (botBlock) parts.push(botBlock);

  return parts.join('\n\n');
}

/**
 * Build the content for a follow-up message (thread reply to an active session).
 * Mirrors buildNewTopicPrompt structure but for subsequent messages.
 * Session ID is omitted for adopt mode and CLIs with injectsSessionContext.
 */
export function buildFollowUpContent(
  content: string,
  sessionId: string,
  opts?: { attachments?: LarkAttachment[]; mentions?: LarkMention[]; isAdoptMode?: boolean; cliId?: CliId; cliPathOverride?: string; locale?: Locale; sender?: ResolvedSender; chatId?: string; larkAppId?: string; selfMentionedThisTurn?: boolean },
): string {
  const parts: string[] = [`<user_message>\n${content}\n</user_message>`];

  const senderBlock = renderSenderTag(opts?.sender);
  if (senderBlock) parts.push(senderBlock);

  const attachHint = opts?.attachments && opts.attachments.length > 0
    ? formatAttachmentsHint(opts.attachments, opts.locale)
    : '';
  if (attachHint) parts.push(attachHint);

  if (!opts?.isAdoptMode) {
    const skipSessionId = opts?.cliId
      ? createCliAdapterSync(opts.cliId, opts.cliPathOverride).injectsSessionContext
      : false;
    if (!skipSessionId) {
      parts.push(`<session_id>${xmlEscape(sessionId)}</session_id>`);
    }
  }

  if (opts?.mentions && opts.mentions.length > 0) {
    const items = opts.mentions.map(m => {
      const oid = m.openId ? ` open_id="${xmlEscape(m.openId)}"` : '';
      return `  <mention name="${xmlEscape(m.name)}"${oid} />`;
    });
    parts.push(`<mentions>\n${items.join('\n')}\n</mentions>`);
  }

  // 主话题主 bot 路由注入（每轮）—— 多轮对话后主 bot 会丢失「复杂任务 subtask-start 拉子群」
  // 的路由提示。gate 在 buildMainBotPromptBlock 内（chatId===mainTopic 且 cliId==='claude-code'），
  // 蔻黛克斯/缇蕾因 cliId 不是 claude-code 拿空串 —— 自动只对主话题主 bot（克劳德）注入。
  const mainBotBlock = buildMainBotPromptBlock(opts?.chatId, opts?.larkAppId);
  if (mainBotBlock) parts.push(mainBotBlock);

  // v3 #84: 子任务子群成员注入（每轮）—— 多轮对话会丢这些信息，每条后续消息也补一次。
  const subtaskMemberBlock = buildSubtaskMemberBlock(opts?.chatId, opts?.larkAppId);
  if (subtaskMemberBlock) parts.push(subtaskMemberBlock);

  // 输出纪律（每轮）—— 2026-06-01 邹劲松要求每群都塞；2026-06-10 加 chat 模式 gate：
  // 闲聊群（mode=chat）不注入工作纪律块。缺省 work → 照旧注入。
  if (getChatMode(opts?.chatId ?? '') !== 'chat') parts.push(buildOutputDisciplineBlock());

  // 被圈时间感知（2026-06-04 邹劲松要求）：仅当本 bot 这轮被 @ 时注入最近 N 次被圈时间。
  const selfOpenIdForMentions = opts?.larkAppId ? getBot(opts.larkAppId)?.botOpenId ?? undefined : undefined;
  const recentMentionsBlock = buildRecentMentionsBlock(opts?.larkAppId, opts?.chatId, selfOpenIdForMentions, opts?.mentions, Date.now(), opts?.selfMentionedThisTurn);
  if (recentMentionsBlock) parts.push(recentMentionsBlock);

  parts.push(`<botmux_reminder>${t('ai.followup.reminder', undefined, opts?.locale)}</botmux_reminder>`);

  return parts.join('\n\n');
}

/**
 * Build raw input content for adopt-bridge mode.
 *
 * Bridge mode injects the user's text into the existing CLI exactly as the
 * local user would type it: NO `<session_id>`, NO `<botmux_reminder>`, NO
 * Skills hint. The model is intentionally unaware of botmux — the daemon
 * harvests final output via the transcript watcher and forwards it to Lark
 * out-of-band.
 *
 * Attachments and @mentions are surfaced as plain prose so the user's intent
 * carries over, but the format avoids any wording that would prompt the
 * model to call `botmux send` / route through botmux tooling.
 */
export function buildBridgeInputContent(
  content: string,
  opts?: {
    attachments?: LarkAttachment[];
    mentions?: LarkMention[];
    selfMention?: { name?: string | null; openId?: string | null };
    locale?: Locale;
  },
): string {
  const selfMention = opts?.selfMention;
  const selfNames = new Set<string>();
  if (selfMention?.name) selfNames.add(selfMention.name);
  for (const m of opts?.mentions ?? []) {
    if (selfMention?.openId && m.openId === selfMention.openId) selfNames.add(m.name);
    if (selfMention?.name && m.name === selfMention.name) selfNames.add(m.name);
  }

  const isSelfMention = (m: LarkMention): boolean => {
    // openId is authoritative when both sides have it — avoids classifying
    // a different bot as self in the (theoretical) case where two bots in
    // the same chat share a display name.
    if (selfMention?.openId && m.openId) {
      return m.openId === selfMention.openId;
    }
    // At least one side is missing openId (cold-start window before
    // probeBotOpenId returns, or a mention without openId): fall back to
    // name match.
    return !!selfMention?.name && selfNames.has(m.name);
  };
  const stripLeadingSelfMentions = (s: string): string => {
    if (selfNames.size === 0) return s;
    let out = s.trimStart();
    const tags = [...selfNames]
      .sort((a, b) => b.length - a.length)
      .map(name => `@${name}`);
    let changed = true;
    while (changed) {
      changed = false;
      for (const tag of tags) {
        if (!out.startsWith(tag)) continue;
        const next = out.charAt(tag.length);
        // Avoid stripping prefixes like "@CodexFoo" when the bot name is
        // "Codex"; Lark-rendered mentions are followed by whitespace or EOL.
        if (next && !/\s/.test(next)) continue;
        out = out.slice(tag.length).trimStart();
        changed = true;
        break;
      }
    }
    return out;
  };

  const parts: string[] = [stripLeadingSelfMentions(content)];

  if (opts?.attachments && opts.attachments.length > 0) {
    const lines = opts.attachments.map(a => `- ${a.name} (${a.path})`);
    parts.push(`\n${t('ai.bridge.attachments_label', undefined, opts.locale)}\n${lines.join('\n')}`);
  }

  const mentions = opts?.mentions?.filter(m => !isSelfMention(m)) ?? [];
  if (mentions.length > 0) {
    const lines = mentions.map(m => `- @${m.name}`);
    parts.push(`\n${t('ai.bridge.mentions_label', undefined, opts?.locale)}\n${lines.join('\n')}`);
  }

  return parts.join('\n');
}

// ─── Stream-card state persistence ───────────────────────────────────────────

/** Sentinel value (CARD_POSTING_SENTINEL from worker-pool) we must skip — it marks an in-flight POST, not a real message_id. */
const STREAM_CARD_SENTINEL = '__posting__';

/**
 * Build the prompt that gets piped into a freshly-spawned CLI when an existing
 * (non-bridge) session re-forks its worker. Hits the `worker=null` re-fork
 * branch in handleThreadReply: resume after /close, daemon-restart + new
 * message, and any other path that lands a new turn without a live worker.
 *
 * Without wrapping, the worker would queue the user's raw text as the initial
 * prompt — the CLI sees no `<user_message>` / `<botmux_reminder>` envelope
 * and answers in its own terminal instead of calling `botmux send`.  This
 * helper centralises the wrap so both daemon.ts and tests agree on the shape.
 *
 * Adopt-bridge sessions go through `buildBridgeInputContent` instead — see
 * the buildBridgeInputContent docstring for why bridge prompts intentionally
 * skip botmux routing tags.
 */
export function buildReforkPrompt(
  ds: DaemonSession,
  content: string,
  opts?: {
    attachments?: LarkAttachment[];
    mentions?: LarkMention[];
    cliId?: CliId;
    cliPathOverride?: string;
    selfMention?: { name?: string | null; openId?: string | null };
    locale?: Locale;
    sender?: ResolvedSender;
    /** 被圈时间感知（2026-06-04）：本轮本 bot 是否被 @ 的权威判定，透传给 buildFollowUpContent。 */
    selfMentionedThisTurn?: boolean;
  },
): string {
  const locale = opts?.locale ?? localeForBot(ds.larkAppId);
  if (ds.adoptedFrom) {
    return buildBridgeInputContent(content, {
      attachments: opts?.attachments,
      mentions: opts?.mentions,
      selfMention: opts?.selfMention,
      locale,
    });
  }
  return buildFollowUpContent(content, ds.session.sessionId, {
    attachments: opts?.attachments,
    mentions: opts?.mentions,
    isAdoptMode: false,
    cliId: opts?.cliId,
    cliPathOverride: opts?.cliPathOverride,
    locale,
    sender: opts?.sender,
    chatId: ds.session.chatId,
    larkAppId: ds.larkAppId,
    selfMentionedThisTurn: opts?.selfMentionedThisTurn,
  });
}

/**
 * Copy current streaming-card fields from `ds` into the persisted Session and save.
 * Lets the existing card be PATCHed on next screen_update after a daemon restart,
 * instead of a fresh card being POSTed.
 */
export function persistStreamCardState(ds: DaemonSession): void {
  const cardId = ds.streamCardId === STREAM_CARD_SENTINEL ? undefined : ds.streamCardId;
  const s = ds.session;
  // Skip write if nothing actually changed — avoids disk churn on every screen_update.
  if (
    s.streamCardId === cardId &&
    s.streamCardNonce === ds.streamCardNonce &&
    s.displayMode === ds.displayMode &&
    s.currentImageKey === ds.currentImageKey &&
    s.currentTurnTitle === ds.currentTurnTitle &&
    sameUsageLimit(s.usageLimit, ds.usageLimit) &&
    s.lastUserPrompt === ds.lastUserPrompt &&
    s.lastCliInput === ds.lastCliInput
  ) return;
  s.streamCardId = cardId;
  s.streamCardNonce = ds.streamCardNonce;
  s.displayMode = ds.displayMode;
  s.currentImageKey = ds.currentImageKey;
  s.currentTurnTitle = ds.currentTurnTitle;
  s.usageLimit = ds.usageLimit;
  s.lastUserPrompt = ds.lastUserPrompt;
  s.lastCliInput = ds.lastCliInput;
  // Clear legacy field so it doesn't drift
  s.streamExpanded = undefined;
  sessionStore.updateSession(s);
}

export function rememberLastCliInput(ds: DaemonSession, userPrompt: string, cliInput: string): void {
  ds.lastUserPrompt = userPrompt;
  ds.lastCliInput = cliInput;
  ds.session.lastUserPrompt = userPrompt;
  ds.session.lastCliInput = cliInput;
  sessionStore.updateSession(ds.session);
}

// ─── Session restore ─────────────────────────────────────────────────────────

export function restoreActiveSessions(activeSessions: Map<string, DaemonSession>): void {
  const sessions = sessionStore.listSessions();
  const active = sessions.filter(s => s.status === 'active');

  if (active.length === 0) {
    logger.info('No active sessions to restore');
    return;
  }

  // Kill any stale CLI processes from previous daemon run
  killStalePids(active);

  logger.info(`Registering ${active.length} active session(s) (no CLI spawn until new messages arrive)...`);

  for (const session of active) {
    if (isTillyMainTopicConversationDenied(session.cliId, session.chatId)) {
      logger.info(`[${session.larkAppId ?? 'unknown'}] closing forbidden coco mainTopic session during restore (${session.sessionId.substring(0, 8)})`);
      sessionStore.closeSession(session.sessionId);
      continue;
    }

    // Restored sessions persisted before the scope field was added default to
    // 'thread' — that matches the legacy thread-only behaviour.
    const scope: 'thread' | 'chat' = session.scope === 'chat' ? 'chat' : 'thread';

    // Adopt sessions: restore if original CLI is still alive, otherwise close
    if (session.title?.startsWith('Adopt:') && session.adoptedFrom) {
      const adopted = session.adoptedFrom;
      if (!validateAdoptTarget(adopted.tmuxTarget, adopted.originalCliPid)) {
        logger.info(`Closing adopt session ${session.sessionId} (original CLI exited)`);
        sessionStore.closeSession(session.sessionId);
        continue;
      }
      // Original CLI still alive — re-register and fork adopt worker
      const larkAppId = session.larkAppId ?? getAllBots()[0]?.config.larkAppId ?? '';
      const ds: DaemonSession = {
        session,
        worker: null,
        workerPort: null,
        workerToken: null,
        larkAppId,
        chatId: session.chatId,
        chatType: session.chatType ?? 'group',
        scope,
        spawnedAt: sessionCreatedAtMs(session),
        cliVersion: getCurrentCliVersion(),
        lastMessageAt: sessionLastMessageAtMs(session),
        hasHistory: false,
        workingDir: adopted.cwd,
        adoptedFrom: adopted as DaemonSession['adoptedFrom'],
        streamCardId: session.streamCardId,
        streamCardNonce: session.streamCardNonce,
        displayMode: session.displayMode === 'screenshot' || session.displayMode === 'hidden'
          ? session.displayMode
          : (session.streamExpanded ? 'screenshot' : 'hidden'),
        currentImageKey: session.currentImageKey,
        currentTurnTitle: session.currentTurnTitle,
        usageLimit: session.usageLimit,
        lastUserPrompt: session.lastUserPrompt,
        lastCliInput: session.lastCliInput,
      };
      const anchor = sessionAnchorId(ds);
      messageQueue.ensureQueue(anchor);
      if (ds.usageLimit) restoreUsageLimitRuntimeState(ds);
      activeSessions.set(sessionKey(anchor, larkAppId), ds);
      forkAdoptWorker(ds, { restoredFromMetadata: true });
      logger.info(`[${session.sessionId.substring(0, 8)}] Restored adopt session (target: ${adopted.tmuxTarget}, scope: ${scope})`);
      continue;
    }
    // Adopt sessions without persisted metadata — close (legacy)
    if (session.title?.startsWith('Adopt:')) {
      logger.debug(`Closing adopt session ${session.sessionId} (no persisted metadata)`);
      sessionStore.closeSession(session.sessionId);
      continue;
    }

    const larkAppId = session.larkAppId ?? getAllBots()[0]?.config.larkAppId ?? '';
    const ds: DaemonSession = {
      session,
      worker: null,
      workerPort: null,
      workerToken: null,
      larkAppId,
      chatId: session.chatId,
      chatType: session.chatType ?? 'group',
      scope,
      spawnedAt: sessionCreatedAtMs(session),
      cliVersion: getCurrentCliVersion(),
      lastMessageAt: sessionLastMessageAtMs(session),
      hasHistory: true,  // restored sessions have prior CLI history
      workingDir: session.workingDir,
      // Restore persisted streaming-card state — next screen_update will PATCH
      // the existing card instead of POSTing a fresh one. If the card was
      // withdrawn while we were down, the PATCH fails with MessageWithdrawnError
      // and the existing handler (worker-pool flushCardPatch) clears streamCardId,
      // letting the next update create a new card.
      streamCardId: session.streamCardId,
      streamCardNonce: session.streamCardNonce,
      displayMode: session.displayMode ?? (session.streamExpanded ? 'screenshot' : 'hidden'),
      currentImageKey: session.currentImageKey,
      currentTurnTitle: session.currentTurnTitle,
      usageLimit: session.usageLimit,
      lastUserPrompt: session.lastUserPrompt,
      lastCliInput: session.lastCliInput,
    };
    const anchor = sessionAnchorId(ds);
    messageQueue.ensureQueue(anchor);
    if (ds.usageLimit) restoreUsageLimitRuntimeState(ds);
    activeSessions.set(sessionKey(anchor, larkAppId), ds);

    logger.debug(`Registered session ${session.sessionId} (scope: ${scope}, anchor: ${anchor})`);
  }

  // Tmux mode: auto-fork workers for sessions with surviving tmux sessions
  if (config.daemon.backendType === 'tmux') {
    for (const [, ds] of activeSessions) {
      const tmuxName = TmuxBackend.sessionName(ds.session.sessionId);
      if (!TmuxBackend.hasSession(tmuxName)) continue;

      // Guard against re-attaching to a tmux session that was started with a
      // different CLI than the bot is currently configured for. tmux's
      // attach-session ignores the bin/args we hand to backend.spawn(), so
      // without this check, changing a bot's cliId in bots.json would silently
      // resurrect the OLD CLI on restart. Compare persisted session.cliId
      // (stamped at fork time in worker-pool.forkWorker) against the bot's
      // current config; mismatch ⇒ kill the stale tmux, let the next message
      // trigger a fresh spawn.
      const tag = ds.session.sessionId.substring(0, 8);
      const sessionCliId = ds.session.cliId;
      let botCliId: CliId | undefined;
      try { botCliId = getBot(ds.larkAppId).config.cliId; } catch { /* bot deregistered */ }
      if (sessionCliId && botCliId && sessionCliId !== botCliId) {
        logger.warn(`[${tag}] CLI mismatch (session=${sessionCliId}, bot=${botCliId}), killing stale tmux ${tmuxName}`);
        TmuxBackend.killSession(tmuxName);
        continue;
      }

      logger.info(`[${tag}] Tmux session alive, auto-forking worker to re-attach`);
      forkWorker(ds, '', true);
    }
  }

  logger.info(`Restored ${active.length} session(s)${config.daemon.backendType === 'tmux' ? '' : ', waiting for messages to resume'}`);
}

/**
 * Reactivate a single closed session — used by the "▶️ 恢复会话" card button
 * and the `botmux resume <id>` CLI command. Mirrors the per-session branch
 * of `restoreActiveSessions` but operates on one record by id and without
 * killing stale pids (the `/close` flow that produced this closed record
 * already killed them).
 *
 * Returns `{ ok: true, ds }` on success; structured error otherwise so callers
 * (HTTP IPC, card handler) can surface a precise message.
 *
 *   - 'not_found'        — sessionId doesn't exist in any session file
 *   - 'not_closed'       — session is still active or in some other state
 *   - 'anchor_occupied'  — another active session already owns this anchor
 *                          (e.g. user kept typing after /close, auto-creating
 *                          a fresh thread session); refuse rather than clobber
 *   - 'adopt_unsupported' — adopt sessions are torn down by /close and have
 *                          no resume semantics
 */
export function resumeSession(
  sessionId: string,
  activeSessions: Map<string, DaemonSession>,
): { ok: true; ds: DaemonSession }
| { ok: false; error: 'not_found' | 'not_closed' | 'anchor_occupied' | 'adopt_unsupported' | 'conversation_denied'; activeSessionId?: string } {
  const session = sessionStore.getSession(sessionId);
  if (!session) return { ok: false, error: 'not_found' };
  if (session.status !== 'closed') return { ok: false, error: 'not_closed' };

  // Adopt sessions don't survive /close — the user's tmux pane and original
  // CLI pid have already moved on, and bringing the bridge back without a live
  // pane is meaningless.
  if (session.title?.startsWith('Adopt:') || session.adoptedFrom) {
    return { ok: false, error: 'adopt_unsupported' };
  }

  if (isTillyMainTopicConversationDenied(session.cliId, session.chatId)) {
    logger.info(`[${session.larkAppId ?? 'unknown'}] denying resume in mainTopic for coco bot (chat=${session.chatId})`);
    return { ok: false, error: 'conversation_denied' };
  }

  const scope: 'thread' | 'chat' = session.scope === 'chat' ? 'chat' : 'thread';
  const larkAppId = session.larkAppId ?? getAllBots()[0]?.config.larkAppId ?? '';
  const anchor = scope === 'thread' ? session.rootMessageId : session.chatId;
  const key = sessionKey(anchor, larkAppId);

  const existing = activeSessions.get(key);
  if (existing) {
    return { ok: false, error: 'anchor_occupied', activeSessionId: existing.session.sessionId };
  }

  // Belt-and-suspenders: also scan persisted sessions for any *other* active
  // session pinned to the same (larkAppId, scope, anchor). The in-memory Map
  // is the authoritative routing source for a running daemon, but it's only
  // hydrated for sessions that survived restoreActiveSessions. Cross-process
  // and partial-load situations (e.g. another bot's daemon writes a session
  // file but our Map hasn't caught up, or a closed session was orphaned by a
  // crash that left a sibling session active in the same anchor) can leave a
  // store-level conflict invisible to the Map check above. Refuse instead of
  // overwriting the routing key.
  const conflict = sessionStore.listSessions().find(s =>
    s.sessionId !== sessionId
    && s.status === 'active'
    && (s.larkAppId ?? '') === larkAppId
    && (s.scope === 'chat' ? 'chat' : 'thread') === scope
    && (scope === 'thread' ? s.rootMessageId === anchor : s.chatId === anchor),
  );
  if (conflict) {
    return { ok: false, error: 'anchor_occupied', activeSessionId: conflict.sessionId };
  }

  // Reactivate in store — clear closedAt so dashboard rows don't keep showing
  // the stale close timestamp on the now-active session.
  session.status = 'active';
  session.closedAt = undefined;
  session.lastMessageAt = new Date().toISOString();
  sessionStore.updateSession(session);

  const now = Date.now();
  const ds: DaemonSession = {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId,
    chatId: session.chatId,
    chatType: session.chatType ?? 'group',
    scope,
    spawnedAt: sessionCreatedAtMs(session),
    cliVersion: getCurrentCliVersion(),
    lastMessageAt: now,
    hasHistory: true,    // resumed sessions carry CLI history (--resume on next fork)
    workingDir: session.workingDir,
    ownerOpenId: session.ownerOpenId,
    streamCardId: session.streamCardId,
    streamCardNonce: session.streamCardNonce,
    displayMode: session.displayMode ?? (session.streamExpanded ? 'screenshot' : 'hidden'),
    currentImageKey: session.currentImageKey,
    currentTurnTitle: session.currentTurnTitle,
    usageLimit: session.usageLimit,
    lastUserPrompt: session.lastUserPrompt,
    lastCliInput: session.lastCliInput,
  };

  messageQueue.ensureQueue(anchor);
  activeSessions.set(key, ds);
  logger.info(`Resumed session ${sessionId.substring(0, 8)} (scope: ${scope}, anchor: ${anchor.substring(0, 12)})`);
  return { ok: true, ds };
}

// ─── Scheduled task execution ────────────────────────────────────────────────

export async function executeScheduledTask(
  task: ScheduledTask,
  activeSessions: Map<string, DaemonSession>,
  refreshCliVersion: (...args: any[]) => boolean,
): Promise<void> {
  // Resolve which bot to use — prefer the task's original bot so replies come from
  // the same account the user set up the schedule with.
  const allBots = getAllBots();
  if (allBots.length === 0) {
    // Expected at startup before bot configs finish loading; scheduler will
    // re-fire on the next cron tick. Not actionable.
    logger.debug('No bots configured, skipping scheduled task');
    return;
  }
  const bot =
    (task.larkAppId && allBots.find(b => b.config.larkAppId === task.larkAppId)) ||
    allBots[0];
  const larkAppId = bot.config.larkAppId;

  const { getChatMode, sendMessage, replyMessage } = await import('../im/lark/client.js');

  // Scope resolution — explicit task.scope wins; otherwise fall back to legacy
  // semantics (rootMessageId present → thread, absent → chat). Restoring an
  // older schedule without scope keeps current behaviour.
  const scope: 'thread' | 'chat' = task.scope === 'chat'
    ? 'chat'
    : task.scope === 'thread'
      ? 'thread'
      : (task.rootMessageId ? 'thread' : 'chat');

  // Decide where to route the "🕐 task started" notification and where the
  // session conversation lands.
  //
  // Thread-scope (legacy and current default):
  //   - cross-thread (creator != target): notify creator's thread; deliver
  //     execution into target rootMessageId
  //   - same-thread:                       notify into the bound thread,
  //     which doubles as the session anchor
  //   - missing rootMessageId:             fall back to a fresh top-level
  //     post in the chat (one-shot session)
  //
  // Chat-scope (auto-adopt / 普通群): post the start notification straight to
  // the chat without reply_in_thread; the chat IS the session anchor.
  let anchor: string;
  let isContinuation = false;

  if (scope === 'chat') {
    // A group may have been converted from 普通群 to 话题群 after the schedule
    // was created. In topic mode, a top-level sendMessage creates a new topic;
    // keep scheduled continuations in the original thread when we have one.
    const chatMode = await getChatMode(larkAppId, task.chatId, { forceRefresh: true });
    if (chatMode === 'topic' && task.rootMessageId) {
      try {
        await replyMessage(larkAppId, task.rootMessageId, `🕐 定时任务「${task.name}」开始执行`, 'text', true);
        anchor = task.rootMessageId;
        isContinuation = true;
      } catch (err: any) {
        logger.warn(`[scheduler] Failed to reply in converted topic chat ${task.rootMessageId} (${err.message}); falling back to new thread`);
        anchor = await sendMessage(larkAppId, task.chatId, `🕐 定时任务「${task.name}」开始执行`);
      }
    } else if (task.creatorRootMessageId && task.creatorChatId !== task.chatId) {
      const creatorAppId = task.creatorLarkAppId ?? larkAppId;
      replyMessage(
        creatorAppId,
        task.creatorRootMessageId,
        `🕐 定时任务「${task.name}」已在目标群聊触发`,
        'text',
        true,
      ).catch((err: any) => {
        logger.warn(`[scheduler] Failed to notify creator thread ${task.creatorRootMessageId} (${err.message})`);
      });
    } else {
      // Same-chat: post the start banner to the chat as a plain message.
      try {
        await sendMessage(larkAppId, task.chatId, `🕐 定时任务「${task.name}」开始执行`);
      } catch (err: any) {
        logger.warn(`[scheduler] Failed to post start banner in chat ${task.chatId} (${err.message})`);
      }
    }
    anchor = task.chatId;
    isContinuation = !!activeSessions.get(sessionKey(anchor, larkAppId));
  } else {
    // thread-scope path (existing logic)
    const isCrossThread =
      !!task.creatorRootMessageId &&
      !!task.rootMessageId &&
      task.creatorRootMessageId !== task.rootMessageId;

    if (isCrossThread) {
      const creatorAppId = task.creatorLarkAppId ?? larkAppId;
      replyMessage(
        creatorAppId,
        task.creatorRootMessageId!,
        `🕐 定时任务「${task.name}」已在目标话题触发`,
        'text',
        true,
      ).catch((err: any) => {
        logger.warn(`[scheduler] Failed to notify creator thread ${task.creatorRootMessageId} (${err.message})`);
      });
      anchor = task.rootMessageId!;
      isContinuation = true;
    } else if (task.rootMessageId) {
      try {
        await replyMessage(
          larkAppId,
          task.rootMessageId,
          `🕐 定时任务「${task.name}」开始执行`,
          'text',
          true,
        );
        anchor = task.rootMessageId;
        isContinuation = true;
      } catch (err: any) {
        logger.warn(`[scheduler] Failed to reply in original thread ${task.rootMessageId} (${err.message}); falling back to new thread`);
        anchor = await sendMessage(larkAppId, task.chatId, `🕐 定时任务「${task.name}」开始执行`);
      }
    } else {
      anchor = await sendMessage(larkAppId, task.chatId, `🕐 定时任务「${task.name}」开始执行`);
    }
  }

  refreshCliVersion(bot.config.cliId, bot.config.cliPathOverride);

  // Inject into a live session if one already exists at this anchor.
  const existing = activeSessions.get(sessionKey(anchor, larkAppId));
  if (isContinuation && existing?.worker && !existing.worker.killed) {
    markSessionActivity(existing);
    try {
      rememberLastCliInput(existing, task.prompt, task.prompt);
      existing.worker.send({ type: 'message', content: task.prompt });
      logger.info(`[scheduler] Task "${task.name}" injected into live session ${existing.session.sessionId}`);
      return;
    } catch (err: any) {
      logger.warn(`[scheduler] Failed to inject into live session (${err.message}); spawning fresh worker`);
    }
  }

  // Spawn a fresh session bound to the chosen anchor.
  // Thread-scope: rootMessageId = anchor. Chat-scope: rootMessageId stores the
  // chatId-as-seed for audit (sessionAnchorId() returns chatId via scope). If a
  // formerly chat-scope task was redirected into a converted topic chat, promote
  // the runtime session to thread-scope so follow-up replies stay in-thread.
  const runtimeScope: 'thread' | 'chat' = scope === 'chat' && anchor !== task.chatId ? 'thread' : scope;
  const session = sessionStore.createSession(task.chatId, anchor, `${t('schedule.title_prefix', undefined, localeForBot(larkAppId))} ${task.name}`);
  const now = Date.now();
  session.larkAppId = larkAppId;
  session.scope = runtimeScope;
  session.lastMessageAt = new Date(now).toISOString();
  sessionStore.updateSession(session);
  messageQueue.ensureQueue(anchor);

  // 2026-05-26 群聊模式 commit 3: scheduled task spawn 也注入 ambient (尽管 task
  // prompt 自带 context, 加上不害, chatType=p2p 时 helper 自己 return '')
  const { buildAmbientForSpawn } = await import('../services/chat-recent-context.js');
  const ambientBlock = await buildAmbientForSpawn(larkAppId, session.chatId, session.chatType);
  const prompt = buildNewTopicPrompt(task.prompt, session.sessionId, bot.config.cliId, bot.config.cliPathOverride, undefined, undefined, undefined, undefined, { name: bot.botName, openId: bot.botOpenId }, localeForBot(larkAppId), undefined, session.chatId, larkAppId, ambientBlock);

  const ds: DaemonSession = {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId,
    chatId: task.chatId,
    chatType: task.chatType === 'p2p' ? 'p2p' : 'group',
    scope: runtimeScope,
    spawnedAt: sessionCreatedAtMs(session),
    cliVersion: getCurrentCliVersion(),
    lastMessageAt: now,
    hasHistory: isContinuation,
    workingDir: task.workingDir,
  };
  activeSessions.set(sessionKey(anchor, larkAppId), ds);
  rememberLastCliInput(ds, task.prompt, prompt);
  forkWorker(ds, prompt);

  logger.info(`[scheduler] Task "${task.name}" spawned (session: ${session.sessionId}, scope: ${scope}, anchor: ${anchor}, continuation: ${isContinuation})`);
}

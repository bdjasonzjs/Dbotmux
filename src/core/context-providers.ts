/**
 * ContextProvider registry —— 半静态上下文注入块的统一抽象（设计: Dbotmux-task-notes/
 * design-context-file-delivery.md §3.1）。
 *
 * 背景：buildNewTopicPrompt / buildFollowUpContent 原来把 chat_context / main_bot_routing /
 * subtask_member_routing / output_discipline 四个大块每轮字符串拼接随消息全文下发。
 * 本模块把每个块收敛成一个注册制 provider（gate 逻辑进 applies、渲染逻辑进 render），
 * 消息构建侧只遍历 registry 装配——以后新增一种注入类型 = 注册一个 provider，不改拼接主干。
 *
 * delivery 语义：
 *   - 'inline'：照旧拼进消息体。
 *   - 'file'  ：file 模式下写入 ContextFileManager 的合并文件，消息里只带 <context_ref> stub；
 *               inline 模式（默认）下仍照旧拼进消息体，行为与历史逐字节一致。
 *
 * 动态小块（user_message / sender / mentions / attachments / session_id / recent_mentions /
 * ambient timeline / botmux_reminder）**不进本 registry**——每轮都变或安全关键，永远 inline，
 * 由 session-manager 直接拼（设计 §3.1 分类硬约束）。
 */
import { logger } from '../utils/logger.js';
import { getBot } from '../bot-registry.js';
import { getCompanyByRootChatId, getMainTopicBotRef, getMainTopicChatId } from '../services/main-topic-config.js';
import { getChatMode } from '../services/chat-mode-store.js';
import * as chatContextStore from '../services/chat-context-store.js';
import * as subtaskStore from '../services/subtask-store.js';
import { renderCollabNorms } from '../services/subtask-norms.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import type { CliId } from '../adapters/cli/types.js';
import { getContextDelivery } from '../services/context-delivery-store.js';
import { materializeContextFile } from '../services/context-file-manager.js';

/** XML-escape a string for use as element text content or attribute value.
 *  Covers the five XML-mandated entities; sufficient for our use case
 *  (paths, names, open_ids, bot identifiers) since we never embed raw user
 *  input in attribute values. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─── Provider 抽象 ───────────────────────────────────────────────────────────

export type ContextDeliveryPreference = 'inline' | 'file';

/** 构建一轮消息时 provider 可见的上下文。 */
export interface BuildCtx {
  chatId?: string;
  larkAppId?: string;
  /** 首轮（新话题 spawn）还是后续轮（follow-up）。 */
  round: 'new_topic' | 'follow_up';
  /** 本会话的 CLI 引擎；file 模式能力 gate 用（未知引擎保守回 inline）。 */
  cliId?: CliId;
  cliPathOverride?: string;
  /** adopt 会话（botmux-aware adopt，非 bridge）——保守不走 file 模式。 */
  isAdoptMode?: boolean;
}

export interface ContextProvider {
  /** 'chat_context' | 'main_bot_routing' | 'subtask_member_routing' | 'output_discipline' | ... */
  id: string;
  scope: 'global' | 'chat' | 'chat+bot' | 'task';
  /** file 模式下该块的运载方式；inline 模式下一律拼进消息（见模块头注释）。 */
  delivery: ContextDeliveryPreference;
  /**
   * inline 运载时在哪些轮注入。'all' = 每轮；'new_topic' = 仅首轮（历史上
   * chat_context 只在首轮注入）。file 运载不受此限制——半静态内容进文件后，
   * 每轮都参与渲染/hash，才能让「内容更新 → version 变化 → bot 重读」成立。
   */
  inlineRounds: 'all' | 'new_topic';
  /** 廉价 gate（原有各块的注入条件搬进来）。render 返回 '' 同样视为不注入。 */
  applies(ctx: BuildCtx): boolean;
  /** 渲染块全文。不适用时返回 ''。 */
  render(ctx: BuildCtx): string;
  /**
   * file 模式「一行精华」（可选）：完整块进文件、消息里只留 stub 时，这一行**每轮**
   * 仍拼进 stub，做行为兜底——即使 bot 偷懒不读文件，最核心的方向性指令也在眼前，
   * 不至于犯方向性错误（如 CEO 忘了「先判归口交经理群」）。
   * 只在本块本轮真会渲染（render 非空）时才带上（跟随 render 的 gate，天然按群/角色收敛）。
   * ⚠️ 只写**稳定不变的一句核心指令**，别复述动态内容——避免与文件正文 drift。
   * 不声明 = 该块不进 stub 精华（仍靠「去读文件」兜底）。inline 模式下本字段完全不参与。
   */
  tldr?(ctx: BuildCtx): string;
}

const registry: ContextProvider[] = [];

/** 注册一个 provider（追加到末尾；装配顺序 = 注册顺序）。 */
export function registerContextProvider(p: ContextProvider): void {
  if (registry.some(r => r.id === p.id)) {
    throw new Error(`context provider id duplicated: ${p.id}`);
  }
  registry.push(p);
}

export function listContextProviders(): readonly ContextProvider[] {
  return registry;
}

// ─── 原有四个块的渲染逻辑（从 session-manager.ts 原样搬入，文案零改动） ─────────

function identitySourceForCli(cliId: string): string {
  switch (cliId) {
    case 'claude-code': return '~/.claude/CLAUDE.md';
    case 'codex': return '~/.codex/AGENTS.override.md if present, otherwise ~/.codex/AGENTS.md';
    case 'coco': return '~/.coco/AGENTS.md';
    default: return 'this bot engine\'s own configured identity/home files';
  }
}

function isConfiguredMainBot(larkAppId: string, chatId?: string): boolean {
  let bot;
  try {
    bot = getBot(larkAppId);
  } catch { return false; }
  const company = getCompanyByRootChatId(chatId);
  if (company?.ceoLarkAppId && company.ceoLarkAppId === larkAppId) return true;
  const ref = getMainTopicBotRef(chatId).toLowerCase();
  const cliId = bot.config.cliId;
  const botName = bot.botName?.toLowerCase();
  const aliases: Record<string, string[]> = {
    claude: ['claude', 'c', 'claude-code', '克劳德'],
    codex: ['codex', 'k', '蔻黛克斯', '寇黛克斯'],
    tilly: ['tilly', 't', 'coco', '缇蕾', '小宝'],
  };
  if (bot.config.larkAppId && ref === bot.config.larkAppId.toLowerCase()) return true;
  if (ref === cliId.toLowerCase()) return true;
  if (botName && ref === botName) return true;
  if (aliases.claude.includes(ref)) return cliId === 'claude-code';
  if (aliases.codex.includes(ref)) return cliId === 'codex';
  if (aliases.tilly.includes(ref)) return cliId === 'coco';
  return false;
}

export function buildMainBotPromptBlock(chatId: string | undefined, larkAppId: string | undefined): string {
  if (!chatId || !larkAppId) return '';
  const mainTopic = getMainTopicChatId();
  const company = getCompanyByRootChatId(chatId);
  if (!company && (!mainTopic || chatId !== mainTopic)) return '';
  if (!isConfiguredMainBot(larkAppId, chatId)) return '';
  const bot = getBot(larkAppId);
  const companyName = company?.name ?? 'legacy-main-topic';
  const identityLine = `你是 bot「${bot.botName ?? bot.config.larkAppId}」担任 Company「${companyName}」的 CEO / main-bot。启动前必须读取并遵守自己的身份来源：${identitySourceForCli(bot.config.cliId)}；不要继承其他 bot 的身份文件或私密记忆。`;
  const commandLine = '复杂任务优先用 `botmux subtask-start` 或 `botmux bot ceo-spawn` 编排；要起固定协作流程小组（observer / 多层评审 / 定时盯外部群）用任务小组，详见 skill `botmux-taskteam`；需要审查的工程产出先写飞书 docx/绝对路径，再 request-review；未经授权不 commit/push/deploy。';
  return `<main_bot_routing>
你在 Company「${companyName}」的 CEO 主话题工作（rootChatId=${chatId}）。

**定位：你是 CEO** —— ${identityLine} 以**决策和分派**为主。能交给子群解决的问题就**尽量分派出去**，自己不必亲自下场干每件细活。邹劲松是**董事长**：只有**真正重要的问题**（重大方向 / 高风险 / 不可逆决策）才找他拍板；其余不是非常重要的事，你**自行决断、自主推进**，别事事等他。

**任务分派（先判归口，再动手）**：
- 复杂 / 多轮任务（PRD / bug 清单 / 跨群 / 多 bot / 预期多轮）**先判归口**——先了解当前有哪些常驻 domain 经理群、各管什么域（\`botmux subtask-managers\` 列活跃经理群；该命令没有时退而从 CEO 收件箱近期 digest 反推，别凭记忆）：
  → **有对口经理** → 把任务交给经理（\`subtask-supplement --target-role main\` 下发），由**经理** \`subtask-start\` 建孙群、经理 own + 跟踪；CEO **不亲自建**。
  → **没有对口经理 / 分不出归属 / 邹劲松直接点你快办** → CEO 自己 \`subtask-start --goal "..." [--acceptance][--bots <ref>[:role]]\` 建群（**保留此能力**，用于快速解决），阻塞拿 chatId，主话题回「✅ 已建子群（oc_xxx）」。
  → 同一任务**只走一条路**，别既交经理又自己建（双重派发）。
- 经理 session 老化 / 不响应 → 先**重启经理**让它能干，**别 CEO 绕过自建**。
- 只有一句话能搞定的即时答疑 / 闲聊才自己直接答。
- ${commandLine}

**决策与上报**：
- 不是非常重要的问题 → **自行决断、自主推进**，不必上报
- 真正重要的（重大 / 高风险 / 不可逆）→ 才找邹劲松；走 RootInbox（P2），**不在子群直接 @ 他**（他不在群里）
- 同一任务不重复调 subtask-start（idempotencyKey 自动夹）

工具自动从 env 注入 sessionId — 你**不需要**手动带 \`--session-id\` flag。
</main_bot_routing>`;
}

/**
 * 输出纪律注入（每轮，所有会话 / 所有 bot 通用，gate = chat 模式群不注入）。
 *
 * 把「对外说话」和「执行命令(工具调用)」分成两个独立回合，降低工具调用在底层被
 * 损坏（malformed）的概率：同一回合里既写正文又紧跟工具调用，会把工具调用结构
 * 搅乱，导致解析失败 + 残片泄漏到群里。2026-06-01 邹劲松要求每轮、每群都注入。
 * adopt/bridge 模式（botmux-unaware）走 buildBridgeInputContent，不经过此函数。
 */
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
type SeatRole = 'main' | 'collab' | 'observer';

/** 解析本 bot 在某子任务里的席位（供 block 全文 + tldr 共用，避免两处 drift）。 */
function resolveSelfSeat(task: NonNullable<ReturnType<typeof subtaskStore.getByChatId>>, larkAppId: string): { selfOpenId: string | null; seat: SeatRole | undefined } {
  try {
    const b = getBot(larkAppId);
    const selfOpenId = b.botOpenId ?? null;
    const seat = task.bots.find(bot => bot.openId === selfOpenId)?.role as SeatRole | undefined;
    return { selfOpenId, seat };
  } catch { return { selfOpenId: null, seat: undefined }; }
}

/** subtask_member_routing 的一行精华：**按席位分流**（蔻黛克斯 review blocker 2——原来把执行者
 *  专属动作 `subtask-request-review` 塞给了 reviewer/observer，与「reviewer 只 review 不驱动」冲突）。
 *  gate 与 buildSubtaskMemberBlock 完全一致（同 getByChatId + 终态守卫），保证「块渲染 ⇔ 精华出现」。 */
function subtaskMemberTldr(ctx: BuildCtx): string {
  if (!ctx.chatId || !ctx.larkAppId) return '';
  let task: ReturnType<typeof subtaskStore.getByChatId>;
  try { task = subtaskStore.getByChatId(ctx.chatId); } catch { return ''; }
  if (!task || task.status === 'finished' || task.status === 'stopped') return '';
  const { seat } = resolveSelfSeat(task, ctx.larkAppId);
  const esc = '卡住/岔路用 `subtask-askforhelp` 逐级上报父群，严禁直接 @ / 惊动 owner';
  if (seat === 'main') return `你是本子群执行者(main)：驱动任务、产出先 \`subtask-request-review\` 唤 reviewer；${esc}。`;
  if (seat === 'collab') return `你是本子群 reviewer：只 review/challenge、不驱动任务、不抢实现；${esc}。`;
  if (seat === 'observer') return `你是本子群观测者：只盯群/触发唤醒、不参与执行；${esc}。`;
  return `你在子任务子群干活：按本群【你的角色】推进；${esc}。`;
}

export function buildSubtaskMemberBlock(chatId: string | undefined, larkAppId: string | undefined): string {
  if (!chatId || !larkAppId) return '';
  let task: ReturnType<typeof subtaskStore.getByChatId>;
  try { task = subtaskStore.getByChatId(chatId); }
  catch (err) { logger.warn(`[context-providers] subtask member lookup failed for ${chatId}: ${err}`); return ''; }
  if (!task) return '';
  if (task.status === 'finished' || task.status === 'stopped') return ''; // 终态不再注入

  // 角色定义按本子任务的席位注入，而不是按 bot 引擎(cliId)或名字推断。
  // 同一个引擎可同时坐 main/collab/observer，不同席位必须拿到不同职责文案。
  const ROLE_BY_SEAT: Record<'main' | 'collab' | 'observer', string> = {
    main: '执行者(主推进者) —— 你驱动任务、方案/代码/文档都由你产出。产出第一份可 review 物后，用 `botmux subtask-request-review --task-id <id> --summary "<可打开的链接/绝对路径>"` 唤起 reviewer；别闷头到底。对 reviewer 的意见要独立思考、别轻易全盘接受——reviewer 经常给过于保守、不一定合理的建议；逐条判断是不是真正值得改的，值得才改、不值得就简述理由驳回，不被它带着无谓地反复返工。全程遵守本任务 kickoff/补充指令里的 commit、push、部署边界；没有显式授权就只停在 working tree。',
    collab: 'Reviewer —— 只 review/challenge：**不驱动任务、不产主交付物、不直接实现**。只在执行者已有方案/代码/明确请求 review 时再 review，发现问题挑出来交执行者改，别自己上手抢执行。',
    observer: '观测/盯群、触发唤醒（不参与执行）',
  };
  const { selfOpenId, seat: selfSeat } = resolveSelfSeat(task, larkAppId);
  let selfRole = '(未识别角色，按子任务目标干活)';
  if (selfSeat) selfRole = ROLE_BY_SEAT[selfSeat] ?? selfRole;

  const others = task.bots
    .filter(b => b.openId !== selfOpenId)
    .map(b => `  - ${b.name}：${ROLE_BY_SEAT[b.role] ?? '协作'}`);
  const accLine = task.acceptance ? `\n【验收标准】${task.acceptance}` : '';

  // 嵌套裂变授权（双帽角色重述）：仅 task.spawnable===true 且本 bot 是执行者(main) 时注入；
  // 无裂变段时保持【你的角色】与【群里其他成员】的结构锚点，角色文案按席位语义渲染。
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
    logger.warn(`[context-providers] buildChatContextBlock failed for chat ${chatId}: ${err}`);
    return '';
  }
}

// ─── 内置 provider 注册（顺序 = 历史拼接顺序，保证 inline 模式逐字节一致） ─────

registerContextProvider({
  id: 'chat_context',
  scope: 'chat',
  delivery: 'file',
  // 历史行为：<chat_context> 只在首轮注入（P1 main-bot mode）。file 模式下每轮都进文件，
  // 让 chatContextStore 更新 → version 变化 → bot 重读（设计 §2 表格「变化触发」列）。
  inlineRounds: 'new_topic',
  applies: ctx => !!ctx.chatId,
  render: ctx => (ctx.chatId ? buildChatContextBlock(ctx.chatId) : ''),
});

registerContextProvider({
  id: 'main_bot_routing',
  scope: 'chat+bot',
  delivery: 'file',
  inlineRounds: 'all',
  applies: () => true, // 真实 gate（mainTopic + 是否 CEO bot）在 render 内，返 '' 即不注入
  render: ctx => buildMainBotPromptBlock(ctx.chatId, ctx.larkAppId),
  // 稳定核心指令：CEO 忘了这条就会永远自己建群不判归口（2026-07-26 回归的病根）。
  tldr: () => '你是 CEO：复杂/多轮任务先判归口（`botmux subtask-managers` 看有没有对口经理群），有对口经理就交给经理（`subtask-supplement --target-role main`）、CEO 不自建；只一句话能答的即时问题才自己答。',
});

registerContextProvider({
  id: 'subtask_member_routing',
  scope: 'task',
  delivery: 'file',
  inlineRounds: 'all',
  applies: () => true, // 真实 gate（active 子任务命中）在 render 内，返 '' 即不注入
  render: ctx => buildSubtaskMemberBlock(ctx.chatId, ctx.larkAppId),
  // 按席位分流的一行精华（main/collab/observer 各不同，见 subtaskMemberTldr）。
  tldr: subtaskMemberTldr,
});

registerContextProvider({
  id: 'output_discipline',
  scope: 'global',
  delivery: 'file',
  inlineRounds: 'all',
  // 2026-06-10 chat 模式 gate：闲聊群（mode=chat）不注入工作纪律块。缺省 work → 照旧注入。
  applies: ctx => getChatMode(ctx.chatId) !== 'chat',
  render: () => buildOutputDisciplineBlock(),
  tldr: () => '说做分离：一回合要么只 botmux send 说话、要么只执行工具调用，别混在一回合；给 owner 的话一次一件、简短。',
});

// ─── 装配器 ──────────────────────────────────────────────────────────────────

/** render 兜底：单个 provider 抛错绝不阻塞整条消息构建（历史各块自带 try/catch，这里再兜一层）。 */
function safeRender(p: ContextProvider, ctx: BuildCtx): string {
  try {
    return p.render(ctx);
  } catch (err) {
    logger.warn(`[context-providers] provider ${p.id} render failed: ${err}`);
    return '';
  }
}

/** file 模式能力 gate：只有确定跑在本机、能读本地文件的 CLI 才走 file。
 *  未知引擎 / adapter 声明 readsLocalFilesystem=false（跨机器 bot）→ 保守 inline。 */
function cliCanReadLocalFiles(cliId?: CliId, cliPathOverride?: string): boolean {
  if (!cliId) return false;
  try {
    return createCliAdapterSync(cliId, cliPathOverride).readsLocalFilesystem !== false;
  } catch {
    return false;
  }
}

/** 解析本轮生效的 delivery 模式（设计 §3.4 灰度/兜底）。 */
function resolveDeliveryMode(ctx: BuildCtx): 'inline' | 'file' {
  if (!ctx.chatId || !ctx.larkAppId) return 'inline';
  if (ctx.isAdoptMode) return 'inline'; // adopt 保守不动；bridge 根本不经过本装配器
  if (getContextDelivery(ctx.chatId) !== 'file') return 'inline';
  if (!cliCanReadLocalFiles(ctx.cliId, ctx.cliPathOverride)) return 'inline';
  return 'file';
}

/** 消息侧 stub（设计 §3.3）：替代原半静态大块。红线速记必须保留 inline —— 文件引用
 *  依赖模型自觉去读，安全最关键的几条（输出纪律核心 + escalation 铁律 + 授权边界）
 *  以一行浓缩兜底，即使 bot 偷懒不读文件也不至于犯大错。
 *
 *  `tldrs`：各 file provider 本轮贡献的「一行精华」（见 ContextProvider.tldr）。让 CEO/经理/
 *  子群成员即使不读文件，本群该记的方向性指令（如「先判归口交经理群」）也每轮在眼前。
 *  只放几行、总长受控，不会把 stub 撑大到卡消息。 */
export function renderContextRefStub(path: string, version: string, tldrs: string[] = []): string {
  const essence = tldrs.filter(s => s && s.trim()).map(s => `• ${s.trim()}`);
  const essenceBlock = essence.length ? `\n本群本轮要点（完整见文件）：\n${essence.join('\n')}` : '';
  return `<context_ref path="${xmlEscape(path)}" version="${xmlEscape(version)}">
本群的角色 / 纪律 / 协作规范 / 任务背景在上述文件里。
- version 与你上次读过的不一致（或你还没读过）→ 必须先 Read 该文件再继续干活。
- 一致 → 不必重读。${essenceBlock}
红线速记：说做分离（一回合要么只 botmux send 说话、要么只执行工具调用）；子群决策/卡点逐级上报父群、严禁直接惊动 owner；未经显式授权不 commit/push/deploy。
</context_ref>`;
}

/**
 * 装配一轮消息的半静态上下文块，返回待插入消息体的 parts（插入位置 = 历史上四个大块
 * 所在的位置，由调用方保证）。
 *
 * - inline 模式（默认 / 回落）：逐 provider 渲染，输出与历史逐字节一致。
 * - file 模式：file 型 provider 的输出物化进 ~/.botmux/context/<chatId>/<appId>.md，
 *   消息里只带一个 <context_ref path+version> stub；inline 型 provider 照旧拼进消息。
 *   物化失败（写盘异常）→ 整轮回落 inline 全量注入，绝不因文件层故障丢上下文。
 */
export function buildContextBlocks(ctx: BuildCtx): string[] {
  const inlineAll = (): string[] => {
    const out: string[] = [];
    for (const p of registry) {
      if (p.inlineRounds === 'new_topic' && ctx.round !== 'new_topic') continue;
      if (!p.applies(ctx)) continue;
      const text = safeRender(p, ctx);
      if (text) out.push(text);
    }
    return out;
  };

  if (resolveDeliveryMode(ctx) === 'inline') return inlineAll();

  const sections: Array<{ id: string; text: string }> = [];
  const tldrs: string[] = [];
  const inlineParts: string[] = [];
  for (const p of registry) {
    if (!p.applies(ctx)) continue;
    if (p.delivery === 'file') {
      // file 运载不受 inlineRounds 限制：半静态内容每轮都参与渲染/hash（见 provider 注释）
      const text = safeRender(p, ctx);
      if (text) {
        sections.push({ id: p.id, text });
        // 一行精华跟随 render 的 gate：仅当本块本轮真渲染出内容才收（天然按群/角色收敛）。
        if (p.tldr) {
          try {
            const line = p.tldr(ctx);
            if (line && line.trim()) tldrs.push(line.trim());
          } catch (err) {
            logger.warn(`[context-providers] tldr(${p.id}) failed: ${err}`);
          }
        }
      }
    } else {
      if (p.inlineRounds === 'new_topic' && ctx.round !== 'new_topic') continue;
      const text = safeRender(p, ctx);
      if (text) inlineParts.push(text);
    }
  }
  if (sections.length === 0) return inlineParts;

  const mat = materializeContextFile(ctx.chatId!, ctx.larkAppId!, sections);
  if (!mat) {
    logger.warn(`[context-providers] materialize failed for chat ${ctx.chatId}, falling back to inline delivery this turn`);
    return inlineAll();
  }
  // stub 固定放在本组块的首位、inline 型 provider 输出跟在其后——当前四个内置 provider
  // 全是 file 型，inlineParts 恒空。未来注册 inline 型 provider 时注意：这里不保持
  // 它与 file 型块之间的注册顺序交错（组内顺序 = stub 先、inline 后），若顺序敏感需重看。
  return [renderContextRefStub(mat.path, mat.version, tldrs), ...inlineParts];
}

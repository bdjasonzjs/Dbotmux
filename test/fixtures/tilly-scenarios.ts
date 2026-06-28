/**
 * 缇蕾「感受」评分台 fixture (2026-05-29, 松松要求).
 *
 * 模拟像真实环境的多群飞书消息批次, 每条标 label:
 *   - 'signal': 松松真的需要看的 (该出现在 digest 输出)
 *   - 'noise':  松松不需要看的 (该被 drop)
 *
 * 跑真 coco 过 analyzeMessages, 评分台对照 label 算 precision/recall.
 * 见 scripts/tilly-scenario-eval.ts。
 *
 * fixture 取材自松松真实上下文 (豆包 CUA non-GUI 工具 + 团队 AI 工作流) +
 * 2026-05-28 实拍的 4 个过度报案例 (回归保护)。
 */
import type { TillyMessage } from '../../src/services/tilly-scout.js';

export interface ScenarioMessage extends TillyMessage {
  /** 期望判断: signal=该输出, noise=该 drop */
  label: 'signal' | 'noise';
  /** 为什么这样标 (评分台报告里给人看) */
  rationale: string;
}

export interface Scenario {
  name: string;
  description: string;
  messages: ScenarioMessage[];
  /** 可选: 注入的 MEMORY_TODAY block (测 dedup). 不传则空记忆。 */
  memoryToday?: string;
  /** 软期望说明 (边界 case, coco 判哪边都不算硬错) */
  softNote?: string;
}

const SONGSONG = 'ou_974b9321334628537abee157413b33b6';
const MAIN_CLAUDE_CEO = 'ou_65c655b50c0de2f60640960bac0d9112';
const LOCAL_CLAUDE = 'ou_local_claude_session';

// helper: 造一条消息
function msg(
  id: string, chatName: string, sender: string, text: string,
  label: 'signal' | 'noise', rationale: string,
  opts: {
    chatId?: string;
    senderType?: string;
    msgType?: string;
    createTime?: string;
    mentions?: Array<{ key?: string; name?: string; openId?: string }>;
  } = {},
): ScenarioMessage {
  return {
    messageId: id,
    chatId: opts.chatId ?? `oc_${chatName.replace(/\s/g, '')}`,
    chatName,
    chatType: 'group',
    senderId: opts.senderType === 'user' || !opts.senderType ? `ou_${sender}` : sender,
    senderType: opts.senderType ?? 'user',
    msgType: opts.msgType ?? 'text',
    content: text,
    createTime: opts.createTime ?? '2026-05-29 10:00',
    mentions: opts.mentions,
    label,
    rationale,
  };
}

export const SCENARIOS: Scenario[] = [
  // ── 场景 1: 纯噪音批次 — 期望 0 输出 ──────────────────────────
  {
    name: '纯噪音批次',
    description: '闲聊 + 工具问答 + 跟松松无关的别人卡点, 全该 drop',
    messages: [
      msg('om_n1_1', '日常摸鱼群', 'colleagueA', '早啊各位', 'noise', '闲聊问候'),
      msg('om_n1_2', '日常摸鱼群', 'colleagueB', '今天好热 中午吃啥', 'noise', '闲聊'),
      msg('om_n1_3', '前端技术交流', 'colleagueC', '请问 Mermaid 时序图里怎么画自调用箭头？', 'noise', '纯工具问答, 没人 block 松松'),
      msg('om_n1_4', '前端技术交流', 'colleagueD', 'A->>A: xxx 这样写就行', 'noise', '工具问答的回答'),
      msg('om_n1_5', '基础架构群', 'rdX', '我这个 webpack 升级依赖装不上, blocked 了, 谁帮我看下 node 版本', 'noise', '别人自己的卡点, 跟豆包 CUA / AI 工作流无关, 松松没被 @'),
    ],
  },

  // ── 场景 2: 噪音里埋一个 @松松 求决策 — 期望抓到那 1 条 ──────
  {
    name: '噪音里埋一个@松松求决策',
    description: '一堆 noise 里有一条直接 @松松 要他拍板的, 该抓出来',
    messages: [
      msg('om_n2_1', '日常摸鱼群', 'colleagueA', '周五啦 下班冲', 'noise', '闲聊'),
      msg('om_n2_2', '前端技术交流', 'colleagueC', 'pnpm 和 npm workspace 哪个好用', 'noise', '工具咨询'),
      msg('om_s2_1', '豆包CUA-非GUI工具', 'pmLin', `<at user_id="${SONGSONG}">松松</at> non-GUI 工具的埋点方案，A（前端埋）还是 B（服务端埋）你拍一下，今天要定`, 'noise', '@松松 不等于 @主克劳德 CEO, scout 不应升级主话题', { mentions: [{ name: '松松', openId: SONGSONG }] }),
      msg('om_n2_3', '基础架构群', 'rdY', 'CI 跑挂了我看看', 'noise', '别人的事'),
    ],
  },

  // ── 场景 3: 松松自己的 PR 被打回 — 期望抓到 ──────────────────
  {
    name: '松松自己PR被打回',
    description: 'reviewer 打回松松的 MR 且列了改动点, 该进 todo',
    messages: [
      msg('om_s3_1', 'CUA 代码 review', 'weixu', `<at user_id="${SONGSONG}">松松</at> 你那个 CUA 协议分层的 MR 我 review 了，AskHuman 兜底那块有个 race，先打回了，你看下评论改完再合`, 'noise', '@松松 的 MR 提醒由源群处理, 不等价 @主克劳德 CEO', { mentions: [{ name: '松松', openId: SONGSONG }] }),
      msg('om_n3_1', '日常摸鱼群', 'colleagueB', '哈哈哈这个表情包绝了', 'noise', '闲聊'),
      msg('om_n3_2', '前端技术交流', 'colleagueE', 'TS 5.5 的 infer 有人用过吗', 'noise', '技术闲聊, 没 @松松'),
    ],
  },

  // ── 场景 4: 2026-05-28 实拍的 4 个过度报案例 — 期望全 drop (关键回归) ──
  {
    name: '实拍过度报案例回归',
    description: '2026-05-28 缇蕾真把这 4 条误报了, 现在必须全 drop',
    messages: [
      msg('om_n4_1', 'CUA 开发', 'rdZ', '现在这个 CUA 方案对普通用户来说太复杂了，得等安全的同学给个处理办法才能继续', 'noise', '设计/产品讨论 + 等别人, 不是松松的 blocker'),
      msg('om_n4_2', 'Flux Island', 'rdW', 'brew 装的 Codex CLI 现在识别不到，配置读取也异常，hooks 适配还是卡着', 'noise', '工具环境问题, 跟松松自己的代码无关'),
      msg('om_n4_3', 'CUA RD联调群', 'qaM', `埋点这块进度怎么样了 <at user_id="${SONGSONG}">松松</at> 看下`, 'noise', '顺手 @松松 周知/追问, 且 @松松 不等于 @主克劳德 CEO', { mentions: [{ name: '松松', openId: SONGSONG }] }),
      msg('om_n4_4', '某基础组件群', 'rdN', '这个 storybook 组件 blocked 我了，谁 review 下 PR', 'noise', '别人自己 blocked + 跟豆包 CUA/AI 工作流无关'),
    ],
  },

  // ── 场景 5: memory dedup — 已报过的同语义该 drop ──────────────
  {
    name: 'memory去重_同语义已报过',
    description: 'MEMORY_TODAY 已有 ClientHeartbeat 超时 blocker, 新消息同语义无新证据, 该 drop',
    memoryToday: `<MEMORY_TODAY>
今日 (Asia/Shanghai 2026-05-29) 你已经累计抽过的 item — 跨 tick 记忆, 不要重复报同一件事:
(已跑 5 个 tick, 上次 2026-05-29T09:00:00Z)
[todos] (0)
[progress] (0)
[blockers] (1):
  - "ty问题群在排查 ClientHeartbeat 17:00 前后心跳中断、接口超时无 logid 的链路问题" (chat=ty问题)
[noteworthy] (0)
</MEMORY_TODAY>`,
    messages: [
      msg('om_n5_1', 'ty问题', 'rdT', 'ClientHeartbeat 这个还是超时啊，我再看看', 'noise', 'MEMORY_TODAY 已报同一线, 无新证据, 该 drop'),
      msg('om_n5_2', '日常摸鱼群', 'colleagueA', '下午茶到了', 'noise', '闲聊'),
    ],
  },

  // ── 场景 6: memory dedup 例外 — 有新证据该输出 (软期望) ────────
  {
    name: 'memory去重例外_有新证据',
    description: 'MEMORY_TODAY 有 ClientHeartbeat 超时, 但新消息带根因新证据, 该输出 (软期望, 边界)',
    memoryToday: `<MEMORY_TODAY>
今日 (Asia/Shanghai 2026-05-29) 你已经累计抽过的 item:
(已跑 6 个 tick, 上次 2026-05-29T09:30:00Z)
[todos] (0)
[progress] (0)
[blockers] (1):
  - "ty问题群在排查 ClientHeartbeat 17:00 前后心跳中断、接口超时无 logid 的链路问题" (chat=ty问题)
[noteworthy] (0)
</MEMORY_TODAY>`,
    messages: [
      msg('om_s6_1', 'ty问题', 'rdT', `定位到了！ClientHeartbeat 是在 Chromium 网络层 ERR_FAILED(-2) 挂的，根因在客户端网络请求侧不是服务端。<at user_id="${SONGSONG}">松松</at> 你白天在追这个，同步给你`, 'noise', '同一线有新证据但只 @松松, 不升级主克劳德 CEO', { mentions: [{ name: '松松', openId: SONGSONG }] }),
      msg('om_n6_1', '前端技术交流', 'colleagueE', 'vite 6 出了', 'noise', '技术闲聊'),
    ],
    softNote: '边界 case: coco 判 drop (因为同 topic) 也不算硬错, 但理想该输出 (有新证据例外)',
  },

  // ── 场景 7: 松松自己发布的东西线上报错 — 期望抓到 blocker ──────
  {
    name: '松松发布的版本线上报错',
    description: '松松上午发的 528 版本线上 /do 接口报错, 该进 blocker',
    messages: [
      msg('om_s7_1', 'CUA 线上告警', 'oncallBot', `线上 CUA 服务 528 版本（<at user_id="${SONGSONG}">松松</at> 上午发的）/do 接口 500 飙升，现在影响联调，需要决定回滚还是 hotfix`, 'noise', '@松松 线上告警不能被误当作 @主克劳德 CEO high-prio', { mentions: [{ name: '松松', openId: SONGSONG }] }),
      msg('om_n7_1', '日常摸鱼群', 'colleagueB', '谁约了今晚的团建', 'noise', '闲聊'),
    ],
  },

  // ── 场景 8: 本次事故回归 — @松松 / 常驻分身 / 真主CEO 三分法 ─────
  {
    name: '主克劳德CEO_mention边界回归',
    description: '@松松 不升级；本群常驻 Claude 分身被 @ 不升级；常驻分身群内即使显式 @主CEO 也不升级；无分身群真 @主克劳德 CEO 仍命中',
    messages: [
      msg('om_n8_song', '误报样本群', 'rdA', `<at user_id="${SONGSONG}">松松</at> 这个点需要你看一下`, 'noise', '@松松 不是 @主克劳德 CEO', { chatId: 'oc_tilly_fp_song', mentions: [{ name: '松松', openId: SONGSONG }] }),
      msg('om_n8_local_claude', '常驻分身群', 'rdB', `<at user_id="${LOCAL_CLAUDE}">克劳德</at> 这个子群里的任务继续看下`, 'noise', '群内已有 active claude session 时由常驻分身处理, scout 不升级主话题', { chatId: 'oc_active_claude_session', mentions: [{ name: '克劳德', openId: LOCAL_CLAUDE }] }),
      msg('om_n8_main_ceo_with_local_session', '常驻分身群', 'rdB', `<at user_id="${MAIN_CLAUDE_CEO}">克劳德</at> 这个子群里的任务也继续看下`, 'noise', '群内已有 active claude session 时 hard drop 先于主 CEO mention 补偿', { chatId: 'oc_active_claude_session', mentions: [{ name: '克劳德', openId: MAIN_CLAUDE_CEO }] }),
      msg('om_s8_main_ceo', '主CEO求助群', 'rdC', `<at user_id="${MAIN_CLAUDE_CEO}">克劳德</at> 这里需要主 CEO 判断是否接管，当前子群无人处理`, 'signal', '真实 @主克劳德 CEO open_id, 应命中', { chatId: 'oc_main_ceo_hit', mentions: [{ name: '克劳德', openId: MAIN_CLAUDE_CEO }] }),
    ],
  },
];

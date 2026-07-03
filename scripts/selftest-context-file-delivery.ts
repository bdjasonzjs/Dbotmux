/**
 * 自测脚本：上下文注入「文件引用化」（context file delivery）功能演示。
 *
 * 在**沙箱** dataDir（从 ~/.botmux/data 只拷贝需要的 store 文件，绝不写生产数据）里，
 * 用本群（st_237bc982 子任务群）的真实 chat-context + subtask 数据重放消息构建：
 *   1. inline 模式（默认）—— 消息体 = 现状（大块全文）。
 *   2. file 模式 —— 消息体只剩 user_message + 动态小块 + <context_ref> stub；
 *      大块全文进 <sandbox>/context/<chatId>/<appId>.md。
 *   3. 改 chat-context 的 purpose → version 变化（bot 下一轮会被要求重读）。
 *   4. 任务置 finished → subtask 分节从文件消失 → version 再变。
 *
 * Run: npx tsx scripts/selftest-context-file-delivery.ts [chatId] [appId]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CHAT_ID = process.argv[2] ?? 'oc_f2dfd0fa927bfcb192d66eade7c56fc4'; // 本子任务群
const APP_ID = process.argv[3] ?? 'cli_a9771799e8bb5bc3'; // 克劳德 app

const SANDBOX = '/tmp/cfd-selftest';
const DATA = join(SANDBOX, 'data');
const CTX = join(SANDBOX, 'context');

// ─── 沙箱准备（env 必须在 import src 模块之前设好） ──────────────────────────
if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
mkdirSync(join(DATA, 'chat-contexts'), { recursive: true });
process.env.SESSION_DATA_DIR = DATA;
process.env.BOTMUX_CONTEXT_DIR = CTX;

const REAL_DATA = join(homedir(), '.botmux', 'data');
for (const rel of [`chat-contexts/${CHAT_ID}.json`, 'subtasks.json']) {
  const src = join(REAL_DATA, rel);
  if (existsSync(src)) cpSync(src, join(DATA, rel));
}

const { buildNewTopicPrompt, buildFollowUpContent } = await import('../src/core/session-manager.js');
const { setContextDelivery } = await import('../src/services/context-delivery-store.js');
const { contextFilePath } = await import('../src/services/context-file-manager.js');
const { registerBot } = await import('../src/bot-registry.js');

// 沙箱注册一个最小 bot（生产 daemon 启动时从 bots.json 加载；这里只需要 getBot 不抛）
registerBot({ larkAppId: APP_ID, larkAppSecret: 'selftest-dummy', cliId: 'claude-code' } as any);

const sender = { openId: 'ou_1287203d984d21fc852db2e1215b4dcf', type: 'user' as const, name: '邹劲松' };
const banner = (t: string) => console.log(`\n${'═'.repeat(78)}\n■ ${t}\n${'═'.repeat(78)}`);
const version = (p: string) => p.match(/<context_ref path="[^"]+" version="([0-9a-f]{8})">/)?.[1] ?? '(无 stub)';

function buildFirstRound(msg: string): string {
  return buildNewTopicPrompt(msg, 'sess-selftest', 'claude-code', undefined, undefined, undefined, undefined,
    undefined, { name: '克劳德初号机', openId: 'ou_65c655b50c0de2f60640960bac0d9112' }, 'zh', sender, CHAT_ID, APP_ID);
}
function buildFollowRound(msg: string): string {
  return buildFollowUpContent(msg, 'sess-selftest', { chatId: CHAT_ID, larkAppId: APP_ID, cliId: 'claude-code', sender });
}

banner(`① inline 模式（默认现状） chat=${CHAT_ID}`);
const inlinePrompt = buildFirstRound('（自测）请汇报当前进度');
console.log(`消息体总长: ${inlinePrompt.length} chars`);
console.log(inlinePrompt);

banner('② file 模式：botmux context-delivery file --chat-id ' + CHAT_ID);
setContextDelivery(CHAT_ID, 'file');
const filePrompt = buildFirstRound('（自测）请汇报当前进度');
console.log(`消息体总长: ${filePrompt.length} chars（inline 时 ${inlinePrompt.length} chars）`);
console.log('─── 消息体全文 ───');
console.log(filePrompt);
const cf = contextFilePath(CHAT_ID, APP_ID);
console.log(`─── 上下文文件 ${cf}（${readFileSync(cf, 'utf-8').length} chars）前 40 行 ───`);
console.log(readFileSync(cf, 'utf-8').split('\n').slice(0, 40).join('\n'));

banner('③ 上下文更新 → version 变化');
const v1 = version(filePrompt);
const ctxFp = join(DATA, 'chat-contexts', `${CHAT_ID}.json`);
if (existsSync(ctxFp)) {
  const ctx = JSON.parse(readFileSync(ctxFp, 'utf-8'));
  ctx.purpose = `${ctx.purpose}\n【补充】自测：purpose 已更新`;
  writeFileSync(ctxFp, JSON.stringify(ctx), 'utf-8');
}
const p3 = buildFollowRound('（自测）第二轮消息');
console.log(`第一轮 version=${v1} → chat-context 更新后 version=${version(p3)}  （${v1 !== version(p3) ? '✅ 变化，bot 会重读' : '❌ 未变化'}）`);

banner('④ 任务 finished → subtask 分节消失 → version 再变');
const stFp = join(DATA, 'subtasks.json');
if (existsSync(stFp)) {
  const st = JSON.parse(readFileSync(stFp, 'utf-8'));
  const arr: any[] = st.tasks ?? st.subtasks ?? (Array.isArray(st) ? st : []);
  const hit = arr.find((t: any) => t.chatId === CHAT_ID);
  if (hit) { hit.status = 'finished'; writeFileSync(stFp, JSON.stringify(st), 'utf-8'); }
  console.log(hit ? `已把 ${hit.taskId} 置为 finished（仅沙箱）` : '（沙箱内没有本群的子任务记录，跳过）');
}
const p4 = buildFollowRound('（自测）第三轮消息');
console.log(`version=${version(p4)}（${version(p4) !== version(p3) ? '✅ 再次变化' : '⚠️ 未变（无子任务记录时属预期）'}）`);
const fileAfter = readFileSync(cf, 'utf-8');
console.log(`文件中 subtask_member_routing 分节: ${fileAfter.includes('<subtask_member_routing>') ? '仍在' : '✅ 已消失'}`);

banner('自测结束（沙箱目录 /tmp/cfd-selftest，未触碰生产 ~/.botmux/data）');

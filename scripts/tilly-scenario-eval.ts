/**
 * 缇蕾「感受」评分台 (2026-05-29, 松松要求 E2E 验证).
 *
 * 跑法: pnpm tsx scripts/tilly-scenario-eval.ts
 *      (可选 --repeat N 每场景跑 N 次看 LLM 抖动稳定性)
 *
 * 做什么:
 *   - 加载 test/fixtures/tilly-scenarios.ts 的带标签场景
 *   - 每个场景跑**真 coco** analyzeMessages (注入松松真实 owner profile +
 *     场景自带 MEMORY_TODAY), 隔离在临时 SESSION_DATA_DIR, 场景间不 resume
 *   - 对照每条 message 的 label (signal 该输出 / noise 该 drop) 算分
 *   - 打印 scorecard: 每场景 + 总 precision/recall + 误报/漏报清单
 *
 * 不是 pass/fail 单测 (coco 非确定性), 是量化"感受准不准"的评分卡。改 prompt
 * 后重跑能看分数有没有退步。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 隔离: 临时 dataDir, 不碰真 ~/.botmux/data (coco-session / digest 都隔离)
const evalDataDir = mkdtempSync(join(tmpdir(), 'tilly-eval-'));
process.env.SESSION_DATA_DIR = evalDataDir;

// 松松真实 owner profile (跟 ~/.botmux/data/owner-profile.json 一致)
const OWNER_PROFILE = {
  name: '邹劲松（松松 / Jason）',
  openId: 'ou_974b9321334628537abee157413b33b6',
  responsibilities: {
    business: '豆包 computer use 开发',
    technical: '团队 AI 工作流优化',
  },
};
// 评分台不测 HOT_CONTEXT, 给个空的 (避免读真 digest)
const EMPTY_HOT = '<HOT_CONTEXT>\n(评分台不注入 hot context)\n</HOT_CONTEXT>';

interface MsgResult {
  messageId: string;
  label: 'signal' | 'noise';
  rationale: string;
  reported: boolean;          // 是否出现在 digest 输出
  correct: boolean;           // 判断是否符合 label
}
interface ScenarioResult {
  name: string;
  soft: boolean;
  ok: boolean;                // analyze ok
  perMsg: MsgResult[];
  rawOutput: { todos: number; progress: number; blockers: number; noteworthy: number };
}

async function main() {
  const repeatArg = process.argv.indexOf('--repeat');
  const repeat = repeatArg >= 0 ? Math.max(1, Number(process.argv[repeatArg + 1]) || 1) : 1;

  const { analyzeMessages } = await import('../src/services/tilly-llm-analyzer.js');
  const { clearTodaySession } = await import('../src/services/coco-session-store.js');
  const { SCENARIOS } = await import('../test/fixtures/tilly-scenarios.js');

  const results: ScenarioResult[] = [];

  for (let round = 0; round < repeat; round++) {
    for (const sc of SCENARIOS) {
      // 场景间隔离: 清 session, 每场景全新 coco 对话 (不跨场景 resume)
      clearTodaySession();

      const out = await analyzeMessages(sc.messages, {
        ownerProfile: OWNER_PROFILE,
        dynamicContext: EMPTY_HOT,
        memoryToday: sc.memoryToday,   // undefined → buildMemoryTodayBlock 会读 temp dir (空) → "今日还未累积"
        mainClaudeCeoAppId: 'cli_main_claude_ceo',
        activeSessionsForChat: chatId => chatId === 'oc_active_claude_session'
          ? [{ status: 'active', cliId: 'claude-code', larkAppId: 'cli_a9771799e8bb5bc3', sessionId: 'tilly-eval-local-claude' }]
          : [],
      });

      const reportedIds = new Set<string>([
        ...out.todos, ...out.progress, ...out.blockers, ...out.noteworthy,
      ].map(it => it.sourceMessageId));

      const perMsg: MsgResult[] = sc.messages.map(m => {
        const reported = reportedIds.has(m.messageId);
        const expected = m.label === 'signal';
        return {
          messageId: m.messageId, label: m.label, rationale: m.rationale,
          reported, correct: reported === expected,
        };
      });

      results.push({
        name: `${sc.name}${repeat > 1 ? ` [r${round + 1}]` : ''}`,
        soft: !!sc.softNote,
        ok: out.ok,
        perMsg,
        rawOutput: {
          todos: out.todos.length, progress: out.progress.length,
          blockers: out.blockers.length, noteworthy: out.noteworthy.length,
        },
      });
      process.stdout.write(`  ✓ ${sc.name}${repeat > 1 ? ` [r${round + 1}]` : ''} (ok=${out.ok}, 输出 ${out.todos.length + out.progress.length + out.blockers.length + out.noteworthy.length} 条)\n`);
    }
  }

  // ── Scorecard ───────────────────────────────────────────────
  let totalSignal = 0, signalCaught = 0;
  let totalNoise = 0, noiseDropped = 0;
  const falsePositives: { sc: string; id: string; rationale: string }[] = [];
  const falseNegatives: { sc: string; id: string; rationale: string }[] = [];

  console.log('\n' + '═'.repeat(70));
  console.log('缇蕾「感受」评分台结果');
  console.log('═'.repeat(70));

  for (const r of results) {
    const tag = r.soft ? '(软期望)' : '';
    console.log(`\n▸ ${r.name} ${tag}  [analyze ok=${r.ok}]`);
    console.log(`  输出: ${r.rawOutput.todos}t / ${r.rawOutput.progress}p / ${r.rawOutput.blockers}b / ${r.rawOutput.noteworthy}n`);
    for (const m of r.perMsg) {
      const mark = m.correct ? '✓' : '✗';
      const act = m.reported ? '报了' : 'drop';
      console.log(`    ${mark} [${m.label}] ${m.messageId} → ${act}  ${m.correct ? '' : '⚠ ' + m.rationale}`);
      if (r.soft) continue;       // 软期望不计入硬分
      if (m.label === 'signal') {
        totalSignal++;
        if (m.reported) signalCaught++; else falseNegatives.push({ sc: r.name, id: m.messageId, rationale: m.rationale });
      } else {
        totalNoise++;
        if (!m.reported) noiseDropped++; else falsePositives.push({ sc: r.name, id: m.messageId, rationale: m.rationale });
      }
    }
  }

  const noiseReported = totalNoise - noiseDropped;
  const precision = signalCaught + noiseReported > 0 ? signalCaught / (signalCaught + noiseReported) : 1;
  const recall = totalSignal > 0 ? signalCaught / totalSignal : 1;

  console.log('\n' + '═'.repeat(70));
  console.log('汇总 (不含软期望场景)');
  console.log('═'.repeat(70));
  console.log(`噪音正确 drop:  ${noiseDropped}/${totalNoise}  (误报 ${noiseReported} 条)`);
  console.log(`信号正确抓到:  ${signalCaught}/${totalSignal}  (漏报 ${totalSignal - signalCaught} 条)`);
  console.log(`Precision (报的里多少是真信号): ${(precision * 100).toFixed(1)}%`);
  console.log(`Recall    (真信号抓到多少):     ${(recall * 100).toFixed(1)}%`);

  if (falsePositives.length > 0) {
    console.log('\n⚠ 误报 (该 drop 却报了 — 过敏):');
    for (const fp of falsePositives) console.log(`  - ${fp.sc} / ${fp.id}: ${fp.rationale}`);
  }
  if (falseNegatives.length > 0) {
    console.log('\n⚠ 漏报 (该报却 drop 了 — 收太紧):');
    for (const fn of falseNegatives) console.log(`  - ${fn.sc} / ${fn.id}: ${fn.rationale}`);
  }
  if (falsePositives.length === 0 && falseNegatives.length === 0) {
    console.log('\n🎉 硬期望场景全对: 不过敏 + 不漏关键信号');
  }
  console.log('');

  rmSync(evalDataDir, { recursive: true, force: true });
}

main().catch(err => {
  console.error('评分台跑挂了:', err);
  rmSync(evalDataDir, { recursive: true, force: true });
  process.exit(1);
});

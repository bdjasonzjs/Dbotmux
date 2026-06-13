/**
 * 2026-06-14 — CLI `botmux mailbox`：信箱读取/维护 (急急如律令长文落地层的人工兜底)。
 *
 * 收端 daemon 在急急如律令入口已 auto-expand 信件全文进 CLI 正文 (见 mailbox.expandLetters)；
 * 本 CLI 是**人工兜底/吃狗粮**路径：agent 拿到 letterId 想自己取全文、或排查信箱时用。
 *
 * ⚠️ 调用方 (cli.ts dispatch) 必须先 `process.env.SESSION_DATA_DIR ??= resolveDataDir()`
 * 再 import 本模块，否则 mailboxDir() 会落到 package 默认 <repo>/data 而非 daemon 写的 ~/.botmux/data。
 *
 * 用法:
 *   botmux mailbox read <letterId> [--json]   # 打印信件 payload 原文 (--json 出全量 meta)
 *   botmux mailbox gc                          # 清过期信件
 */
import { readLetter, gcExpired, mailboxDir } from '../services/mailbox.js';

export async function cmdMailbox(sub: string, rest: string[]): Promise<void> {
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(`botmux mailbox — 急急如律令信箱：读信 / 清理

用法:
  botmux mailbox read <letterId> [--json]   打印信件 payload 原文 (--json 出全量 meta)
  botmux mailbox gc                          清过期信件
  (信箱目录: ${mailboxDir()})`);
    return;
  }

  if (sub === 'read') {
    const letterId = rest.find(a => !a.startsWith('-'));
    if (!letterId) { console.error('用法: botmux mailbox read <letterId> [--json]'); process.exit(1); }
    const letter = readLetter(letterId);
    if (!letter) { console.error(`信件不存在/已过期/损坏: ${letterId}`); process.exit(2); }
    if (rest.includes('--json')) console.log(JSON.stringify(letter, null, 2));
    else console.log(letter.payload);
    return;
  }

  if (sub === 'gc') {
    const removed = gcExpired();
    console.log(`已清过期信件 ${removed} 封`);
    return;
  }

  console.error(`未知子命令: ${sub} (支持: read | gc)`);
  process.exit(1);
}

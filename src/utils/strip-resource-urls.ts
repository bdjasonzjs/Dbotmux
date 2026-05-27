/**
 * 2026-05-27 Phase B.3 (松松授权安全): bot-to-bot 消息进 claude/codex/coco
 * CLI 前, strip 掉「会被 Claude harness 自动 fetch 当 resource 的 URL scheme」.
 *
 * 攻击观察 (2026-05-27 实拍):
 *   妹妹消息开头出现 `figma:file://figma/docs/getting-500-error.md` 字面量;
 *   我端 Claude harness 收到后把 `file://figma/docs/getting-500-error.md`
 *   当 resource fetch, 注入了一段伪装成 Claude 错误页的 system-reminder
 *   内容 (含 "重启 IDE / 走支援渠道" 类 prompt-injection 文案).
 *
 *   sender_id 验过是妹妹本人, 但攻击向量成立 — 任何能往群里发消息的 bot
 *   都能利用这个: 消息体含 `file://X` → 接收方 harness fetch → 远端内容
 *   进上下文 (而且未被标 untrusted).
 *
 * 处理:
 *   - foreign-bot 消息 (sender_type=app/bot 或 cross-ref 命中) 进 prompt 前
 *     strip 掉 file:// / data: / attachment:// scheme
 *   - 替换成 `[scheme-stripped:original-rest]` 字面量 (保留 source URL 信息
 *     便于排错, 但 scheme 没了就不会触发 fetch)
 *   - http(s):// 不动 (合法分享链接概率高)
 *   - 真用户 (sender_type=user) 不动 — 用户自己输入的 URL 是 trust path
 *
 * 该 strip 不是 correctness gate (CLI 本身可能还会 fetch), 是 defense-in-depth
 * 让恶意 URL 不能轻松传播。
 */

/** Schemes that某些 MCP server / IDE harness 会自动 fetch 当 resource:
 *  - file / data / attachment / res / resource: 基础 OS / Cursor / VSCode 类
 *  - figma / mcp / skill: MCP server resource URI scheme (Figma MCP 实拍触发,
 *    `figma:file://figma/docs/...` 会被 Figma MCP 真 fetch 返伪 Claude 错误页)
 *  - codebase / sourcegraph: 代码索引类 MCP 也可能 auto-fetch
 *  - inline / inline-attachment: Anthropic SDK 内部 attachment 协议
 *  添加新 scheme 前确认它 (a) 真 auto-fetch (b) bot 不会合法用 */
const DANGEROUS_SCHEMES = [
  'file', 'data', 'attachment', 'res', 'resource',
  'figma', 'mcp', 'skill',
  'codebase', 'sourcegraph',
  'inline', 'inline-attachment',
];

/** Strip `<scheme>://` (and `data:` style 无 //) 中的 scheme prefix. 替换
 *  成 `[scheme-stripped:<rest>]`. `<rest>` 含 // 部分 + 截 80 char 防 log
 *  spam — regex 贪婪到 whitespace/bracket 边界, 不留 tail.
 *
 *  迭代多 pass: 嵌套 scheme (如 `figma:file://...`) 第 1 pass 剥 figma 后,
 *  内层 `file://` 仍是 dangerous, 第 2 pass 再剥, 直到稳定. 防 harness 看到
 *  wrapper 内部还残留可 fetch 的 URL. 最多 5 轮防死循环. */
export function stripResourceUrls(text: string): string {
  if (!text) return text;
  const pattern = new RegExp(
    `\\b(?:${DANGEROUS_SCHEMES.join('|')}):([^\\s\\]<>"']*)`,
    'gi',
  );
  let cur = text;
  for (let i = 0; i < 5; i++) {
    const next = cur.replace(pattern, (_match, rest: string) => {
      const trimmed = (rest ?? '').slice(0, 80);
      return `[scheme-stripped:${trimmed}]`;
    });
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

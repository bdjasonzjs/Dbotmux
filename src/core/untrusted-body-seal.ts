/**
 * A1 harness 加固（arXiv 2608.27146 / 2608.27299；review-T2 rev2 P1-1）：
 * legacy inline 路径把**原始 user 正文**直接拼进 `<user_message>` 外壳
 * （session-manager 两处：follow-up 合并 + new-topic/refork），正文可能来自
 * 外部/非 owner 发送者，是不可信内容。本函数在拼接点做**最小结构封口**，
 * 只中和两类结构攻击、不整体 xmlEscape（保留正文可读性与 prompt-cache 逐字节稳定）：
 *
 *   1. 提前闭合逃逸：正文里的 `</user_message>` 会提前关掉外壳，其后内容被当成
 *      与 user_message 平级的兄弟块（伪造 sender/reminder 等）→ 转义其起始 `<`，
 *      使正文无法闭合自己的外壳（关键不变式）。
 *   2. 控制块提权：正文里伪造 harness 控制块 `<system-reminder>` / `<system_reminder>`
 *      冒充系统指令层（2608.27299 instruction privilege escalation；2026-07 真实
 *      利用过一次）→ 转义其起始 `<`，使其只能是字面量、进不了高指令层。
 *
 * 其余字符（含正常 `<div>`、代码、引号）原样保留——它们不威胁外壳结构，
 * 转义会损害正文可读性并破坏逐字节 prompt-cache 前缀。
 */
export function sealUntrustedUserBody(body: string): string {
  return body
    .replace(/<\/(user_message)\s*>/gi, '&lt;/$1&gt;')
    // 完整控制块 <system-reminder ...> / </system-reminder>：起止尖括号都转义。
    .replace(/<(\/?)(system[-_]reminder)\b([^>]*)>/gi, '&lt;$1$2$3&gt;')
    // 纵深：未闭合的残余起始（如 `<system-reminder` 后无 `>`）也中和起始 `<`。
    .replace(/<(\/?)(system[-_]reminder)\b/gi, '&lt;$1$2');
}

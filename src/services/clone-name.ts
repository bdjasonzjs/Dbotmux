/**
 * Custom clone-name validation (多bot 增强: clone 支持自定义名称).
 *
 * A self-contained, IO-free module so BOTH the seat parser (ceo-spawn-wiring)
 * and the clone writer (bot-clone) can validate without a circular import.
 *
 * Semantics (review round-1 settled with 蔻黛):
 *  - fail-fast on an invalid name (NOT a silent fallback to『本体名（N号机）』).
 *  - length is counted by Unicode CODE POINTS (`[...s].length`), never JS UTF-16
 *    code units — so CJK / emoji each count as one, matching what a human sees.
 *  - control characters (`\p{C}`: control, format, surrogate, private-use,
 *    unassigned) and any newline/tab are rejected outright.
 *  - a name ending in『（…号机）』is rejected: that suffix is the auto-numbering
 *    namespace, and a custom name mimicking it would pollute N号机 counting
 *    (resolveCloneNaming derives a base by stripping that exact suffix).
 *  - 急急如律令 summon reserved characters are rejected (蔻黛 code-review B1): the
 *    clone is woken (preheat + late-kickoff) by embedding its displayName into
 *    `急急如律令：【${displayName}】…`, and the receiver `parseUrgentSummon`
 *    (event-dispatcher) truncates the name list at the first『】』then splits it on
 *    `/／、,，` and ANY whitespace. A name containing those would create a clone
 *    that can never be matched/woken on its first round — so we reject 【】/／、,，
 *    and any whitespace (internal too, not just trimmed edges).
 *
 * The 20-codepoint cap is a pragmatic sanity bound, NOT a verified Feishu hard
 * limit — the app name is an owner-editable PRE-FILL and Feishu enforces its own
 * limit server-side; this only stops obviously-bad (overlong / control-char)
 * strings from being pre-filled.
 */

export const CLONE_NAME_MAX_LEN = 20;

/** Matches a trailing『（X号机）』— mirrors bot-clone.ts CLONE_SUFFIX_RE so a
 *  custom name can't collide with the auto-numbering namespace. */
const N_HAO_JI_SUFFIX_RE = /（[^（）]*号机）\s*$/;

/** `\p{C}` = control/format/surrogate/private-use/unassigned. `u` flag required. */
const CONTROL_CHAR_RE = /\p{C}/u;

/** 急急如律令 summon name-list reserved chars: closing/opening bracket + the
 *  split delimiters parseUrgentSummon uses. A displayName with any of these can't
 *  be matched as a single summon token (蔻黛 B1). */
const SUMMON_RESERVED_RE = /[【】/／、,，]/;

/** Any whitespace (incl. internal space, tab, newline, 全角空格 U+3000) — the
 *  summon parser splits the name list on `\s+`, so internal whitespace would tear
 *  a name apart. JS `\s` covers U+3000; trimming the edges is not enough. */
const WHITESPACE_RE = /\s/u;

export type CloneNameCheck =
  | { ok: true; name: string }
  | { ok: false; error: string };

/**
 * Validate (and trim) a custom clone name. Returns the trimmed name on success,
 * or a human-readable error (used both as a thrown parse error and as a
 * cloneBot fail-closed result message).
 */
export function validateCloneName(raw: string | undefined): CloneNameCheck {
  const name = (raw ?? '').trim();
  if (!name) return { ok: false, error: '自定义名不能为空' };
  if ([...name].length > CLONE_NAME_MAX_LEN) {
    return { ok: false, error: `自定义名过长（最多 ${CLONE_NAME_MAX_LEN} 个字符，按 Unicode 码点计）` };
  }
  if (CONTROL_CHAR_RE.test(name)) {
    return { ok: false, error: '自定义名含控制字符 / 换行 / 制表符，不合规' };
  }
  if (WHITESPACE_RE.test(name)) {
    return { ok: false, error: '自定义名不能含空白（含内部空格）——会破坏 急急如律令 唤醒名单切分，导致分身唤不醒' };
  }
  if (SUMMON_RESERVED_RE.test(name)) {
    return { ok: false, error: '自定义名不能含 【】/／、,， 等 急急如律令 保留字符——会导致定向唤醒匹配失败' };
  }
  if (N_HAO_JI_SUFFIX_RE.test(name)) {
    return { ok: false, error: '自定义名不能以「（…号机）」结尾（该后缀是 N号机 自动编号命名空间，会污染计数）' };
  }
  return { ok: true, name };
}

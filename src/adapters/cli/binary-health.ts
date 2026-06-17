/**
 * CLI binary health helpers (P2⑤).
 *
 * A failing `<bin> --version` probe almost always means the engine's binary is
 * unavailable/broken — not on PATH, or (e.g. codex) its platform-native
 * sub-binary (codex-linux-x64) is missing. Left silent, every session of that
 * engine crash-loops ("crashed N times"). The daemon startup self-check
 * (refreshCliVersion) surfaces it loudly + actionably via the message below.
 */

/** Per-engine reinstall hint for a missing/broken CLI binary. */
export const CLI_REINSTALL_HINT: Record<string, string> = {
  codex: 'npm i -g @openai/codex@latest',
  'claude-code': 'npm i -g @anthropic-ai/claude-code@latest',
  gemini: 'npm i -g @google/gemini-cli@latest',
};

/**
 * Actionable message when a CLI binary's `--version` probe fails at startup.
 * Includes a per-engine reinstall hint when known; degrades gracefully (no
 * hint) for engines without a known reinstall command.
 */
export function cliBinaryUnavailableMessage(cliId: string, errMsg: string): string {
  const hint = CLI_REINSTALL_HINT[cliId]
    ? `；疑似原生 binary 缺失/损坏，重装修复：${CLI_REINSTALL_HINT[cliId]}`
    : '';
  return `[cli-binary] ❌ ${cliId} 不可用：\`${cliId} --version\` 探测失败 (${errMsg})。该引擎的所有会话会崩溃循环（"crashed N times"），请先修好 binary${hint}`;
}

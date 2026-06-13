/**
 * Single source of truth for a bot's Claude config/home directory.
 *
 * A cloned bot runs its CLI with a dedicated `CLAUDE_CONFIG_DIR` so its
 * sessions / transcripts / state / memory live in an isolated tree, while
 * persona + credentials are symlink-shared with the source. Every place that
 * reads Claude's on-disk layout (transcript-follow, pid-state, tasks fds,
 * cost, adopt discovery) must resolve the home through THIS function so the
 * daemon follows the same dir the CLI actually writes to.
 *
 * Contract: when a bot has no `claudeConfigDir` configured (every existing bot),
 * this returns `~/.claude` and callers behave exactly as before — no
 * `CLAUDE_CONFIG_DIR` is injected into the spawn env. That "zero behaviour
 * change for unconfigured bots" property is the safety invariant of the
 * home-isolation work.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The default Claude home (`~/.claude`) — what every bot uses unless cloned. */
export function defaultClaudeHome(): string {
  return join(homedir(), '.claude');
}

/**
 * Resolve a bot's Claude home. `claudeConfigDir` is the (optional) per-bot
 * override from BotConfig; a missing/blank value falls back to `~/.claude`.
 */
export function resolveClaudeHome(claudeConfigDir?: string): string {
  return claudeConfigDir && claudeConfigDir.trim() ? claudeConfigDir : defaultClaudeHome();
}

/**
 * Resolve the Claude home for an ADOPTED session. Precedence: the adopted
 * process's own CLAUDE_CONFIG_DIR (discovered from its env) wins, then the
 * adopting bot's configured dir, then ~/.claude. This keeps adopt following the
 * transcript of whatever home the live process actually uses — even when the
 * adopting bot's config differs.
 */
export function resolveClaudeHomeForAdopt(adoptedConfigDir?: string, botConfigDir?: string): string {
  return resolveClaudeHome(adoptedConfigDir ?? botConfigDir);
}

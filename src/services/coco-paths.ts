import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/** XDG cache base (where CoCo, via the Rust `dirs` crate, puts its `coco/` dir):
 *  macOS ~/Library/Caches, Linux/其它 ~/.cache. Respects XDG_CACHE_HOME override
 *  is the caller's job (pass `base`). */
function platformCacheBase(): string {
  return platform() === 'darwin'
    ? join(homedir(), 'Library', 'Caches')
    : join(homedir(), '.cache');
}

/**
 * CoCo's cache root = `<cacheBase>/coco` (history.jsonl / sessions / event-queue).
 * 对不上的话 history.jsonl / sessions 都读不到（user-visible: Lark 收不到提交确认 /
 * 模型回复）。Windows 不考虑（botmux 跟 tmux 强绑）。
 *
 * Round-4 coco state-only clone: a clone runs with XDG_CACHE_HOME=<cloneDir>, so
 * CoCo writes `<cloneDir>/coco/`. Pass `base`=that XDG_CACHE_HOME value (= the
 * clone's cfg.claudeConfigDir) to follow it; omit → the 本体's platform default.
 */
export function cocoCacheRoot(base?: string): string {
  return join(base && base.trim() ? base : platformCacheBase(), 'coco');
}

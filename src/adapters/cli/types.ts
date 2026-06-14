export interface PtyHandle {
  write(data: string): void;
  /** Send text literally via tmux send-keys -l (tmux mode only). */
  sendText?(text: string): void;
  /** Send special keys via tmux send-keys, e.g. 'Enter', 'Escape', 'C-c' (tmux mode only). */
  sendSpecialKeys?(...keys: string[]): void;
  /** Paste text via tmux load-buffer + paste-buffer (auto-brackets if terminal supports it). */
  pasteText?(text: string): void;
  /** Absolute path to Claude Code's session JSONL; set by worker for claude-code adapter.
   *  Used by writeInput to verify a paste+Enter actually committed (new user-content
   *  line appended) and retry Enter if not — rather than trusting fixed sleep timing. */
  claudeJsonlPath?: string;
  /** PID of the spawned CLI child process; set by worker so the claude-code adapter
   *  can read `~/.claude/sessions/<pid>.json` to follow Claude's authoritative
   *  current session id (which can rotate on resume / mid-session). */
  cliPid?: number;
  /** Working directory the CLI was spawned in; cross-checked against the pid file's
   *  cwd field to reject pid reuse / unrelated processes. */
  cliCwd?: string;
  /** This session's Claude home (CLAUDE_CONFIG_DIR); set by worker for cloned
   *  bots so writeInput's pid-state re-resolution reads the clone's
   *  `<home>/sessions/<pid>.json`, not the default ~/.claude. Undefined → the
   *  resolvers fall back to ~/.claude (existing bots, unchanged). */
  claudeHome?: string;
}

/**
 * Per-engine clone-home capability (Round-4). Declaring this makes a CLI
 * auto-cloneable: the clone gets an isolated home relocated via `envVar`. An
 * adapter WITHOUT cloneHome cannot be auto-cloned (the orchestrator refuses
 * before building anything — 蔻黛 v2 Blocker1). This is the single per-engine
 * extension point: the clone/seat/orchestration path reads this capability and
 * never hardcodes an engine list, so adding a new adapter makes it auto-clone-
 * ready without touching that path.
 *
 * (Round-4 batch 1 carries the two facts the upper layer needs — the env var to
 * relocate the home and the clone's home dir name. File classification + worker/
 * transcript home threading land in batch 2 / B4.)
 */
export interface CloneHomeSpec {
  /**
   * Isolation tier (Round-4 coco). 'full' = home/state/memory all isolated
   * (claude-code, codex — a single relocatable home holds everything). 'state-only'
   * = ONLY session/cache state is isolated; persona/config/memory are SHARED
   * because the CLI keeps them under non-relocatable $HOME paths (coco/trae:
   * ~/.coco + ~/.trae). A 'state-only' engine is NEVER chosen by default auto
   * seat-filling — it requires an explicit ref (蔻黛 guardrail 2).
   *
   * IMPORTANT (蔻黛 guardrail 1): for 'state-only', botmux does NOT enforce
   * read-only on the shared $HOME persona/memory — it merely OBSERVED that the
   * current CLI version doesn't write them during a session. Never describe this
   * as "read-only protected"; if a future CLI version starts writing those dirs,
   * two clones could race. State that must be written goes to the isolated cache.
   */
  readonly tier: 'full' | 'state-only';
  /** Env var that relocates this CLI's home/cache for an isolated clone
   *  (claude-code → CLAUDE_CONFIG_DIR, codex → CODEX_HOME, coco → XDG_CACHE_HOME). */
  readonly envVar: string;
  /** Dir name under `<botmux>/clones/<appId>/` for the clone's isolated home. */
  readonly dirName: string;
  /** The 本体's default home dir (claude → ~/.claude, codex → ~/.codex) — the source
   *  tree symlink/copy/seed read from when the source bot has no per-bot home dir. */
  defaultHome(): string;
  /** Top-level entries symlink-shared with the source (read-mostly persona / creds
   *  the clone should follow). */
  readonly sharedEntries: readonly string[];
  /** Top-level entries COPIED once at clone time then owned independently — for
   *  mutable files that must not be symlink-shared (e.g. codex auth.json/config.toml,
   *  which a CLI may rewrite/atomic-rename, clobbering a symlink or cross-polluting
   *  the 本体). Skipped if already present (never overwrites a forked clone). */
  readonly copyEntries: readonly string[];
  /** Top-level dirs pre-created empty & independent (state). May be empty when the
   *  CLI creates its own state on first run in a fresh home (e.g. codex). */
  readonly independentDirs: readonly string[];
  /** Memory-seed strategy. 'claude-projects' = copy each projects/<key>/memory
   *  (plain files, safe); 'none' = no seed (clone starts with empty memory — used
   *  where memory is live SQLite that must never be copied, e.g. codex). */
  readonly memorySeed: 'claude-projects' | 'none';
}

export interface CliAdapter {
  /** Unique identifier */
  readonly id: string;

  /** Clone-home capability (Round-4). Present ⇒ this CLI can be auto-cloned with
   *  an isolated, relocated home. Absent ⇒ not auto-cloneable. */
  readonly cloneHome?: CloneHomeSpec;

  /** Resolved absolute path to the CLI binary */
  readonly resolvedBin: string;

  /** Build spawn arguments (bin comes from resolvedBin).
   *  The backend also spawns the process in `workingDir`; adapters may use the
   *  same value when a CLI needs an explicit workspace-root flag.
   *  When initialPrompt is provided and the adapter supports it, the prompt
   *  is baked into CLI args (e.g. Gemini's -i flag) instead of being written
   *  to stdin after idle detection. */
  buildArgs(opts: {
    sessionId: string;
    resume: boolean;
    workingDir?: string;
    /** CLI-native session id used for resume when it differs from botmux's session id. */
    resumeSessionId?: string;
    initialPrompt?: string;
    botName?: string;
    botOpenId?: string;
    /** UI / response language for prompts injected into the CLI (e.g. zh / en). */
    locale?: import('../../i18n/index.js').Locale;
    /** This session's CLI home (Round-4 B4): for a cloned bot, the relocated home
     *  (= cfg.claudeConfigDir). Adapters that read home-scoped files during
     *  buildArgs (e.g. codex resume-fallback scanning history.jsonl) MUST use this,
     *  not a hardcoded global ~/.codex — else a clone reads the 本体's home. */
    cliHome?: string;
  }): string[];

  /** When true, the adapter passes the initial prompt via CLI args (e.g. -i).
   *  The worker skips queuing the prompt for stdin write. */
  readonly passesInitialPromptViaArgs?: boolean;

  /** Build a shell command string the user can paste into a terminal to
   *  resume this CLI session locally — independent of botmux. Used by the
   *  "session closed" card so users have an obvious way to keep the
   *  conversation outside the bot.
   *
   *  Returns `null` when the CLI doesn't support precise per-session resume
   *  from CLI args (e.g. opencode, gemini's "latest only" mode), or when
   *  the CLI-native session id can't be resolved (e.g. codex history file
   *  is missing). The card falls back to a static note in those cases.
   *
   *  Implementations should print the *default* binary name (`claude`,
   *  `codex`, etc.) rather than `cliPathOverride` — the override is a
   *  server-side setting and users running the command on their own
   *  laptop usually have the default binary on PATH. */
  buildResumeCommand?(opts: {
    sessionId: string;
    /** CLI-native session id from session.cliSessionId, when available. */
    cliSessionId?: string;
    /** This session's CLI home (Round-4 B4) — same role as buildArgs.cliHome:
     *  resume-fallback history lookups read this home, not the global default. */
    cliHome?: string;
  }): string | null;

  /** Write user input to PTY. May fire writes asynchronously (e.g. Aiden delayed Enter).
   *  Resolves when all writes are complete.
   *
   *  Return value is optional: adapters that can verify the submit (e.g. Claude
   *  Code via session JSONL) return `{ submitted: false }` when all retries
   *  failed, so the worker can surface that to the user. `void` / undefined
   *  means "no verification performed, assume OK".
   *
   *  When `submitted === false`, adapters may attach a `recheck` closure that
   *  re-scans the transcript on demand. The worker calls it after a delay so
   *  slow-path submits (cold-start, slow UserPromptSubmit hooks, busy disk)
   *  that landed *after* the in-band retry budget exhausted are recognised
   *  and the user_notify warning is suppressed. The closure must be cheap
   *  and idempotent — worker may invoke it multiple times. */
  writeInput(
    pty: PtyHandle,
    content: string,
  ): Promise<void | {
    submitted: boolean;
    cliSessionId?: string;
    /** Non-transient reason when the adapter knows submission is impossible
     *  without waiting for transcript confirmation (for example an unsupported
     *  terminal keybinding). Worker surfaces this immediately. */
    failureReason?: string;
    recheck?: () => boolean | Promise<boolean>;
  }>;

  /** Optional: absolute path (with ~ expansion handled by caller) to the CLI's
   *  skill directory.  When set, `ensureSkills` will write/refresh skill files
   *  into `{skillsDir}/<skillName>/SKILL.md`.  Undefined = this CLI does not
   *  support skills (or has a non-standard layout not yet integrated). */
  readonly skillsDir?: string;

  /** Completion marker regex (beyond generic quiescence). undefined = quiescence only. */
  readonly completionPattern?: RegExp;

  /** Ready marker regex — matches when the CLI's input prompt is rendered and
   *  functional.  When set, the idle detector suppresses quiescence-based idle
   *  until this pattern appears in the PTY output.  Checked every cycle (reset
   *  after each prompt), so it gates EVERY idle detection, not just startup.
   *
   *  Examples: CoCo `⏵⏵` status bar, Codex `›` prompt indicator. */
  readonly readyPattern?: RegExp;

  /** CLI-specific system hints injected into the initial prompt.
   *  e.g. "use Read tool for attachments", "don't use PlanMode" */
  readonly systemHints: string[];

  /** When true, the adapter injects Lark session context (instructions +
   *  session ID) via CLI flags (e.g. --append-system-prompt).  The session
   *  manager skips appending "Session ID: ..." to every user message. */
  readonly injectsSessionContext?: boolean;

  /** When true, the CLI accepts input while busy (type-ahead). Worker writes
   *  queued messages immediately instead of waiting for idle detection.
   *  Only set for CLIs whose input handling is known to tolerate this —
   *  Claude Code buffers input internally and processes it after the current
   *  turn. Others (e.g. CoCo) may drop or garble input while rendering. */
  readonly supportsTypeAhead?: boolean;

  /** Whether CLI uses alternate screen buffer */
  readonly altScreen: boolean;
}

export type CliId = 'claude-code' | 'aiden' | 'coco' | 'codex' | 'cursor' | 'gemini' | 'opencode' | 'antigravity';

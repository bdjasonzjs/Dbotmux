/**
 * AI-powered screen analyzer — detects interactive TUI prompts in terminal output
 * by sending snapshots to a lightweight LLM and parsing structured responses.
 *
 * Token-saving protocol:
 *   1. Text diff — skip if snapshot unchanged
 *   2. Cumulative stability — require N consecutive unchanged snapshots
 *   3. AI-driven cooldown — AI returns checkAgainWhen to control re-call timing
 *   4. Prompt-active guard — stop calling AI once a prompt is reported, until resolved
 */

export interface ScreenAnalyzerConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  intervalMs: number;
  stableCount: number;
  snapshotMaxChars: number;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
}

export interface TuiPromptOption {
  label: string;       // short label as shown in TUI (e.g. "1", "A", "❯")
  text: string;        // full option text
  selected: boolean;
  type: 'select' | 'toggle' | 'confirm' | 'input';
  index: number;       // 0-based position — # of Down presses from first option
}

export interface ScreenAnalysis {
  needsInteraction: boolean;
  description?: string;
  options?: TuiPromptOption[];
  multiSelect?: boolean;
  toggleKey?: string;   // key to toggle checkbox items (default "Space")
  confirmKey?: string;  // key to confirm/submit (default "Enter")
  checkAgainWhen: 'content_changed' | 'after_5s' | 'after_10s' | 'not_needed';
}

export interface ScreenAnalyzerCallbacks {
  getSnapshot: () => string;
  onAnalyzing: () => void;
  onTuiPrompt: (description: string, options: TuiPromptOption[], multiSelect: boolean) => void;
  onTuiPromptResolved: (selectedText?: string) => void;
  log: (msg: string) => void;
}

const SYSTEM_PROMPT = `You are a terminal screen analyzer. Analyze the terminal screenshot and determine if the CLI is showing a **blocking interactive prompt** that requires the user to make a selection before the CLI can proceed.

A BLOCKING interactive prompt looks like:
- A modal dialog with numbered options and a cursor (❯ or >) pointing to the selected option
- Examples: "Resume from summary / Resume full session / Don't ask me again", "Yes / No / Cancel"
- The CLI cannot proceed until the user selects an option

The following are NOT interactive prompts (return needsInteraction=false):
- Status bar text like "bypass permissions (shift+tab to cycle)" — this is a persistent status indicator, not a blocking prompt
- CLI idle state showing an input cursor (❯) waiting for the user to type a message — this is normal operation
- Progress indicators, spinners, or loading animations
- Error messages or informational output
- Any text that is part of the CLI's normal UI chrome (toolbars, status bars, mode indicators)

Return ONLY valid JSON (no markdown, no extra text):
{
  "needsInteraction": boolean,
  "description": "what is being asked",
  "options": [{"label": "1", "text": "option text", "type": "select", "index": 0}],
  "multiSelect": false,
  "toggleKey": "Space",
  "confirmKey": "Enter",
  "checkAgainWhen": "content_changed" | "after_5s" | "after_10s" | "not_needed"
}

For each option:
- label: exact label shown in TUI. If none, use sequential numbers.
- text: full option text
- type: "select" (single pick), "toggle" (multi-select checkbox), "confirm" (submit/next/done), "input" (free text like "Type something")
- index: the 0-based position of this option in the list (0 = first navigable item, 1 = second, etc.). Count ALL navigable items from top to bottom in order, including submit/next buttons. DO NOT count non-interactive lines like descriptions or separators.

toggleKey: the key used to toggle a checkbox item. Read the hint line at the bottom (e.g. "Space to toggle", "Enter to select"). Default "Space".
confirmKey: the key used to confirm/submit. Usually "Enter".
multiSelect: true if checkboxes ([ ]/[✓]/[✗], "可多选"), false for single-select (❯ cursor).

Important: "index" is the COUNT of ↓ presses needed to reach this option from the FIRST option (index 0). The first option is always index 0.

Rules for checkAgainWhen:
- "content_changed": call again when content changes
- "after_5s" or "after_10s": check back after a delay
- "not_needed": CLI is working normally or idle — don't call until content changes substantially

If needsInteraction is false, omit description and options fields.`;

export class ScreenAnalyzer {
  private config: ScreenAnalyzerConfig;
  private callbacks: ScreenAnalyzerCallbacks;
  private timer: ReturnType<typeof setInterval> | null = null;

  // Stability tracking
  private lastSnapshot = '';
  private stableCount = 0;

  // AI-driven cooldown
  private lastAnalyzedSnapshot = '';
  private waitingForContentChange = false;
  private timerCooldownUntil = 0;

  // Prompt state
  private promptActive = false;

  // Concurrency guard — prevent overlapping AI calls
  private _analyzing = false;

  // Disposed flag
  private disposed = false;

  constructor(config: ScreenAnalyzerConfig, callbacks: ScreenAnalyzerCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
  }

  /** Whether an AI call is currently in flight */
  get isAnalyzing(): boolean { return this._analyzing; }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.config.intervalMs);
    this.callbacks.log('ScreenAnalyzer started');
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Called externally when user has made a selection via card click */
  notifySelection(selectedText: string): void {
    this.promptActive = false;
    // Reset all cooldowns so we check again soon to confirm prompt is gone
    this.waitingForContentChange = false;
    this.timerCooldownUntil = 0;
    this.stableCount = 0;
    this.lastSnapshot = '';
    this.callbacks.log(`ScreenAnalyzer: selection made — "${selectedText}"`);
  }

  private async tick(): Promise<void> {
    if (this.disposed) return;
    // Don't call AI while a prompt is active — we already notified Daemon.
    if (this.promptActive) return;
    // Don't overlap AI calls
    if (this._analyzing) return;

    // Layer 1: Text diff — get current snapshot
    const snapshot = this.callbacks.getSnapshot();
    if (!snapshot) return;

    const truncated = snapshot.length > this.config.snapshotMaxChars
      ? snapshot.slice(-this.config.snapshotMaxChars)
      : snapshot;

    if (truncated === this.lastSnapshot) {
      this.stableCount++;
    } else {
      this.stableCount = 1;
      this.lastSnapshot = truncated;
      if (this.waitingForContentChange) {
        this.waitingForContentChange = false;
      }
    }

    // Layer 2: Cumulative stability — require N consecutive unchanged snapshots
    if (this.stableCount < this.config.stableCount) return;

    // Layer 3: AI-driven cooldown
    if (this.waitingForContentChange && truncated === this.lastAnalyzedSnapshot) return;
    if (this.timerCooldownUntil > Date.now()) return;

    // All layers passed — call AI
    this._analyzing = true;
    this.callbacks.onAnalyzing();
    try {
      await this.analyze(truncated);
    } finally {
      this._analyzing = false;
    }
  }

  private async analyze(snapshot: string): Promise<void> {
    this.lastAnalyzedSnapshot = snapshot;

    let analysis: ScreenAnalysis;
    try {
      analysis = await this.callAI(snapshot);
    } catch (err: any) {
      this.callbacks.log(`ScreenAnalyzer AI call failed: ${err.message}`);
      this.waitingForContentChange = true;
      return;
    }

    // Apply checkAgainWhen
    switch (analysis.checkAgainWhen) {
      case 'content_changed':
      case 'not_needed':
        this.waitingForContentChange = true;
        break;
      case 'after_5s':
        this.timerCooldownUntil = Date.now() + 5_000;
        this.waitingForContentChange = false;
        break;
      case 'after_10s':
        this.timerCooldownUntil = Date.now() + 10_000;
        this.waitingForContentChange = false;
        break;
    }

    if (analysis.needsInteraction && analysis.options && analysis.options.length > 0) {
      // Generate keys deterministically in code, using AI-provided index + toggleKey/confirmKey
      const toggleKey = analysis.toggleKey || 'Space';
      const confirmKey = analysis.confirmKey || 'Enter';
      for (const opt of analysis.options) {
        const keys: string[] = [];
        for (let i = 0; i < opt.index; i++) keys.push('Down');
        if (opt.type === 'toggle') {
          keys.push(toggleKey);
          // Return to top for next toggle
          for (let i = 0; i < opt.index; i++) keys.push('Up');
        } else if (opt.type === 'select' || opt.type === 'confirm') {
          keys.push(confirmKey);
        } else if (opt.type === 'input') {
          keys.push(confirmKey);  // select the input option
        }
        (opt as any).keys = keys;
      }

      this.promptActive = true;
      this.callbacks.onTuiPrompt(analysis.description ?? 'CLI needs your selection', analysis.options, !!analysis.multiSelect);
      this.callbacks.log(`ScreenAnalyzer: TUI prompt detected — ${analysis.description}${analysis.multiSelect ? ' (multi-select)' : ''} [toggleKey=${toggleKey}, confirmKey=${confirmKey}]`);
    }
  }

  private async callAI(snapshot: string): Promise<ScreenAnalysis> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: snapshot },
      ],
      temperature: 0,
      max_tokens: 2048,
      // Extra body params from config (e.g. { thinking: { type: "disabled" } } for Ark)
      ...(this.config.extraBody ?? {}),
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
        ...(this.config.extraHeaders ?? {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`AI API ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json() as any;
    const content = data?.choices?.[0]?.message?.content ?? '';

    // Parse JSON from response — handle potential markdown wrapping
    const jsonStr = content.replace(/^```json?\s*/, '').replace(/\s*```$/, '').trim();
    try {
      const parsed = JSON.parse(jsonStr);
      return {
        needsInteraction: !!parsed.needsInteraction,
        description: parsed.description,
        multiSelect: !!parsed.multiSelect,
        toggleKey: parsed.toggleKey || 'Space',
        confirmKey: parsed.confirmKey || 'Enter',
        options: Array.isArray(parsed.options)
          ? parsed.options.map((o: any, i: number) => ({
              label: o.label || String(i + 1),
              // Clean text: collapse newlines/multi-line descriptions into single line
              text: (o.text || '').replace(/\n+/g, ' ').trim(),
              selected: !!o.selected,
              type: (['select', 'toggle', 'confirm', 'input'].includes(o.type) ? o.type : 'select') as TuiPromptOption['type'],
              index: typeof o.index === 'number' ? o.index : i,
            }))
          : undefined,
        checkAgainWhen: ['content_changed', 'after_5s', 'after_10s', 'not_needed'].includes(parsed.checkAgainWhen)
          ? parsed.checkAgainWhen
          : 'content_changed',
      };
    } catch {
      throw new Error(`Failed to parse AI response as JSON: ${jsonStr.slice(0, 200)}`);
    }
  }
}

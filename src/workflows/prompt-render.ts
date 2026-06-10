/**
 * workflow prompt renderer (T5) — composes a subagent node's final prompt.
 *
 * DEV-CONTEXT §2.1 / §6.5: the prompt is assembled from a role-persona
 * preamble (role.md body) followed by FOUR contextual segments in a FIXED
 * order:
 *
 *   1. task goal              (what this task is about)
 *   2. workflow fragment      (the node's own authored prompt — the required bit)
 *   3. scoped domains top-k   (horizontal knowledge relevant to this node)
 *   4. run state delta        (what changed this run — upstream outputs etc.)
 *
 * This is the workflow engine's real injection path (lands in
 * `runtime.dispatchWork`, after role compilation). It deliberately does NOT
 * replace the subgroup-kickoff link — both share THIS renderer for the
 * context body, but kickoff keeps its own Lark wake / mention / norms wrapper
 * (Finding 4). See `subgroup-kickoff.ts`.
 *
 * Back-compat contract (critical): when only the workflow fragment is present
 * — i.e. a plain bot-authored node with no role/domains/delta — the renderer
 * returns that fragment VERBATIM, with no headers. Existing workflows are
 * byte-for-byte unchanged; the four-segment scaffold only appears once extra
 * context is actually supplied.
 *
 * The renderer also returns an injection rationale (which segments were
 * included, top-k, reason) so the dispatch path can log it for second-level
 * debugging (§6.5 "记录注入理由到 run log").
 */

/** A scoped domain knowledge snippet selected for injection. */
export interface DomainSnippet {
  topic: string;
  text: string;
}

export interface PromptParts {
  /** role.md body — identity/persona preamble (optional). */
  rolePersona?: string;
  /** Segment 1 — the task's one-line goal (optional). */
  taskGoal?: string;
  /** Segment 2 — the node's authored prompt. Always present. */
  workflowFragment: string;
  /** Segment 3 — scoped domains, already top-k selected by the caller. */
  domains?: DomainSnippet[];
  /** Segment 4 — run-state delta (e.g. rendered upstream outputs). */
  runDelta?: string;
}

export interface InjectionRationale {
  /** Ordered list of segment keys actually included. */
  segments: string[];
  /** Number of domain snippets injected (the top-k that survived). */
  domainCount: number;
  /** Short human-readable reason, for the run log. */
  reason: string;
}

export interface RenderedPrompt {
  prompt: string;
  rationale: InjectionRationale;
}

const SECTION = {
  rolePersona: '## Role',
  taskGoal: '## Task',
  workflowFragment: '## Step',
  domains: '## Domain knowledge',
  runDelta: '## Run state (delta)',
} as const;

function isNonEmpty(s: string | undefined): s is string {
  return typeof s === 'string' && s.trim().length > 0;
}

/** A labeled block of prompt text. */
export interface Section {
  header: string;
  body: string;
}

/**
 * The shared low-level composition primitive (Finding 4: "共用底层模板能力,
 * 但不互相替代"). Joins labeled sections as `header\nbody`, blank-line
 * separated. Both the workflow prompt renderer and `subgroup-kickoff` build
 * their context body through THIS — they share the assembly mechanism without
 * one replacing the other's link-level semantics.
 */
export function composeSections(sections: Section[]): string {
  return sections.map((s) => `${s.header}\n${s.body}`).join('\n\n');
}

/**
 * Render the node prompt from its parts in the fixed segment order.
 *
 * Single-segment fast path: if the workflow fragment is the only non-empty
 * part, return it verbatim (no headers) — preserves existing behavior.
 */
export function renderNodePrompt(parts: PromptParts): RenderedPrompt {
  const domains = (parts.domains ?? []).filter((d) => isNonEmpty(d.text));
  const ordered: Array<{ key: string; header: string; body: string }> = [];

  if (isNonEmpty(parts.rolePersona)) {
    ordered.push({ key: 'rolePersona', header: SECTION.rolePersona, body: parts.rolePersona.trim() });
  }
  if (isNonEmpty(parts.taskGoal)) {
    ordered.push({ key: 'taskGoal', header: SECTION.taskGoal, body: parts.taskGoal.trim() });
  }
  // workflow fragment is always present (segment 2)
  ordered.push({ key: 'workflowFragment', header: SECTION.workflowFragment, body: parts.workflowFragment });
  if (domains.length > 0) {
    const body = domains.map((d) => `### ${d.topic}\n${d.text.trim()}`).join('\n\n');
    ordered.push({ key: 'domains', header: SECTION.domains, body });
  }
  if (isNonEmpty(parts.runDelta)) {
    ordered.push({ key: 'runDelta', header: SECTION.runDelta, body: parts.runDelta.trim() });
  }

  const rationale: InjectionRationale = {
    segments: ordered.map((s) => s.key),
    domainCount: domains.length,
    reason:
      ordered.length === 1
        ? 'single-segment (workflow fragment only) — verbatim, no injection'
        : `injected ${ordered.length} segments [${ordered.map((s) => s.key).join(', ')}]` +
          (domains.length > 0 ? ` with top-${domains.length} domains` : ''),
  };

  // Back-compat fast path: lone workflow fragment → verbatim.
  if (ordered.length === 1) {
    return { prompt: parts.workflowFragment, rationale };
  }

  const prompt = composeSections(ordered.map((s) => ({ header: s.header, body: s.body })));
  return { prompt, rationale };
}

/** One completed upstream node's output, for the run-state delta segment. */
export interface RunDeltaEntry {
  nodeId: string;
  output: unknown;
}

/**
 * Render completed upstream dependency outputs into the segment-4 "run state
 * (delta)" body (T5, DEV-CONTEXT §6.5). Each entry is compacted to one line
 * and truncated so a large upstream payload can't blow up the prompt. Returns
 * `undefined` when there is nothing to inject (no completed deps) — the caller
 * then omits the segment and the back-compat fast path still holds.
 */
export function renderRunDelta(
  entries: RunDeltaEntry[],
  opts: { maxCharsPerEntry?: number } = {},
): string | undefined {
  const max = opts.maxCharsPerEntry ?? 600;
  const lines = entries.map(({ nodeId, output }) => {
    let text: string;
    try {
      text = typeof output === 'string' ? output : JSON.stringify(output);
    } catch {
      text = String(output);
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > max) text = text.slice(0, max) + '…(truncated)';
    return `- ${nodeId}: ${text}`;
  });
  return lines.length > 0 ? lines.join('\n') : undefined;
}

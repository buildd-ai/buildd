/**
 * The `## Workspace Memory` block every worker prompt carries — and how much
 * of the prompt that block costs.
 *
 * This used to run a two-arm experiment (`full`, carrying the entire
 * workspace-wide digest, vs `task_scoped`, which drops it and keeps only the
 * task-specific matches). The experiment concluded — see
 * `docs/design/workspace-memory-digest-arm.md` — with the workspace-wide
 * digest saving nothing measurable while costing a quarter of the prompt. So
 * `task_scoped` is now simply how every prompt renders: there is no arm, no
 * draw, and no enrolment fraction. The per-unit randomiser that used to make
 * the assignment was extracted to `./experiment-randomizer` before this file
 * dropped its only caller of it, so the next experiment does not have to
 * re-derive it.
 *
 * `### Relevant to This Task` still leans on the `recall` tool the block
 * advertises, and still renders even when nothing matched the task — that
 * pointer is behavioural instruction, not context, and dropping it would
 * change how often agents record knowledge.
 */

/**
 * Historical policy version. Bump whenever what reaches the `## Workspace
 * Memory` block changes — the readout for the concluded experiment
 * (`packages/core/memory-digest-readout.ts`) selects its cohort by this value,
 * and `worker_prompt_composition_events` rows still carry it, so it must keep
 * meaning "this is what the block rendered" even with no arm left to salt.
 */
export const MEMORY_DIGEST_POLICY_VERSION = 'memory-digest-v4';

/** Per-observation cap on the task-specific matches. */
export const MAX_OBSERVATION_CHARS = 300;

const RECALL_POINTER =
  '\nUse `recall scope=["memory","task"]` for full context (prior lessons + recent outcomes in one call). Use `learn` to record gotchas/patterns/decisions — NOT summaries.';

export interface MemoryBlockInput {
  /**
   * The workspace-wide digest, as returned by getCompactObservations. Not
   * rendered — see module docs.
   */
  compactResult: {
    count: number;
    markdown?: string;
    /**
     * Bytes of the fetched memories' FULL content, before
     * getCompactObservations' own 150-char-per-item slice throws most of it
     * away. Optional so a caller (or an older fixture) that only has the
     * already-sliced markdown still works — digestBytesAvailable then falls
     * back to measuring that, same as before this field existed.
     */
    rawContentBytes?: number;
  };
  /** Ids of the task-title matches — the outer render gate reads its length. */
  taskSearchResults: ReadonlyArray<{ id: string }>;
  /** Hydrated content for those matches. */
  fullObservations: ReadonlyArray<{ type: string; title: string; content: string }>;
}

export interface MemoryBlockResult {
  /** The rendered block, or null when there is nothing to say. */
  block: string | null;
  /** Bytes of workspace-wide digest actually rendered. Always 0 — kept for the composition record's historical shape. */
  digestBytes: number;
  /**
   * Bytes the digest WOULD have occupied had it been rendered, measured
   * PRE-CAP — i.e. `compactResult.rawContentBytes` when the caller reports it,
   * before getCompactObservations' 150-char-per-item slice discarded most of
   * it. Falls back to the (already-sliced) markdown's byte length when the
   * caller does not report the raw figure. Kept for the composition record:
   * it is what the concluded experiment's saving was measured against, and it
   * still answers "how much would restoring the digest cost today".
   */
  digestBytesAvailable: number;
  taskMatchBytes: number;
  taskMatchCount: number;
  /**
   * True when the raw content available was larger than what actually made it
   * into the (unrendered) digest markdown — i.e. something was discarded
   * upstream. False when the two agree, including when the caller reports no
   * `rawContentBytes` at all (nothing to compare against).
   */
  digestTruncated: boolean;
}

/**
 * Render the `## Workspace Memory` block, and report what it cost.
 *
 * Byte counts are UTF-8 byte lengths, not string lengths — workspace memory
 * routinely carries non-ASCII.
 */
export function buildMemoryBlock(input: MemoryBlockInput): MemoryBlockResult {
  const { compactResult, taskSearchResults, fullObservations } = input;

  const renderedDigestBytes = byteLength(compactResult.markdown ?? '');
  const digestBytesAvailable = compactResult.rawContentBytes ?? renderedDigestBytes;
  const digestTruncated = digestBytesAvailable > renderedDigestBytes;

  // Nothing to render when the workspace has no memory at all and the task
  // matched nothing.
  if (compactResult.count === 0 && taskSearchResults.length === 0) {
    return {
      block: null,
      digestBytes: 0,
      digestBytesAvailable,
      taskMatchBytes: 0,
      taskMatchCount: 0,
      digestTruncated,
    };
  }

  // The count rides on the header: "there are N memories, and here is how to
  // fetch them" is an actionable pairing with the recall pointer below.
  const parts: string[] = [
    compactResult.count > 0
      ? `## Workspace Memory (${compactResult.count} ${compactResult.count === 1 ? 'memory' : 'memories'})`
      : '## Workspace Memory',
  ];

  let taskMatchBytes = 0;
  if (fullObservations.length > 0) {
    const matchLines = ['### Relevant to This Task'];
    for (const obs of fullObservations) {
      const truncContent = obs.content.length > MAX_OBSERVATION_CHARS
        ? obs.content.slice(0, MAX_OBSERVATION_CHARS) + '...'
        : obs.content;
      matchLines.push(`- **[${obs.type}] ${obs.title}**: ${truncContent}`);
    }
    const rendered = matchLines.join('\n');
    parts.push(rendered);
    taskMatchBytes = byteLength(rendered);
  }

  parts.push(RECALL_POINTER);

  return {
    block: parts.join('\n'),
    digestBytes: 0,
    digestBytesAvailable,
    taskMatchBytes,
    taskMatchCount: fullObservations.length,
    digestTruncated,
  };
}

/**
 * One entry per named block `buildPromptWithComposition` (prompt-builder.ts)
 * considers emitting — present whether or not it actually rendered, so a
 * section that is silently gated off is as visible as one that fired.
 */
export interface PromptSectionRecord {
  name: string;
  /** UTF-8 bytes of the rendered content. 0 when `rendered` is false. */
  bytes: number;
  rendered: boolean;
  /** True when this section's content was cut down from more than it shows. */
  truncated: boolean;
}

/** One record per prompt build. */
export interface PromptCompositionRecord {
  policyVersion: string;
  /** Always 'task_scoped' — kept as a column so historical `full` rows and current rows share a schema. */
  arm: 'task_scoped';
  propensity: number;
  fraction: number;
  /**
   * Agent backend this prompt was built for.
   *
   * Load-bearing for analysis, not decoration: the Codex path also delivers the
   * role persona, inlined skills and project instructions through an AGENTS.md
   * file on disk, none of which is part of `promptText`. So `memoryShare` means
   * a different thing per backend and rows must be segmented, never pooled.
   */
  backend: string;
  digestBytes: number;
  digestBytesAvailable: number;
  digestTruncated: boolean;
  taskMatchBytes: number;
  taskMatchCount: number;
  /**
   * Which retrieval step produced the task matches — see
   * apps/runner/src/task-memory-retrieval.ts.
   *
   * Load-bearing, not decoration: `taskMatchCount: 5` reads identically whether
   * those five came from a declared path overlap or from five recent memories
   * that happened to share a stopword with the title. Without the provenance,
   * retrieval quality is not recoverable from the stored data.
   */
  taskMatchDerivedBy: string;
  memoryBlockBytes: number;
  promptBytes: number;
  /** Memory block as a share of the whole prompt, 0–1, rounded to 3dp. */
  memoryShare: number;
  /**
   * Per-section byte accounting for every block `buildPromptWithComposition`
   * considers — see `PromptSectionRecord`. Previously only the memory block
   * (the fields above) was instrumented; the other ~12 sections were each
   * individually invisible. `sections` closes that for good: a section that
   * silently stops rendering shows up here as `rendered: false` instead of as
   * nothing at all.
   */
  sections: PromptSectionRecord[];
}

export function buildPromptCompositionRecord(args: {
  memory: MemoryBlockResult;
  /** The FINAL prompt, after every append — see workers.ts for why this must be built at the last mutation site. */
  promptText: string;
  backend?: string | null;
  /** Which retrieval step produced the task matches; 'unknown' when unreported. */
  taskMatchDerivedBy?: string | null;
  /** Per-section vector from buildPromptWithComposition. Defaults to []. */
  sections?: PromptSectionRecord[];
}): PromptCompositionRecord {
  const { memory, promptText } = args;
  const memoryBlockBytes = memory.block ? byteLength(memory.block) : 0;
  const promptBytes = byteLength(promptText);
  return {
    policyVersion: MEMORY_DIGEST_POLICY_VERSION,
    arm: 'task_scoped',
    propensity: 1,
    fraction: 1,
    backend: args.backend || 'claude',
    digestBytes: memory.digestBytes,
    digestBytesAvailable: memory.digestBytesAvailable,
    digestTruncated: memory.digestTruncated,
    taskMatchBytes: memory.taskMatchBytes,
    taskMatchCount: memory.taskMatchCount,
    taskMatchDerivedBy: args.taskMatchDerivedBy || 'unknown',
    memoryBlockBytes,
    promptBytes,
    sections: args.sections ?? [],
    memoryShare: promptBytes > 0
      ? Math.round((memoryBlockBytes / promptBytes) * 1000) / 1000
      : 0,
  };
}

export function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** A PromptCompositionRecord tagged with its position in the runner's durable event rail. */
export type PromptCompositionEvent = PromptCompositionRecord & { buildIndex: number; ts: number };

/**
 * Append a composition record to a worker's pending event buffer, assigning
 * it the next buildIndex.
 *
 * A pure function rather than inline mutation in startSession (workers.ts) so
 * the increment-and-append logic — the part a duplicated or skipped buildIndex
 * would silently corrupt the (workerId, buildIndex) unique constraint over —
 * is unit-testable without exercising the rest of session startup.
 *
 * currentBuildIndex must be threaded through explicitly rather than reset:
 * a worker that rebuilds its prompt more than once (the bwrap-retry restart in
 * startSession rebuilds from scratch on the same worker) must not reuse index 0.
 */
export function appendPromptCompositionEvent(
  buffer: readonly PromptCompositionEvent[] | undefined,
  currentBuildIndex: number | undefined,
  record: PromptCompositionRecord,
  ts: number,
): { buffer: PromptCompositionEvent[]; nextBuildIndex: number } {
  const buildIndex = currentBuildIndex ?? 0;
  return {
    buffer: [...(buffer ?? []), { ...record, buildIndex, ts }],
    nextBuildIndex: buildIndex + 1,
  };
}

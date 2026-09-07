/**
 * Which workspace-memory block a worker's prompt gets — and how much of the
 * prompt that block cost.
 *
 * Two arms:
 *
 * - `full` is what every worker got before this file existed: the entire
 *   workspace digest, blind-sliced at `FULL_DIGEST_MAX_BYTES`, followed by the
 *   task-specific matches. It is the control, and it deliberately keeps the
 *   blind slice — fixing that to fall on a line boundary is a real improvement
 *   and belongs in its own change.
 *
 * The control differs from the pre-experiment rendering in exactly one way: the
 * digest no longer arrives with its own `## Workspace Memory (N memories)`
 * heading, which used to land underneath this block's header as a duplicate.
 * That was fixed here rather than later because **the control is only frozen
 * once enrolment starts.** This module has never run outside tests, so there
 * are no collected rows to invalidate; from the first enrolled task onwards,
 * changing the control silently rebases the comparison and any change to it
 * must bump `MEMORY_DIGEST_POLICY_VERSION`.
 *
 * - `task_scoped` drops the workspace-wide digest and keeps everything else,
 *   leaning on the `recall` tool the block already advertises to pull the rest
 *   on demand.
 *
 * The two arms differ on exactly one axis: whether the workspace-wide digest
 * is present. In particular `task_scoped` still emits the block header and the
 * `recall`/`learn` pointer even when there are no task matches, because that
 * pointer is behavioural instruction — dropping it would change how often
 * agents record knowledge and confound the result with a context-size effect.
 *
 * Why this is an arm and not a migration: the evidence for shrinking is a
 * proxy. Retrieved paths turn out to barely predict touched paths, and
 * redundancy against what the agent would have read anyway is near-total. That
 * says the digest is not being used for navigation. It does NOT say the digest
 * is inert — it may shape how code gets written in ways path overlap cannot
 * see. So the default enrols nobody.
 */

/** The workspace-memory block variants a prompt can receive. */
export type MemoryDigestArm = 'full' | 'task_scoped';

/**
 * Bump whenever the meaning of an arm changes. Outcome rows carrying a stale
 * version are not comparable with newer ones and must not be pooled.
 */
export const MEMORY_DIGEST_POLICY_VERSION = 'memory-digest-v1';

/** Byte cap on the workspace-wide digest under the `full` arm. */
export const FULL_DIGEST_MAX_BYTES = 4096;

/** Per-observation cap on the task-specific matches, in both arms. */
export const MAX_OBSERVATION_CHARS = 300;

const DIGEST_TRUNCATION_NOTE = '\n\n*(truncated — use `recall` for more)*';

const RECALL_POINTER =
  '\nUse `recall scope=["memory","task"]` for full context (prior lessons + recent outcomes in one call). Use `learn` to record gotchas/patterns/decisions — NOT summaries.';

export interface MemoryDigestAssignment {
  arm: MemoryDigestArm;
  /**
   * Probability that this unit would have been assigned the arm it actually
   * got. Any later off-policy estimate divides by this, so it is recorded at
   * assignment time rather than reconstructed from the fraction afterwards —
   * the fraction can be reconfigured between the decision and the analysis.
   */
  propensity: number;
  /** The configured `task_scoped` share this assignment was drawn against. */
  fraction: number;
  policyVersion: string;
}

/**
 * Coerce a configured `task_scoped` share into a usable fraction.
 *
 * Numeric strings are accepted, because the operator-facing knob is an env var
 * and env vars are always strings — rejecting them would make the documented
 * override silently inert, which is a worse failure than a bad value.
 *
 * Anything that is not a finite number inside [0, 1] resolves to 0, meaning
 * "run the control". Out-of-range values are rejected rather than clamped: a
 * fat-fingered `15` (meant as 15%) would clamp to 1 and cut the entire fleet
 * over to the treatment, which is the one outcome this file exists to prevent.
 */
export function resolveTaskScopedFraction(raw: unknown): number {
  const n = typeof raw === 'string'
    ? (raw.trim() === '' ? NaN : Number(raw))
    : raw;
  if (typeof n !== 'number') return 0;
  if (!Number.isFinite(n)) return 0;
  if (n < 0 || n > 1) return 0;
  return n;
}

/**
 * Map a string onto [0, 1) deterministically (FNV-1a, 32-bit).
 *
 * Not a security hash — it only needs to spread UUIDs evenly and give the same
 * answer on every runner, every restart, and every replay of the analysis.
 *
 * FNV-1a degrades badly for keys that differ only in their last character or
 * two, so callers must pass high-entropy keys. Task ids are v4 UUIDs
 * (`tasks.id` is `uuid().defaultRandom()`), which is fine; a sequential
 * `task-1`, `task-2` scheme would not be.
 *
 * Exported for tests only — assignment goes through assignMemoryDigestArm,
 * which salts the key. A caller that hashes a bare id is not in the experiment.
 */
export function hashUnitInterval(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // >>> 0 first: Math.imul yields a signed int32.
  return (h >>> 0) / 0x100000000;
}

/**
 * Assign an arm to a unit of work.
 *
 * Randomised on the **task** id, not the worker id. A task that retries gets a
 * fresh worker, and the outcomes this experiment is judged on — the rework
 * columns: CI retry, conflict retry, reviewer retry — span those attempts.
 * Randomising per worker would split one outcome across both arms and make the
 * comparison meaningless.
 *
 * An empty task id cannot be randomised stably, so it runs the control.
 */
export function assignMemoryDigestArm(
  taskId: string | undefined | null,
  rawFraction: unknown,
): MemoryDigestAssignment {
  const fraction = resolveTaskScopedFraction(rawFraction);
  const base = { fraction, policyVersion: MEMORY_DIGEST_POLICY_VERSION };

  if (!taskId) return { ...base, arm: 'full', propensity: 1 };
  if (fraction <= 0) return { ...base, arm: 'full', propensity: 1 };
  if (fraction >= 1) return { ...base, arm: 'task_scoped', propensity: 1 };

  // Salted with the policy version, so bumping the version RE-RANDOMISES.
  // Without the salt every task keeps the arm it drew under v1, and a v2
  // comparison silently inherits v1's assignment along with any carry-over
  // effect from it. The salt also decorrelates this experiment from any future
  // one that hashes the same task ids.
  const draw = hashUnitInterval(`${MEMORY_DIGEST_POLICY_VERSION}:${taskId}`);
  return draw < fraction
    ? { ...base, arm: 'task_scoped', propensity: fraction }
    : { ...base, arm: 'full', propensity: 1 - fraction };
}

export interface MemoryBlockInput {
  arm: MemoryDigestArm;
  /** The workspace-wide digest, as returned by getCompactObservations. */
  compactResult: { count: number; markdown?: string };
  /** Ids of the task-title matches — the outer render gate reads its length. */
  taskSearchResults: ReadonlyArray<{ id: string }>;
  /** Hydrated content for those matches. */
  fullObservations: ReadonlyArray<{ type: string; title: string; content: string }>;
}

export interface MemoryBlockResult {
  /** The rendered block, or null when there is nothing to say. */
  block: string | null;
  /** Bytes of workspace-wide digest actually rendered (0 under task_scoped). */
  digestBytes: number;
  /**
   * Bytes the digest WOULD have occupied under `full`. Recorded in both arms so
   * the saving is computable from a control row alone — otherwise the treatment
   * effect and the exposure are entangled.
   */
  digestBytesAvailable: number;
  taskMatchBytes: number;
  taskMatchCount: number;
  /** True when the `full` digest hit the cap and was sliced. */
  digestTruncated: boolean;
}

/**
 * Render the `## Workspace Memory` block for an arm, and report what it cost.
 *
 * Byte counts are UTF-8 byte lengths, not string lengths: the cap below slices
 * by code unit (as it always has) but the prompt budget question is about
 * bytes, and workspace memory routinely carries non-ASCII.
 */
export function buildMemoryBlock(input: MemoryBlockInput): MemoryBlockResult {
  const { arm, compactResult, taskSearchResults, fullObservations } = input;

  const rawDigest = compactResult.markdown ?? '';
  const digestTruncated = rawDigest.length > FULL_DIGEST_MAX_BYTES;
  const renderedFullDigest = digestTruncated
    ? rawDigest.slice(0, FULL_DIGEST_MAX_BYTES) + DIGEST_TRUNCATION_NOTE
    : rawDigest;
  const digestBytesAvailable = byteLength(renderedFullDigest);

  // Same outer gate as before: nothing to render when the workspace has no
  // memory at all and the task matched nothing.
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

  // The count rides on the header, in BOTH arms, so the arms still differ on
  // exactly one axis. It is true regardless of whether the digest is shown, and
  // under task_scoped it is the more useful half: "there are N memories, and
  // here is how to fetch them" is an actionable pairing with the recall pointer
  // below. `getCompactObservations` used to emit its own `## Workspace Memory
  // (N memories)` line, which landed under this header as a duplicate.
  const parts: string[] = [
    compactResult.count > 0
      ? `## Workspace Memory (${compactResult.count} ${compactResult.count === 1 ? 'memory' : 'memories'})`
      : '## Workspace Memory',
  ];

  let digestBytes = 0;
  if (arm === 'full' && renderedFullDigest) {
    parts.push(renderedFullDigest);
    digestBytes = digestBytesAvailable;
  }

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
    digestBytes,
    digestBytesAvailable,
    taskMatchBytes,
    taskMatchCount: fullObservations.length,
    digestTruncated,
  };
}

/**
 * One record per prompt build. This is the denominator for the experiment: a
 * `full` row is as necessary as a `task_scoped` one, so it is emitted
 * unconditionally rather than only when the treatment fires.
 */
export interface PromptCompositionRecord {
  policyVersion: string;
  arm: MemoryDigestArm;
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
  memoryBlockBytes: number;
  promptBytes: number;
  /** Memory block as a share of the whole prompt, 0–1, rounded to 3dp. */
  memoryShare: number;
}

export function buildPromptCompositionRecord(args: {
  assignment: MemoryDigestAssignment;
  memory: MemoryBlockResult;
  /**
   * The FINAL prompt, after every append. Build this record at the last
   * mutation site, not at the end of `buildPromptWithComposition` — the Codex
   * branch prepends an AGENTS.md pointer much later, and a record built early
   * understates `promptBytes` and overstates `memoryShare`.
   */
  promptText: string;
  backend?: string | null;
}): PromptCompositionRecord {
  const { assignment, memory, promptText } = args;
  const memoryBlockBytes = memory.block ? byteLength(memory.block) : 0;
  const promptBytes = byteLength(promptText);
  return {
    policyVersion: assignment.policyVersion,
    arm: assignment.arm,
    propensity: assignment.propensity,
    fraction: assignment.fraction,
    backend: args.backend || 'claude',
    digestBytes: memory.digestBytes,
    digestBytesAvailable: memory.digestBytesAvailable,
    digestTruncated: memory.digestTruncated,
    taskMatchBytes: memory.taskMatchBytes,
    taskMatchCount: memory.taskMatchCount,
    memoryBlockBytes,
    promptBytes,
    memoryShare: promptBytes > 0
      ? Math.round((memoryBlockBytes / promptBytes) * 1000) / 1000
      : 0,
  };
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

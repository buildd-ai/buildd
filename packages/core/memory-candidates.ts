/**
 * Candidate memories: one episode proposes, verification or repetition
 * promotes (docs/design/memory-done-right.md, "Write: candidates, then
 * promotion" and "Safety properties").
 *
 * The vocabulary and the pure rules live here; the DB pass that applies them
 * is ./memory-lifecycle. No DB import: mcp-tools (which the runner also loads)
 * depends on this.
 *
 * Flag: `gitConfig.memoryCandidateWrites` (default off). Off means every write
 * lands `active` exactly as before, extraction never runs, and no workspace
 * has a candidate for promotion or expiry to act on.
 *
 * States:
 *
 * | state       | pushed at claim | recall (query) | recall (id) |
 * |-------------|-----------------|----------------|-------------|
 * | active      | yes             | yes            | yes         |
 * | candidate   | never           | includeCandidates | yes      |
 * | expired     | never           | never          | yes         |
 * | invalidated | never           | never          | yes         |
 *
 * Deliberate gaps, not oversights:
 *
 * - A **chat** candidate never auto-promotes: it has no task whose PR could
 *   verify it and it is never linked as corroboration (only a `learn` is).
 *   It becomes active through the chat directive confirm (step 6) or a human.
 * - A candidate an agent **pulled** (or a task used) never expires: someone
 *   found it worth reading, so it waits for promotion or a human instead of
 *   silently retiring.
 * - Failed-task and review candidates are **external** and never
 *   auto-promote: error text and review text carry content from outside the
 *   team.
 * - A candidate write never hides an active memory: supersedes of active rows
 *   are deferred to `pendingSupersedes` and applied on promotion.
 */

export const MEMORY_STATES = ['candidate', 'active', 'expired', 'invalidated'] as const;
export type MemoryState = typeof MEMORY_STATES[number];

export const MEMORY_SOURCE_KINDS = ['learn', 'failed_task', 'review', 'chat', 'digest', 'dashboard'] as const;
export type MemorySourceKind = typeof MEMORY_SOURCE_KINDS[number];

/** The workspace flag's key in `workspaces.git_config`. */
export const MEMORY_CANDIDATE_FLAG = 'memoryCandidateWrites';

/** Whether new writes land as candidates for a workspace. Anything but literal `true` is off. */
export function isMemoryCandidateWritesEnabled(gitConfig: unknown): boolean {
  return !!gitConfig && typeof gitConfig === 'object'
    && (gitConfig as Record<string, unknown>)[MEMORY_CANDIDATE_FLAG] === true;
}

/** A row with no state (written before the column, or a partial fixture) is active. */
export function memoryStateOf(m: { state?: string | null }): MemoryState {
  const s = m.state;
  return s === 'candidate' || s === 'expired' || s === 'invalidated' ? s : 'active';
}

/** States a push (claim-time) read may serve. */
export const PUSH_MEMORY_STATES: readonly MemoryState[] = ['active'];

/** States a pull may serve: candidates only when the caller asked for them. */
export function pullMemoryStates(includeCandidates: boolean | undefined): readonly MemoryState[] {
  return includeCandidates ? ['active', 'candidate'] : ['active'];
}

/** Where a write came from, as recorded on the row. */
export interface MemoryProvenance {
  kind: MemorySourceKind;
  /** Task id for learn / failed_task; review_feedback id for review. */
  id?: string | null;
  /** Derived from content outside the team: never auto-promoted. */
  external?: boolean;
}

// ── Promotion ────────────────────────────────────────────────────────────────

/** A merged PR must stay unreverted this long before its outcome counts as verified. */
export const PROMOTION_REVERT_WINDOW_HOURS = 72;

/** Candidates judged per lifecycle run. */
export const MEMORY_PROMOTE_MAX_PER_RUN = 25;

/** Shadow `promote` verdicts asked per run (each is one decision call). */
export const MEMORY_PROMOTE_SHADOW_MAX_PER_RUN = 10;

/** Unpromoted candidates with no pull or used outcome expire after this long. */
export const MEMORY_CANDIDATE_EXPIRY_DAYS = 30;

/** Candidates expired per run. */
export const MEMORY_EXPIRE_MAX_PER_RUN = 50;

/** Extracted candidates (failed tasks + reviews) written per run, across the whole pass. */
export const MEMORY_EXTRACT_MAX_PER_RUN = 10;

/** Only episodes this recent are extracted. */
export const MEMORY_EXTRACT_WINDOW_HOURS = 24;

/** Merged-PR ingest jobs scanned per run for re-verify flags. */
export const MEMORY_REVERIFY_MAX_JOBS_PER_RUN = 20;

/**
 * Deterministic evidence for one candidate, assembled by SQL in
 * ./memory-lifecycle. Every field is a fact, not a judgement.
 */
export interface PromotionEvidence {
  /** Content derived from outside the team. */
  external: boolean;
  /** The source task's PR merged at least the revert window ago. */
  sourcePrMergedPastWindow: boolean;
  /** A revert of that PR (or a later merge over its files) landed inside the window. */
  sourcePrReverted: boolean;
  /** A different task's learn, near-duplicate, in the same project, was folded into it. */
  corroborated: boolean;
}

export type PromotionVerdict =
  | { promote: true; reason: 'verified_outcome' | 'corroborated' }
  | { promote: false; reason: 'external' | 'no_evidence' | 'reverted' };

/**
 * The rule that decides while Jev is in shadow. Hard floors first: external
 * content never auto-promotes, and a candidate with neither a verified outcome
 * nor a corroborating episode stays a candidate.
 */
export function decidePromotion(e: PromotionEvidence): PromotionVerdict {
  if (e.external) return { promote: false, reason: 'external' };
  const verified = e.sourcePrMergedPastWindow && !e.sourcePrReverted;
  if (verified) return { promote: true, reason: 'verified_outcome' };
  if (e.corroborated) return { promote: true, reason: 'corroborated' };
  return { promote: false, reason: e.sourcePrMergedPastWindow && e.sourcePrReverted ? 'reverted' : 'no_evidence' };
}

// ── Extraction ───────────────────────────────────────────────────────────────

const clip = (s: string | null | undefined, max: number): string => {
  const t = (s ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export interface ExtractedCandidate {
  type: 'gotcha';
  title: string;
  content: string;
  files: string[];
  provenance: MemoryProvenance;
}

/**
 * A failed task's candidate: the error plus the last summary. Null when there
 * is nothing to learn from (no error and no summary). Marked external.
 */
export function failedTaskCandidate(t: {
  taskId: string;
  title: string;
  error: string | null;
  summary: string | null;
  files?: readonly string[] | null;
}): ExtractedCandidate | null {
  const error = clip(t.error, 600);
  const summary = clip(t.summary, 800);
  if (!error && !summary) return null;
  const parts = [`Task "${clip(t.title, 160)}" failed.`];
  if (error) parts.push(`Error: ${error}`);
  if (summary) parts.push(`Last summary: ${summary}`);
  return {
    type: 'gotcha',
    title: clip(`Failed: ${t.title}`, 120),
    content: parts.join('\n\n'),
    files: [...(t.files ?? [])].slice(0, 20),
    // External: an error message and a summary routinely quote tool output,
    // fetched pages or issue text. Recallable as a candidate, never
    // auto-promoted.
    provenance: { kind: 'failed_task', id: t.taskId, external: true },
  };
}

/**
 * A changes-requested review's candidate. Review text is written by whoever
 * reviewed the PR on GitHub, so it is always marked external: it can be
 * recalled as a candidate but never promotes without a human.
 */
export function reviewCandidate(r: {
  reviewId: string;
  prNumber: number;
  body: string;
  files?: readonly string[] | null;
}): ExtractedCandidate | null {
  const body = clip(r.body, 1200);
  if (!body) return null;
  return {
    type: 'gotcha',
    title: `Review requested changes on PR #${r.prNumber}`,
    content: `A review requested changes on PR #${r.prNumber}:\n\n${body}`,
    files: [...(r.files ?? [])].slice(0, 20),
    provenance: { kind: 'review', id: r.reviewId, external: true },
  };
}

// ── Human review (dashboard) ─────────────────────────────────────────────────

/**
 * What a person sees for a row: its lifecycle state, except that a row with
 * `superseded_by` set reads as superseded whatever its state column says.
 */
export type MemoryDisplayState = MemoryState | 'superseded';

export function memoryDisplayStateOf(m: { state?: string | null; supersededBy?: string | null }): MemoryDisplayState {
  return m.supersededBy ? 'superseded' : memoryStateOf(m);
}

/**
 * The admin actions on one row from the memory dashboard:
 *
 * - `promote`: candidate to active (the human route past the automatic
 *   floors; its deferred supersedes apply, as on automatic promotion).
 * - `dismiss`: candidate, active or expired to invalidated. Reversible like
 *   every state change; nothing is deleted.
 * - `reverified`: a person checked a re-verify flagged row still holds;
 *   clears the flag and its ref. The state is untouched.
 *
 * A superseded row takes none of them: its replacement is the one to act on.
 */
export const MEMORY_REVIEW_ACTIONS = ['promote', 'dismiss', 'reverified'] as const;
export type MemoryReviewAction = typeof MEMORY_REVIEW_ACTIONS[number];

export function isMemoryReviewAction(v: unknown): v is MemoryReviewAction {
  return typeof v === 'string' && (MEMORY_REVIEW_ACTIONS as readonly string[]).includes(v);
}

/** States each action may start from. `reverified` also needs the flag set. */
export const MEMORY_REVIEW_FROM: Record<MemoryReviewAction, readonly MemoryState[]> = {
  promote: ['candidate'],
  dismiss: ['candidate', 'active', 'expired'],
  reverified: ['candidate', 'active', 'expired', 'invalidated'],
};

export function memoryReviewActionAllowed(
  action: MemoryReviewAction,
  m: { state?: string | null; supersededBy?: string | null; reverifyFlaggedAt?: string | Date | null },
): boolean {
  if (m.supersededBy) return false;
  if (!MEMORY_REVIEW_FROM[action].includes(memoryStateOf(m))) return false;
  if (action === 'reverified' && !m.reverifyFlaggedAt) return false;
  return true;
}

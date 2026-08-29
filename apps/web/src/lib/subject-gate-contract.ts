/**
 * Shared subject-gate contract.
 *
 * The claim route enforces the gate in SQL (`api/workers/claim/subject-gate.ts` →
 * `subjectLivenessCondition()`); the dispatch loop enforces it in TypeScript
 * (`subjectStillLive()`); the display layer enforces it again in
 * `lib/task-presentation.ts`. All three import from here so they cannot drift —
 * the same reason `dep-gate-contract.ts` exists (PR #1867).
 *
 * WHY A SOURCE FILTER (the aeb80f incident):
 * `prepareSubjectFiling` derives a subject anchor from *prose* — "PR #1789" in a
 * description is enough to produce `{source:'text', confidence:'derived'}`. When
 * that PR closed, the reconciliation sweep stamped `subjectResolution =
 * 'reconciled'` and the claim gate removed the task from the claim query
 * forever. The task still rendered as a normal QUEUED row, and it was the root
 * of a 20-task dependency funnel — one background mention silently stalled a
 * whole workspace for 5 days.
 *
 * A mention is not an identity. Only anchors that genuinely *identify* the
 * task's subject may make a task mortal; everything else stays advisory (still
 * useful for dedupe and prior-work injection, never a claim gate).
 *
 * This module must stay dependency-free — it is imported by client components.
 */

/**
 * Anchor `source` values that BIND the task to its subject: the subject was
 * supplied by the system (retry/watcher machinery) or by structured request
 * context, not inferred from prose. These carry `confidence: 'exact'`.
 *
 * Deliberately excluded:
 *   - `text` / `url` — scraped from the title/description (`confidence:'derived'`).
 *     A task that merely *mentions* a PR must never become unclaimable.
 *   - `backfill` — retro-stamped by a migration over historic rows; the anchor
 *     was never asserted by the filer, so it must not gate claims either.
 */
export const SUBJECT_BINDING_SOURCES = ['system', 'context'] as const;
export type SubjectBindingSource = (typeof SUBJECT_BINDING_SOURCES)[number];

/**
 * The `confidence` value that marks an anchor as INFERRED rather than asserted.
 *
 * Source alone is not enough to make a task mortal. `source: 'context'` is
 * emitted by two different extractor paths (packages/core/subject-anchor-
 * extractor.ts): the legacy structured-context mapping, which is `exact`, and
 * an explicitly-passed API `subjectAnchor`, which defaults to
 * `confidence: 'derived'` because the server never resolved the reference
 * against GitHub. docs/design/task-subject-anchors.md is explicit about that
 * meaning — "Resolve it through GitHub before granting `exact` confidence" and
 * "tasks inferred from prose receive `confidence = derived` and can only run
 * with context until a human or GitHub lookup confirms them".
 *
 * So an API caller passing `subjectAnchor: { prNumber }` as a *hint* used to
 * get a task that the PR closing could kill — a smaller replay of the aeb80f
 * bug. Binding therefore requires BOTH: a binding source AND a confidence that
 * is not explicitly `derived`.
 *
 * The rule is "not derived" rather than "=== exact" on purpose: `confidence` is
 * a required field on every persisted anchor (TaskSubjectAnchor in
 * packages/shared), so absent-confidence only happens for hand-built or
 * pre-schema rows, and those must keep the behaviour they had. What we are
 * excluding is the anchor whose filer *told* us it was inferred.
 */
export const SUBJECT_ADVISORY_CONFIDENCE = 'derived' as const;

/**
 * The only `subjectResolution` value that means "this subject is dead" — set by
 * `sweepSubjectAnchoredTasks` when the subject PR closed/merged with no live
 * successor. Other resolutions (`attached`, `superseded`, `filed_anyway`) never
 * gate a claim.
 */
export const SUBJECT_DEAD_RESOLUTION = 'reconciled' as const;

/**
 * Context key written by `/api/tasks/[id]/start` when `forceOverride=true` and
 * the task is subject-dead. Mirrors `bypassDepsGate` / `bypassHeldGate`: it lets
 * a human force a single task past the gate without editing the anchor.
 */
export const BYPASS_SUBJECT_GATE_KEY = 'bypassSubjectGate' as const;

/** True when this anchor source is authoritative enough to gate claims. */
export function isBindingSubjectSource(source?: string | null): boolean {
  return !!source && (SUBJECT_BINDING_SOURCES as readonly string[]).includes(source);
}

/**
 * True when the whole anchor is authoritative enough to gate claims: a binding
 * source AND a confidence the filer did not mark as inferred.
 *
 * Prefer this over `isBindingSubjectSource` in any new consumer — the source is
 * only half the classification.
 */
export function isBindingSubjectAnchor(
  anchor?: { source?: string | null; confidence?: string | null } | null,
): boolean {
  if (!isBindingSubjectSource(anchor?.source)) return false;
  return anchor?.confidence !== SUBJECT_ADVISORY_CONFIDENCE;
}

/** True when the task carries a human force-start bypass for the subject gate. */
export function hasSubjectGateBypass(context?: Record<string, unknown> | null): boolean {
  const flag = context?.[BYPASS_SUBJECT_GATE_KEY];
  return flag === true || flag === 'true';
}

/** The persisted fields the subject gate reads. All optional — absent ⇒ no gate. */
export interface SubjectGateFields {
  subjectKind?: string | null;
  subjectPrNumber?: number | null;
  subjectResolution?: string | null;
  /**
   * The jsonb anchor. `source` lives ONLY here (there is no `subject_source`
   * column), so every consumer must select this column. A missing anchor reads
   * as advisory — fail open, never silently unclaimable.
   */
  subjectAnchor?: { source?: string | null; confidence?: string | null } | null;
  context?: Record<string, unknown> | null;
}

/**
 * TRUE when the subject gate makes this task unclaimable.
 *
 * All of the following must hold:
 *   - subject kind is `pull_request` and a PR number is persisted
 *   - `subjectResolution = 'reconciled'` (the sweep declared the PR dead)
 *   - the anchor's `source` is in SUBJECT_BINDING_SOURCES and its `confidence`
 *     is not `derived` (see SUBJECT_ADVISORY_CONFIDENCE)
 *   - no `bypassSubjectGate` force-start flag in context
 *
 * `subjectLivenessCondition()` is the SQL transcription of exactly this — keep
 * the two in lockstep.
 */
export function isSubjectDead(task: SubjectGateFields): boolean {
  if (task.subjectKind !== 'pull_request') return false;
  if (!task.subjectPrNumber) return false;
  if (task.subjectResolution !== SUBJECT_DEAD_RESOLUTION) return false;
  if (!isBindingSubjectAnchor(task.subjectAnchor)) return false;
  return !hasSubjectGateBypass(task.context);
}

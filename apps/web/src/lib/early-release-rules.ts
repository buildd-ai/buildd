/**
 * Early release — Layer 1: deterministic release rules.
 *
 * Three pure checks that can clear a dependent task to start before its
 * upstream task's PR merges, each named by the condition it detects rather
 * than by "release" — only one of the three ever fires per call, and a
 * caller reading a reasonCode off `dependency_releases` needs to know which
 * one, not that early release happened. See `knowledge-base:
 * buildd/design/early-release.md`.
 *
 * None of this touches a DB or the network: every input is data the caller
 * already fetched (the upstream PR's diff, the dependent's own declared
 * pathManifest, the dependent PR's review status and CI state). This file
 * is meant to become the `override()` of a `defineBuilddDecisionKind` later
 * — "a rule that fires is code, not a rollout" — but is NOT wired to any
 * route yet.
 *
 * `zeroManifestOverlap` must only be given the dependent's own
 * author-declared `pathManifest`, never a predicted one — a prediction is
 * shadow-only and would make this rule fire on a guess, not a fact.
 */

import { hasConcretePathManifest, pathsOverlap } from '@buildd/core/path-overlap';
import { evaluateReviewVerdictGate } from './review-verdict-gate';
import type { DecisionVerdict } from '@builddai/ai-kit/decide';

/** The only decision these rules ever produce: clear to start now. */
export type EarlyReleaseDecision = 'start_now';

/** One per rule — stable and machine-readable, written straight to `dependency_releases.reason_code`. */
export type EarlyReleaseReasonCode = 'docs_only' | 'zero_overlap' | 'terminal_approve';

export type EarlyReleaseVerdict = DecisionVerdict<EarlyReleaseDecision> & { reasonCode: EarlyReleaseReasonCode };

/** The review-status shape `evaluateReviewVerdictGate` needs, re-exported here so callers don't reach into that module for a type. */
export type ReviewVerdictGateInput = Parameters<typeof evaluateReviewVerdictGate>[0];

export interface EarlyReleaseRulesInput {
  /** Changed-file paths from the upstream task's PR diff. */
  upstreamChangedFiles: string[];
  /** The dependent task's own author-declared pathManifest. Never a predicted one. */
  dependentPathManifest: string[] | null | undefined;
  /** The dependent PR's review status, read at `currentHeadSha`. */
  reviewStatus: ReviewVerdictGateInput;
  /** The dependent PR's current head SHA — the commit that would actually land. */
  currentHeadSha: string | null | undefined;
  /** Whether every required CI check is green on `currentHeadSha`. */
  requiredChecksGreen: boolean;
}

/** `docs/**\/*.md` or a root-level `*.md` — the two doc-path shapes this rule accepts. */
const DOC_PATH_RE = /^(docs\/.*\.md|[^/]+\.md)$/;

function isDocPath(path: string): boolean {
  return DOC_PATH_RE.test(path);
}

/**
 * Fires when the upstream PR's entire diff is documentation — nothing it
 * changes can affect a dependent's code, whatever that code is. A special
 * case of `zeroManifestOverlap` (an all-docs diff trivially overlaps no
 * code manifest) kept separate because it is checkable the moment the
 * upstream PR opens, before the dependent has even declared a manifest.
 *
 * An empty changed-files list is not evidence of anything — fall through
 * rather than firing on no data.
 */
export function docsOnlyUpstream(upstreamChangedFiles: string[]): EarlyReleaseVerdict | null {
  if (upstreamChangedFiles.length === 0) return null;
  return upstreamChangedFiles.every(isDocPath) ? { decision: 'start_now', reasonCode: 'docs_only' } : null;
}

/**
 * Fires when the dependent's own declared scope shares no path with the
 * upstream PR's changed files — gated by `hasConcretePathManifest` so an
 * empty, wildcard or monorepo-root-wide manifest (which declares nothing
 * useful) can never satisfy this rule by default.
 */
export function zeroManifestOverlap(
  dependentPathManifest: string[] | null | undefined,
  upstreamChangedFiles: string[],
): EarlyReleaseVerdict | null {
  if (!hasConcretePathManifest(dependentPathManifest)) return null;
  if (pathsOverlap(dependentPathManifest as string[], upstreamChangedFiles)) return null;
  return { decision: 'start_now', reasonCode: 'zero_overlap' };
}

/**
 * Fires when the dependent PR itself already has a terminal approve on its
 * current head and every required check is green — at that point the
 * dependent is ready to land on its own merits, independent of whether the
 * upstream task has merged yet.
 *
 * Delegates staleness/in-flight handling to `evaluateReviewVerdictGate`
 * rather than re-deriving it, so this rule and the merge gate can never
 * disagree about what counts as a live approval.
 */
export function terminalApproveGreenCi(
  reviewStatus: ReviewVerdictGateInput,
  currentHeadSha: string | null | undefined,
  requiredChecksGreen: boolean,
): EarlyReleaseVerdict | null {
  if (reviewStatus.state !== 'approved' || !requiredChecksGreen) return null;
  const gate = evaluateReviewVerdictGate(reviewStatus, currentHeadSha);
  if (gate.blocks) return null;
  return { decision: 'start_now', reasonCode: 'terminal_approve' };
}

/**
 * Runs the three rules in order and returns the first verdict that fires,
 * or null when none do. Order matters only in that `docsOnlyUpstream` is
 * checked first since it needs the least data; the three are mutually
 * exclusive in practice, not in principle.
 */
export function evaluateEarlyReleaseRules(input: EarlyReleaseRulesInput): EarlyReleaseVerdict | null {
  return (
    docsOnlyUpstream(input.upstreamChangedFiles) ??
    zeroManifestOverlap(input.dependentPathManifest, input.upstreamChangedFiles) ??
    terminalApproveGreenCi(input.reviewStatus, input.currentHeadSha, input.requiredChecksGreen)
  );
}

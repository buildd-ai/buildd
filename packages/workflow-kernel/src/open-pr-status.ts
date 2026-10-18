/**
 * The `Buildd / Review approval` status for an open PR head the kernel does
 * not answer for (docs/specs/workflow-kernel-library.md §4, "Every open PR
 * carries it"). A kernel-owned head gets `landingStatusOf`; every other open
 * head in a linked repo gets one of these, so a required check never waits on
 * a context nothing will ever publish:
 *
 *  - a PR no delivery owns (a dependency bot's, one opened by hand, a draft):
 *    `pending`, "Review not requested" or "Review in progress". Never
 *    `success`: only a delivery's gate says a head may merge.
 *  - a frozen release candidate: the release gate's answer at its exact SHA,
 *    `success` only when every required candidate check passed on that SHA and
 *    the review gate for releases lets it through.
 *
 * Pure, like the rest of the gate: the host reads GitHub and the review state,
 * and publishes.
 */
import { LANDING_STATUS_CONTEXT, REVIEW_STATUS_TERMS as T, clip, landingStatusOf, shortHeadSha as short, type LandingStatus } from './landing-gate';
import type { KernelView } from './types';

/** Whether anyone asked buildd to review a PR no delivery owns. */
export type UnownedReview = 'not_requested' | 'in_progress';

/** The status on an open PR head no delivery owns: pending until a delivery exists, never success. */
export function unownedPrStatus(sha: string, review: UnownedReview): LandingStatus {
  const description = review === 'in_progress'
    ? `${T.inProgress}: ${short(sha)} is waiting for its review`
    : `${T.notRequested}: no buildd review covers ${short(sha)} yet`;
  return { state: 'pending', sha, description: clip(description) };
}

/** A required candidate check at the candidate's own SHA (`missing`: no run there yet). */
export type CandidateCheckState = 'passing' | 'pending' | 'failing' | 'missing';

/**
 * The review gate for releases at the candidate SHA: `pass` lets it through,
 * `pending` is a review not finished (or an approval of an earlier SHA waiting
 * for its re-review), `changes_requested` and `blocked` stand against it.
 */
export type CandidateReview =
  | { verdict: 'pass' }
  | { verdict: 'pending'; reason?: string | null }
  | { verdict: 'changes_requested' | 'blocked'; reason?: string | null };

export interface CandidateGateInput {
  /** The candidate's head: its frozen SHA. */
  sha: string;
  /** Each required candidate check, read on `sha` only. */
  checks: ReadonlyArray<{ name: string; state: CandidateCheckState }>;
  review: CandidateReview;
}

/**
 * A release candidate's status: `failure` when a required check failed on its
 * SHA or the review gate stands against it, `success` only when every required
 * check passed there (an empty list verifies nothing) and the review gate
 * passes, `pending` otherwise.
 */
export function releaseCandidateStatus(i: CandidateGateInput): LandingStatus {
  const at = short(i.sha);
  const status = (state: LandingStatus['state'], description: string): LandingStatus => ({ state, sha: i.sha, description: clip(description) });
  const failed = i.checks.filter((c) => c.state === 'failing').map((c) => c.name);
  if (failed.length) return status('failure', `${T.blocked}: release candidate ${at} failed ${failed.join(', ')}`);
  if (i.review.verdict === 'changes_requested') return status('failure', `${T.changesRequested}: ${i.review.reason || `a review asked for changes to ${at}`}`);
  if (i.review.verdict === 'blocked') return status('failure', `${T.blocked}: ${i.review.reason || 'a person has to decide'}`);
  const waiting = i.checks.filter((c) => c.state !== 'passing').map((c) => c.name);
  if (i.checks.length === 0) return status('pending', `${T.inProgress}: release candidate ${at} has no verification yet`);
  if (waiting.length) return status('pending', `${T.inProgress}: release candidate ${at} is waiting for ${waiting.join(', ')}`);
  if (i.review.verdict === 'pending') return status('pending', `${T.inProgress}: ${i.review.reason || `release candidate ${at} is waiting for its review`}`);
  return status('success', `${T.ready}: release candidate ${at} is verified`);
}

/**
 * Who answers for an open head, and what it says:
 *  - `kernel`: a live delivery at this head; the host has the kernel publish
 *    it (its `publish_landing_status` effect), never writes it itself.
 *  - `release_candidate`: the candidate gate above.
 *  - `host`: pending, written by the host. A delivery that has not seen this
 *    head yet (a push the floor has not imported) is review not started, so a
 *    success it gave an older head never carries over.
 */
export type OpenHeadAnswer = { by: 'kernel' | 'release_candidate' | 'host'; status: LandingStatus };

export function openHeadStatus(p: {
  sha: string;
  /** The delivery that owns the PR, when the kernel owns it. */
  view?: KernelView | null;
  /** Set when the PR is a frozen release candidate: its checks and review at `sha`. */
  candidate?: Omit<CandidateGateInput, 'sha'> | null;
  /** For a PR no delivery owns: whether a review was asked for. */
  review?: UnownedReview;
}): OpenHeadAnswer {
  const kernel = p.view ? landingStatusOf(p.view) : null;
  if (kernel && kernel.sha === p.sha) return { by: 'kernel', status: kernel };
  if (p.candidate) return { by: 'release_candidate', status: releaseCandidateStatus({ sha: p.sha, ...p.candidate }) };
  return { by: 'host', status: unownedPrStatus(p.sha, kernel ? 'in_progress' : p.review ?? 'not_requested') };
}

export interface OpenHead {
  repoFullName: string;
  prNumber: number;
  sha: string;
}

/**
 * Coverage of the open heads a pass read: which carry `Buildd / Review
 * approval` and which do not. `nothing_checked` is its own verdict, so a pass
 * that read no head never reads as covered.
 */
export interface StatusCoverage {
  context: string;
  checked: number;
  missing: OpenHead[];
  verdict: 'covered' | 'gaps' | 'nothing_checked';
}

export function statusCoverage(heads: ReadonlyArray<OpenHead & { shown: boolean }>): StatusCoverage {
  const missing = heads.filter((h) => !h.shown).map(({ repoFullName, prNumber, sha }) => ({ repoFullName, prNumber, sha }));
  const verdict = heads.length === 0 ? 'nothing_checked' : missing.length ? 'gaps' : 'covered';
  return { context: LANDING_STATUS_CONTEXT, checked: heads.length, missing, verdict };
}

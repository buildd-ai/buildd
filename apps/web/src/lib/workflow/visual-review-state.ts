/**
 * The one typed visual-review state of a mission, derived. Pure.
 *
 * Owner decision (docs/specs/mission-task-lifecycle.md, "Visual review"): visual
 * audit is an automatic, workspace-governed process and never a routine owner
 * prompt. Code decides impact deterministically; Jev is asked only about an
 * ambiguous finding; verification runs BEFORE the mission-to-trunk merge, so
 * `blocksMerge` is part of the state. The owner appears as `nextActor` only
 * where the policy asks (`ask`) or the review system itself needs setup.
 *
 * This extends the existing derivations rather than writing lifecycle: `review`
 * is read off the `VisualReviewModel` (`visual-review-model.ts`), `uiChange` off
 * the surface-audit gate, `policy` off `resolveVisualReviewPolicy`. Nothing here
 * writes. Surfaces consume it through `getMissionVisualReviewState`
 * (`visual-review-state-load.ts`) so none re-derives status from `phase`.
 */
import type { VisualReviewPhase } from '@buildd/shared';
import type { ResolvedVisualReviewPolicy } from './visual-review-policy';

export const MISSION_VISUAL_REVIEW_STATUSES = [
  'not_applicable', 'optional', 'needed', 'queued', 'running', 'findings', 'blocked', 'passed', 'waived',
] as const;
export type MissionVisualReviewStatus = (typeof MISSION_VISUAL_REVIEW_STATUSES)[number];

export type VisualReviewNextActor = 'system' | 'jev' | 'owner' | 'none';

export type VisualReviewBlockedCause =
  | 'no_browser_runner' | 'app_boot_failed' | 'preview_unavailable' | 'capture_auth' | 'stalled' | 'auditor_failed' | 'unknown';

export type VisualReviewCaptureConfigError = 'preview_unavailable' | 'protection_bypass_missing' | 'app_auth_not_configured';

export type IntegrationPrStage = 'open' | 'ready' | 'blocked' | 'merged';

export interface VisualReviewStateInput {
  policy: ResolvedVisualReviewPolicy;
  /** Did rendered UI change? `unknown` = the diff could not be read (fails open, never `no`). */
  uiChange: { state: 'yes' | 'no' | 'unknown'; source: 'manifest' | 'diff' | null; uiFiles: number };
  /** The latest visual-auditor task, null when none exists. */
  audit: { id: string; createdAt: string | null; errorType: string | null } | null;
  /** The slice of `VisualReviewModel` this reads; null when no model was loaded. */
  review: {
    phase: VisualReviewPhase;
    screens: number;
    effectiveIssues: number;
    awaitingHuman: number;
    openFixes: number;
    roundCapOpen: boolean;
    needsYouReason: 'question' | 'unsure' | 'round_cap' | null;
    captured: number;
    expected: number | null;
  } | null;
  /** The newest waiver a person recorded. */
  waiver: { reason: string; actorLabel: string | null; at: string } | null;
  branch: {
    headSha: string | null;
    base: string | null;
    integrationPr: { number: number; state: 'open' | 'merged' | 'closed'; ready: boolean; blocked: boolean } | null;
    /** UI-touching builder tasks are terminal. */
    workLanded: boolean;
  };
  captureConfigError?: VisualReviewCaptureConfigError | null;
  /** Automatic retries left for a system failure. Absent = one. */
  autoRetriesLeft?: number;
}

export interface MissionVisualReviewState {
  status: MissionVisualReviewStatus;
  /** Single source for the completion gate. */
  blocksCompletion: boolean;
  /** Verification precedes the mission-to-trunk merge: true while the integration PR is open and owes it. */
  blocksMerge: boolean;
  /** Required by policy and not yet passed or waived. */
  pendingVerification: boolean;
  nextActor: VisualReviewNextActor;
  policy: Pick<ResolvedVisualReviewPolicy, 'mode' | 'origin' | 'waiverAllowed' | 'locked'>;
  scope: { screens: number | null; uiFiles: number; source: 'manifest' | 'diff' | null; workLanded: boolean };
  progress?: { captured: number; expected: number | null };
  findings?: { issues: number; undecided: number; fixesOpen: number; stage: 'fixing' | 'needs_decision' };
  blocked?: { cause: VisualReviewBlockedCause; causeOwner: 'buildd' | 'workspace' | 'unknown'; autoRetriesLeft: number };
  waiver?: { reason: string; actorLabel: string | null; at: string; supersededBy: string | null };
  auditTaskId: string | null;
  branch: {
    headSha: string | null;
    base: string | null;
    integrationPr: { number: number; stage: IntegrationPrStage | 'closed' } | null;
    /** The integration PR already merged while verification is still owed: recover, do not gate. */
    postMergeRecovery: boolean;
  };
}

const t = (s: string | null | undefined): number => (s ? new Date(s).getTime() : 0);

function classifyBlocked(
  phase: VisualReviewPhase,
  captureConfigError: VisualReviewCaptureConfigError | null | undefined,
): { cause: VisualReviewBlockedCause; causeOwner: 'buildd' | 'workspace' | 'unknown' } | null {
  if (captureConfigError === 'preview_unavailable') return { cause: 'preview_unavailable', causeOwner: 'workspace' };
  if (captureConfigError) return { cause: 'capture_auth', causeOwner: 'workspace' };
  switch (phase) {
    case 'boot_failed': return { cause: 'app_boot_failed', causeOwner: 'unknown' };
    case 'stalled': return { cause: 'stalled', causeOwner: 'buildd' };
    case 'failed': return { cause: 'auditor_failed', causeOwner: 'buildd' };
    case 'no_browser_runner': return { cause: 'no_browser_runner', causeOwner: 'buildd' };
    default: return null;
  }
}

function integrationStage(pr: NonNullable<VisualReviewStateInput['branch']['integrationPr']>): IntegrationPrStage | 'closed' {
  if (pr.state === 'merged') return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.blocked) return 'blocked';
  return pr.ready ? 'ready' : 'open';
}

export function deriveMissionVisualReview(input: VisualReviewStateInput): MissionVisualReviewState {
  const { policy, audit, review, branch } = input;
  const required = policy.mode !== 'off';
  const pr = branch.integrationPr;
  const prStage = pr ? integrationStage(pr) : null;

  // A person's skip stands only while no audit has been started after it, and never under strict.
  const waiverActive = !!input.waiver && policy.waiverAllowed && !(audit && t(audit.createdAt) > t(input.waiver.at));
  const waiverSuperseded = !!input.waiver && !waiverActive && policy.waiverAllowed && !!audit;

  let status: MissionVisualReviewStatus;
  let nextActor: VisualReviewNextActor = 'none';
  let findings: MissionVisualReviewState['findings'];
  let blocked: MissionVisualReviewState['blocked'];
  let blockedActor: VisualReviewNextActor | null = null;

  const hasAudit = !!audit && !(review && review.phase === 'off');
  if (waiverActive) {
    status = 'waived';
  } else if (hasAudit && review) {
    const b = classifyBlocked(review.phase, input.captureConfigError);
    const retries = input.autoRetriesLeft ?? 1;
    if (b) {
      status = 'blocked';
      blocked = { ...b, autoRetriesLeft: retries };
      blockedActor = b.causeOwner === 'workspace' || retries <= 0 ? 'owner' : 'system';
    } else if (review.phase === 'waiting_deps' || review.phase === 'queued') {
      status = 'queued';
      nextActor = 'system';
    } else if (review.phase === 'capturing') {
      status = 'running';
      nextActor = 'system';
    } else if (review.phase === 'needs_you' || review.phase === 'fixing' || review.effectiveIssues > 0 || review.awaitingHuman > 0 || review.roundCapOpen) {
      status = 'findings';
      const fixing = review.openFixes > 0 && review.awaitingHuman === 0 && !review.roundCapOpen && review.phase !== 'needs_you';
      findings = {
        issues: review.effectiveIssues,
        undecided: review.awaitingHuman,
        fixesOpen: review.openFixes,
        stage: fixing || review.phase === 'fixing' ? 'fixing' : 'needs_decision',
      };
      // Ambiguity is Jev's; the owner is not a routine reviewer.
      nextActor = findings.stage === 'fixing' ? 'system' : 'jev';
    } else {
      status = 'passed';
    }
  } else if (input.uiChange.state === 'no') {
    status = 'not_applicable';
  } else if (input.uiChange.state === 'unknown' || !required) {
    status = 'optional';
  } else {
    status = 'needed';
    nextActor = policy.mode === 'ask' ? 'owner' : 'system';
  }
  if (blockedActor) nextActor = blockedActor;

  const unfinished = status === 'needed' || status === 'queued' || status === 'running' || status === 'findings' || status === 'blocked';
  const pendingVerification = required && unfinished;
  const merged = prStage === 'merged';
  const progress = status === 'running' && review ? { captured: review.captured, expected: review.expected } : undefined;

  return {
    status,
    blocksCompletion: pendingVerification,
    blocksMerge: pendingVerification && !!pr && !merged && prStage !== 'closed',
    pendingVerification,
    nextActor: required || status === 'waived' || status === 'passed' ? nextActor : 'none',
    policy: { mode: policy.mode, origin: policy.origin, waiverAllowed: policy.waiverAllowed, locked: policy.locked },
    scope: {
      screens: review && review.screens > 0 ? review.screens : null,
      uiFiles: input.uiChange.uiFiles,
      source: input.uiChange.source,
      workLanded: branch.workLanded,
    },
    ...(progress ? { progress } : {}),
    ...(findings ? { findings } : {}),
    ...(blocked ? { blocked } : {}),
    ...(input.waiver && (waiverActive || waiverSuperseded)
      ? { waiver: { ...input.waiver, supersededBy: waiverActive ? null : (audit?.id ?? null) } }
      : {}),
    auditTaskId: audit?.id ?? null,
    branch: {
      headSha: branch.headSha,
      base: branch.base,
      integrationPr: pr && prStage ? { number: pr.number, stage: prStage } : null,
      postMergeRecovery: merged && pendingVerification,
    },
  };
}

/**
 * A kernel delivery state as the integration PR fact `deriveMissionVisualReview`
 * reads. APPROVED / LANDING are ready to merge; ESCALATED, FAILED and a trunk
 * block are blocked; the rest are still open.
 */
export function integrationPrFromDeliveryState(
  number: number,
  deliveryState: string,
): NonNullable<VisualReviewStateInput['branch']['integrationPr']> {
  if (deliveryState === 'MERGED') return { number, state: 'merged', ready: true, blocked: false };
  if (deliveryState === 'CLOSED_UNMERGED' || deliveryState === 'SUPERSEDED' || deliveryState === 'ABANDONED') {
    return { number, state: 'closed', ready: false, blocked: false };
  }
  const ready = deliveryState === 'APPROVED' || deliveryState === 'LANDING';
  const blocked = deliveryState === 'ESCALATED' || deliveryState === 'FAILED' || deliveryState === 'BLOCKED_ON_TRUNK';
  return { number, state: 'open', ready, blocked };
}

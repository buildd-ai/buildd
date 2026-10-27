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
import { OPEN_TASK_STATUSES, isTerminalTaskStatus, type VisualReviewModel, type VisualReviewPhase } from '@buildd/shared';
import { parseVisualReviewSkipNote, type VisualReviewSkipReason } from '@buildd/core/surface-audit';
import type { ResolvedVisualReviewPolicy } from './visual-review-policy';
import type { ReviewCarry } from './visual-review-carry';

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
  audit: { id: string; createdAt: string | null; errorType: string | null; status?: string } | null;
  /** The slice of `VisualReviewModel` this reads; null when no model was loaded. */
  review: {
    phase: VisualReviewPhase;
    screens: number;
    effectiveIssues: number;
    awaitingHuman: number;
    openFixes: number;
    roundCapOpen: boolean;
    needsYouReason: 'question' | 'unsure' | 'round_cap' | 'fix_check' | null;
    captured: number;
    expected: number | null;
    /** For `waiting_on_failed_work`: the failed build task the audit waits on. */
    waitingOn?: { taskId: string; title: string | null } | null;
    /**
     * Screens whose fix merged with no screenshot since (`VisualReviewModel.recapture`,
     * spec 072de598 I-15), as `recaptureScreenLabel` names them, and who takes the next step.
     */
    recapture?: VisualReviewRecaptureState | null;
    /** Cells waiting on a new screenshot (`summary.awaitingCapture`): counted in `effectiveIssues`, not open findings of their own. */
    awaitingCapture?: number;
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
  /**
   * The commit the latest audit looked at (`readAuditedSha`). Absent = the
   * caller does not track evidence commits and nothing goes stale. Present
   * (even null) with a known `branch.headSha`: a pass only holds for the same
   * commit, and an audit that recorded none cannot prove it.
   */
  auditedSha?: string | null;
  /** The scheduler's path-diff judgement of the latest audit against the current head (`judgeReviewCarry`); ignored unless it names this head and this audit's commit. */
  carry?: ReviewCarry | null;
  /**
   * The mission is completed or archived. Its completion gate already ran, and
   * the scheduler files nothing for a closed mission, so a pass on an earlier
   * commit is reported as exactly that (`passedOnEarlierCommit`), never as a
   * check that will run again.
   */
  missionClosed?: boolean;
}

/** Screens a merged fix waits on a new screenshot of (spec 072de598 I-15). */
export interface VisualReviewRecaptureState {
  /** `queued`: an audit that will take them is queued or running. `capture`: one is filed next. `decide`: a person decides. */
  next: 'queued' | 'capture' | 'decide';
  /** `recaptureScreenLabel` of each, in model order. */
  screens: string[];
  /** Their routes, for the recapture audit's required routes. */
  routes: string[];
}

/** One screen to re-shoot, as every surface names it: `/app/x · dialog-state · phone`. */
export function recaptureScreenLabel(s: { route: string; viewport: 'mobile' | 'desktop'; state: string | null; variant?: string | null }): string {
  return [s.route, s.state ?? s.variant ?? null, s.viewport === 'mobile' ? 'phone' : 'desktop'].filter(Boolean).join(' · ');
}

/**
 * The slice of the review model the state reads. The one mapping: the loader
 * and every test go through it, so a surface's count cannot come from a
 * second reading of the model (spec 072de598 AC-14).
 */
export function reviewInputFromModel(model: VisualReviewModel): NonNullable<VisualReviewStateInput['review']> {
  return {
    phase: model.phase,
    screens: model.summary.shots,
    effectiveIssues: model.summary.effectiveIssues,
    awaitingHuman: model.summary.awaitingHuman,
    openFixes: model.fixTasks.filter(f => !isTerminalTaskStatus(f.status)).length,
    roundCapOpen: model.roundCapOpen,
    needsYouReason: model.needsYou?.reason ?? null,
    captured: model.progress?.captured ?? 0,
    expected: model.progress?.expected ?? null,
    waitingOn: model.waitingOn ?? null,
    recapture: model.recapture
      ? { next: model.recapture.next, screens: model.recapture.screens.map(recaptureScreenLabel), routes: model.recapture.screens.map(s => s.route) }
      : null,
    awaitingCapture: model.summary.awaitingCapture ?? 0,
  };
}

export interface MissionVisualReviewState {
  status: MissionVisualReviewStatus;
  /** Single source for the completion gate. */
  blocksCompletion: boolean;
  /** Verification precedes the mission-to-trunk merge: true while the integration PR is open and owes it. */
  blocksMerge: boolean;
  /** Required by policy and not yet passed or waived. */
  pendingVerification: boolean;
  /** The audit passed on an older commit than the branch head now is: a new review is owed, the old pass is not evidence. */
  staleEvidence: boolean;
  /**
   * A closed mission whose last pass judged an earlier commit than the one it
   * delivered. Status stays `passed` (the completion gate accepted it and
   * nothing re-checks a closed mission) and `staleEvidence` stays true: the
   * delivered commit was not checked, and every surface says so.
   */
  passedOnEarlierCommit: boolean;
  /** The commit the latest audit judged, when it recorded one. */
  evidenceSha: string | null;
  /** The review still stands for this head because no UI the mission owns changed since this commit. */
  carriedFrom?: string;
  /** The review was voided by these UI files changing since the reviewed commit. */
  uiDelta?: string[];
  nextActor: VisualReviewNextActor;
  policy: Pick<ResolvedVisualReviewPolicy, 'mode' | 'origin' | 'waiverAllowed' | 'locked'>;
  scope: { screens: number | null; uiFiles: number; source: 'manifest' | 'diff' | null; workLanded: boolean; /** What the impact read said: `unknown` when the builders' files could not be read. */ impact?: 'yes' | 'no' | 'unknown' };
  progress?: { captured: number; expected: number | null };
  findings?: { issues: number; undecided: number; fixesOpen: number; stage: 'fixing' | 'needs_decision'; /** The automatic fix rounds ran out and the audit still finds issues: a person's call. */ exhausted: boolean };
  blocked?: { cause: VisualReviewBlockedCause; causeOwner: 'buildd' | 'workspace' | 'unknown'; autoRetriesLeft: number };
  /**
   * A person's Skip (spec 072de598 I-7, I-18). It stands until a person
   * withdraws it: a later audit, a base refresh or a new commit does not undo
   * it. `skipReason` is the button they pressed (null for a free-text waiver);
   * `openFindings` are the review's open findings now, shown under the Skip as
   * information (accepted, under Ship it anyway), never as a blocker.
   */
  waiver?: {
    reason: string;
    actorLabel: string | null;
    at: string;
    skipReason: VisualReviewSkipReason | null;
    note: string | null;
    openFindings: number;
  };
  auditTaskId: string | null;
  /**
   * A queued audit that never ran because build work it depends on failed
   * (spec 072de598 I-14): that task. Not a check failure, so `blocked` is
   * absent and nothing here offers a retry; the recovery is on this task.
   */
  waitingOn?: { taskId: string; title: string | null };
  /** Screens a merged fix waits on a new screenshot of, and who takes the next step (spec 072de598 I-15). */
  recapture?: VisualReviewRecaptureState;
  /** The claim loop's newest refusal reason for a queued audit (gate_events), when the loader read one. */
  holdReason?: string | null;
  /**
   * The scheduler would not file the audit this state is waiting for (round
   * cap, cancelled on this commit, retries used up, capture
   * setup). Without it a `needed` state reads as "system next" while nothing
   * will ever run; with it a person is told why and who acts.
   */
  scheduleBlock?: { cause: string; reason: string };
  branch: {
    headSha: string | null;
    base: string | null;
    integrationPr: { number: number; stage: IntegrationPrStage | 'closed' } | null;
    /** The integration PR already merged while verification is still owed: recover, do not gate. */
    postMergeRecovery: boolean;
  };
}

function skipOf(body: string): { skipReason: VisualReviewSkipReason | null; note: string | null } {
  const { reason, note } = parseVisualReviewSkipNote(body);
  return { skipReason: reason, note };
}

/** Audit task statuses that are still to run or running. */
const OPEN_AUDIT: ReadonlySet<string> = new Set(OPEN_TASK_STATUSES);

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

  // A person's Skip stands until a person withdraws it (I-18): a later audit
  // round, a base refresh or a new commit does not undo it. Never under strict.
  const waiverActive = !!input.waiver && policy.waiverAllowed;

  let status: MissionVisualReviewStatus;
  let nextActor: VisualReviewNextActor = 'none';
  let findings: MissionVisualReviewState['findings'];
  let blocked: MissionVisualReviewState['blocked'];
  let blockedActor: VisualReviewNextActor | null = null;
  let staleEvidence = false;
  let carriedFrom: string | undefined;
  let uiDelta: string[] | undefined;
  let passedOnEarlierCommit = false;
  let waitingOn: MissionVisualReviewState['waitingOn'];
  const recapture = review?.recapture && review.recapture.screens.length > 0 ? review.recapture : null;
  // Findings besides the screens waiting on a new screenshot: those are not a decision for anyone yet.
  const otherFindings = !!review && (
    review.phase === 'needs_you' || review.phase === 'fixing' || review.awaitingHuman > 0 || review.roundCapOpen || review.openFixes > 0
    || review.effectiveIssues > (recapture ? review.awaitingCapture ?? recapture.screens.length : 0));

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
    } else if (review.phase === 'waiting_on_failed_work') {
      // Waits on the failed task, whose own recovery is the way on: no actor here.
      status = 'queued';
      waitingOn = review.waitingOn ?? undefined;
    } else if (review.phase === 'waiting_deps' || review.phase === 'queued') {
      status = 'queued';
      nextActor = 'system';
    } else if (review.phase === 'capturing') {
      status = 'running';
      nextActor = 'system';
    } else if (recapture?.next === 'capture' && !otherFindings) {
      // A fix merged and the last audit did not re-shoot its screen: the
      // scheduler files one capture of exactly that screen (spec 072de598 I-15).
      status = 'needed';
      nextActor = 'system';
    } else if (review.phase === 'needs_you' || review.phase === 'fixing' || review.effectiveIssues > 0 || review.awaitingHuman > 0 || review.roundCapOpen) {
      status = 'findings';
      const fixing = review.openFixes > 0 && review.awaitingHuman === 0 && !review.roundCapOpen && review.phase !== 'needs_you';
      findings = {
        issues: review.effectiveIssues,
        undecided: review.awaitingHuman,
        fixesOpen: review.openFixes,
        stage: fixing || review.phase === 'fixing' ? 'fixing' : 'needs_decision',
        // No automatic step is left: the round cap, or a merged fix no screenshot will be taken of.
        exhausted: review.roundCapOpen || recapture?.next === 'decide',
      };
      // Ambiguity is Jev's; the owner is not a routine reviewer. Only when the
      // automatic fix rounds are spent and the audit still finds issues is it theirs.
      nextActor = findings.exhausted ? 'owner' : findings.stage === 'fixing' ? 'system' : 'jev';
    } else if (input.auditedSha !== undefined && input.uiChange.state !== 'no' && branch.headSha && input.auditedSha !== branch.headSha) {
      // Same-commit evidence only, unless the mission's own UI did not move since: a pass on another commit (or on none we can name) is not a pass for this head.
      const carry = input.carry && input.auditedSha && input.carry.headSha === branch.headSha.toLowerCase() && input.carry.from === input.auditedSha.toLowerCase()
        ? input.carry : null;
      if (carry?.state === 'carried') {
        carriedFrom = carry.from;
        status = 'passed';
      } else {
      staleEvidence = true;
      if (carry?.state === 'changed' && carry.files.length > 0) uiDelta = carry.files;
      if (input.missionClosed) {
        // Closed: nothing re-checks it. Say what was checked, never that it checks again.
        passedOnEarlierCommit = true;
        status = 'passed';
      } else {
        status = 'needed';
        nextActor = policy.mode === 'ask' ? 'owner' : 'system';
      }
      }
    } else {
      status = 'passed';
    }
  } else if (audit && audit.status && OPEN_AUDIT.has(audit.status)) {
    // An audit still open holds the mission whatever the impact read said,
    // including when the builders' files could not be read (c9353c11).
    status = 'queued';
    nextActor = 'system';
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
    staleEvidence,
    passedOnEarlierCommit,
    evidenceSha: input.auditedSha ?? null,
    ...(carriedFrom ? { carriedFrom } : {}),
    ...(uiDelta ? { uiDelta } : {}),
    nextActor: required || status === 'waived' || status === 'passed' ? nextActor : 'none',
    policy: { mode: policy.mode, origin: policy.origin, waiverAllowed: policy.waiverAllowed, locked: policy.locked },
    scope: {
      screens: review && review.screens > 0 ? review.screens : null,
      uiFiles: input.uiChange.uiFiles,
      source: input.uiChange.source,
      impact: input.uiChange.state,
      workLanded: branch.workLanded,
    },
    ...(progress ? { progress } : {}),
    ...(findings ? { findings } : {}),
    ...(blocked ? { blocked } : {}),
    ...(input.waiver && waiverActive
      ? { waiver: { ...input.waiver, ...skipOf(input.waiver.reason), openFindings: review?.effectiveIssues ?? 0 } }
      : {}),
    auditTaskId: audit?.id ?? null,
    ...(waitingOn ? { waitingOn } : {}),
    ...(recapture && status !== 'waived' && status !== 'passed' ? { recapture: { next: recapture.next, screens: recapture.screens, routes: recapture.routes } } : {}),
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

/** `context.visualReview.headSha`: the commit an audit was stamped to look at. Null when unstamped. */
export function readAuditedSha(auditContext: unknown): string | null {
  const vr = auditContext && typeof auditContext === 'object' && !Array.isArray(auditContext)
    ? (auditContext as Record<string, unknown>).visualReview
    : null;
  const sha = vr && typeof vr === 'object' ? (vr as Record<string, unknown>).headSha : null;
  return typeof sha === 'string' && /^[0-9a-f]{7,40}$/i.test(sha) ? sha.toLowerCase() : null;
}

const CAPTURE_CONFIG_ERRORS: readonly VisualReviewCaptureConfigError[] = ['protection_bypass_missing', 'app_auth_not_configured', 'preview_unavailable'];

/**
 * The capture setup error an audit reported, read from its failure text. Only a
 * named code counts: a setup problem is the workspace's to fix and never worth
 * an automatic retry, so a loose match that sent a transient error to the owner
 * would be the worse mistake.
 */
export function captureConfigErrorFrom(text: unknown): VisualReviewCaptureConfigError | null {
  const s = typeof text === 'string' ? text : text && typeof text === 'object' ? JSON.stringify(text) : '';
  return CAPTURE_CONFIG_ERRORS.find(code => s.includes(code)) ?? null;
}

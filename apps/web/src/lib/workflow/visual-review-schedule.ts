/**
 * When does a mission's visual review get filed, re-filed or surfaced as
 * blocked? Pure: the server half (`visual-review-schedule-run.ts`) loads the
 * facts and executes the answer.
 *
 * Owner decision (docs/specs/mission-task-lifecycle.md, "Visual review"): the
 * review is automatic, never a routine owner prompt. The classifier
 * (`assessVisualImpact`) decides whether the integration branch owes one; this
 * decides whether one is already on it, and when to file the next. It does not
 * create a second path: the answer is executed by `requestMissionSurfaceAudit`,
 * which is idempotent on the audit task.
 *
 *  - never double-file: a live audit is the answer, whatever head it was stamped for;
 *  - a new head SHA with UI impact re-files (the old pass is not evidence), up to a ceiling;
 *  - a system failure (the audit task failed: browser, preview, runner) retries with
 *    exponential backoff, a bounded number of times, then names who acts next;
 *  - a product finding is never a retry: it is a `[surface fix]` and the findings loop's;
 *  - no browser to claim it names the owner rather than leaving the mission waiting unseen.
 */
import { MAX_TOTAL_SURFACE_AUDIT_ROUNDS } from '@buildd/core/surface-audit';
import type { MissionVisualReviewState, VisualReviewCaptureConfigError, VisualReviewNextActor } from './visual-review-state';

/** Automatic attempts per head SHA before a person is told (the first attempt counts). */
export const MAX_AUTO_ATTEMPTS_PER_HEAD = 3;
/** Wait after the first failure; each further failure triples it. */
export const RETRY_BACKOFF_BASE_MS = 5 * 60_000;
export const RETRY_BACKOFF_CAP_MS = 60 * 60_000;

export const retryBackoffMs = (failuresSoFar: number): number =>
  Math.min(RETRY_BACKOFF_CAP_MS, RETRY_BACKOFF_BASE_MS * 3 ** Math.max(0, failuresSoFar - 1));

/** Attempts still available for a head; feeds `VisualReviewStateInput.autoRetriesLeft`. */
export const autoRetriesLeft = (failedAttemptsOnHead: number): number =>
  Math.max(0, MAX_AUTO_ATTEMPTS_PER_HEAD - failedAttemptsOnHead);

export interface ScheduleAudit {
  id: string;
  status: string;
  round: number;
  /** `readAuditedSha(context)`: the head the audit is stamped for. */
  headSha: string | null;
  updatedAt: number;
  /** A named capture setup error in a failed audit's result (`captureConfigErrorFrom`). */
  captureConfigError?: VisualReviewCaptureConfigError | null;
}

export interface ScheduleInput {
  state: Pick<MissionVisualReviewState, 'status' | 'policy' | 'branch' | 'scope'>;
  /** The classifier's verdict for the current head, or null when it was not (or could not be) assessed. */
  impact: { verdict: 'review_required' | 'not_applicable'; headSha: string | null } | null;
  /** Newest first. */
  audits: ScheduleAudit[];
  browserRunnerOnline: boolean | null;
  executorLocal: boolean;
  now: number;
}

export type BlockedCause = 'executor_local' | 'capture_config' | 'retries_exhausted' | 'audit_cancelled' | 'rereview_cap' | 'head_unknown';

export type ScheduleAction =
  | { action: 'none'; why: 'policy_off' | 'ask_policy' | 'not_applicable' | 'work_not_landed' | 'no_integration_head' | 'passed' | 'waived' | 'findings_open' | 'audit_live' }
  /** A live audit exists but is stamped for an older head and has not started: stamp it for this one. */
  | { action: 'restamp'; auditId: string; headSha: string }
  /** Backing off after a system failure. */
  | { action: 'wait'; until: number; attempt: number }
  | {
      action: 'enqueue';
      headSha: string;
      round: number;
      reason: 'first' | 'new_head' | 'retry' | 'post_merge_recovery';
      /** 1-based attempt on this head. */
      attempt: number;
      /** Filed anyway (it will wait in the queue), but a person must know no browser is online. */
      runnerNote: 'no_browser_runner' | null;
    }
  | { action: 'blocked'; cause: BlockedCause; nextActor: Exclude<VisualReviewNextActor, 'jev' | 'none' | 'system'>; reason: string };

const isLive = (a: ScheduleAudit) => a.status !== 'failed' && a.status !== 'cancelled';

export function planVisualReviewSchedule(input: ScheduleInput): ScheduleAction {
  const { state, impact, audits, now } = input;
  const mode = state.policy.mode;
  if (mode === 'off') return { action: 'none', why: 'policy_off' };
  // `ask` is the one policy where a person chooses; nothing is filed on their behalf.
  if (mode === 'ask') return { action: 'none', why: 'ask_policy' };
  if (state.status === 'waived') return { action: 'none', why: 'waived' };
  if (!state.scope.workLanded) return { action: 'none', why: 'work_not_landed' };

  const head = state.branch.headSha;
  if (!head) return { action: 'none', why: 'no_integration_head' };

  // Applicability is about this head only: a current "not applicable" rules the review out, a stale or missing one never does.
  if (impact && impact.headSha === head && impact.verdict === 'not_applicable') return { action: 'none', why: 'not_applicable' };

  if (state.status === 'passed') return { action: 'none', why: 'passed' };
  if (state.status === 'not_applicable') return { action: 'none', why: 'not_applicable' };
  if (state.status === 'findings') return { action: 'none', why: 'findings_open' };

  const latest = audits[0] ?? null;

  // Never double-file: an audit that is queued or running is the review.
  const open = audits.find(a => isLive(a) && a.status !== 'completed');
  if (open) {
    if (open.status === 'pending' && open.headSha !== head) return { action: 'restamp', auditId: open.id, headSha: head };
    return { action: 'none', why: 'audit_live' };
  }

  if (latest?.status === 'failed' && latest.captureConfigError) {
    return { action: 'blocked', cause: 'capture_config', nextActor: 'owner', reason: 'The workspace\'s page source needs setup before the screens can be captured.' };
  }
  if (input.executorLocal) {
    return { action: 'blocked', cause: 'executor_local', nextActor: 'owner', reason: 'This mission runs on a local executor, so buildd\'s runners will not pick the review up.' };
  }

  // A person cancelling the review is a decision about this head. A new head is a new question.
  if (latest?.status === 'cancelled' && latest.headSha === head) {
    return { action: 'blocked', cause: 'audit_cancelled', nextActor: 'owner', reason: 'The visual review was cancelled on this commit.' };
  }

  const onHead = audits.filter(a => a.headSha === head);
  const failedOnHead = onHead.filter(a => a.status === 'failed');
  if (failedOnHead.length >= MAX_AUTO_ATTEMPTS_PER_HEAD) {
    return { action: 'blocked', cause: 'retries_exhausted', nextActor: 'owner', reason: `The visual review failed ${failedOnHead.length} times on this commit; automatic retries are used up.` };
  }
  const lastFailure = failedOnHead[0] ?? null;
  if (lastFailure) {
    const until = lastFailure.updatedAt + retryBackoffMs(failedOnHead.length);
    if (now < until) return { action: 'wait', until, attempt: failedOnHead.length + 1 };
  }

  const completed = audits.filter(a => a.status === 'completed');
  const maxRound = audits.reduce((m, a) => Math.max(m, a.round), 0);
  const isRetry = !!lastFailure;
  const round = isRetry ? lastFailure!.round : maxRound + 1;
  if (!isRetry && round > MAX_TOTAL_SURFACE_AUDIT_ROUNDS) {
    return { action: 'blocked', cause: 'rereview_cap', nextActor: 'owner', reason: `${completed.length} review rounds have run; a new one is not filed automatically.` };
  }

  return {
    action: 'enqueue',
    headSha: head,
    round: Math.max(1, round),
    // Merged without the review: it runs as a post-merge audit and says so; it is never passed off as pre-merge assurance.
    reason: state.branch.postMergeRecovery ? 'post_merge_recovery' : isRetry ? 'retry' : audits.length === 0 ? 'first' : 'new_head',
    attempt: failedOnHead.length + 1,
    runnerNote: input.browserRunnerOnline === false ? 'no_browser_runner' : null,
  };
}

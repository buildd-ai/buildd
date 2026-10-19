/**
 * A completed reviewer's verdict on its kernel round, sent so that it is never dropped
 * (docs/specs/workflow-state-kernel.md T6, T27; 7105282e).
 *
 * The runner reports a verdict once, in its completion PATCH. The door already parks a command the
 * control plane never answered, under its key, for the floor to re-send (command-outbox.ts). Two
 * gaps were left: each call made a fresh key, so a second try was a different command to the
 * ledger; and an unanswered command that could not be parked was logged and lost. Here every
 * submission of one reviewer's verdict on one round carries the same key, and a command the
 * control plane did not apply (`not_applied`) is sent once more before giving up. Whatever is
 * still unrecorded after that is the floor's: a round whose reviewer ended and that nothing
 * settled is failed through T27 (seam.ts `reconcileKernelDeliveries`).
 */
import { ControlPlaneUnavailableError, recordReviewVerdict, type DoorCall, type KernelPrincipal } from './kernel-client';
import type { KernelOps } from './command-api';

type VerdictInput = KernelOps['record_review_verdict']['input'];
type VerdictAnswer = KernelOps['record_review_verdict']['result'];

/** Submissions of one verdict from the PATCH before it is left to the floor. */
export const VERDICT_SUBMIT_ATTEMPTS = 2;

/** One reviewer's verdict on one round: the same command to the ledger however often it is sent. */
export function reviewVerdictKey(reviewerTaskId: string, roundId: string): string {
  return `record_review_verdict:${reviewerTaskId}:${roundId}`.replace(/[^A-Za-z0-9:._-]/g, '_').slice(0, 200);
}

export type VerdictSubmission =
  | { status: 'answered'; answer: VerdictAnswer }
  /** The control plane did not answer; the command is parked under its key and the floor re-sends it. */
  | { status: 'parked'; why: string }
  /** Not recorded and not parked: the floor fails the round once its reviewer has been ended a while. */
  | { status: 'unrecorded'; error: string };

export async function submitReviewVerdict(
  input: VerdictInput,
  c: { principal: KernelPrincipal | null; record?: (p: VerdictInput, c: DoorCall) => Promise<VerdictAnswer> },
): Promise<VerdictSubmission> {
  const roundId = String((input.reviewerTask.context as { workflowRoundId?: unknown } | null)?.workflowRoundId ?? 'none');
  const idempotencyKey = reviewVerdictKey(input.reviewerTask.id, roundId);
  const record = c.record ?? recordReviewVerdict;
  let last: unknown = null;
  for (let attempt = 0; attempt < VERDICT_SUBMIT_ATTEMPTS; attempt++) {
    try {
      return { status: 'answered', answer: await record(input, { principal: c.principal, idempotencyKey }) };
    } catch (err) {
      last = err;
      if (err instanceof ControlPlaneUnavailableError && err.parked) return { status: 'parked', why: err.why };
      // Only a command that provably did not run is sent again here. One that may have run
      // (`unknown`) was already asked again by the door under this key; a refusal or the
      // command's own failure would answer the same.
      if (!(err instanceof ControlPlaneUnavailableError) || err.outcome !== 'not_applied') break;
    }
  }
  return { status: 'unrecorded', error: last instanceof Error ? last.message : String(last) };
}

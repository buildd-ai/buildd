/**
 * Question-gate claim-route glue (see packages/core/question-gate.ts).
 *
 * A pure capability marker now: a runner that sent the `question_gate`
 * feature gets a `questionGate` marker on every claimed worker, unconditionally
 * — the gate used to apply only under a running `question_gate` experiment's
 * arm draw; it no longer does (that plumbing is gone, see question-gate.ts's
 * module doc). The claimed worker then routes AskUserQuestion through
 * POST /api/workers/[id]/question-check before parking it; that route (and the
 * workspace's `jevQuestionGate` kill switch it reads) decides what actually
 * happens, not this marker.
 */
import type { ClaimTasksResponse } from '@buildd/shared';
import { DEFAULT_QUESTION_GATE_MAX_PUSHBACKS, QUESTION_GATE_RUNNER_FEATURE } from '@buildd/core/question-gate';

export function attachQuestionGate(
  claimedWorkers: ClaimTasksResponse['workers'],
  runner: { features: readonly string[] | undefined },
): void {
  if (!runner.features?.includes(QUESTION_GATE_RUNNER_FEATURE)) return;
  for (const cw of claimedWorkers) {
    cw.questionGate = { maxPushbacks: DEFAULT_QUESTION_GATE_MAX_PUSHBACKS };
  }
}

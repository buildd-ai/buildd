import { labelDecisionOutcome } from '@buildd/core/decision-outcomes';
import { DECIDED_SUBJECT_TYPE } from './question-gate-check';

/**
 * Attach the task's terminal status to every question the worker had Jev
 * decide (`question_gate` rows filed under the worker subject). Source
 * `task_terminal`; relabelling the same status is a no-op, a different one
 * is reported as a conflict and not rewritten (`labelDecisionOutcome`).
 *
 * CALL SITE (follow-up, not wired here): the worker's terminal transition in
 * `apps/web/src/app/api/workers/[id]/route.ts` PATCH, where `status` becomes
 * completed / failed. Pass the worker's teamId, id and the status.
 */
export async function labelDecidedQuestionOutcomes(
  input: { teamId: string; workerId: string; terminalStatus: string },
  deps: { label?: typeof labelDecisionOutcome } = {},
) {
  const label = deps.label ?? labelDecisionOutcome;
  return label({
    teamId: input.teamId,
    capability: 'question_gate',
    subject: { type: DECIDED_SUBJECT_TYPE, id: input.workerId },
    source: 'task_terminal',
    label: input.terminalStatus,
  });
}

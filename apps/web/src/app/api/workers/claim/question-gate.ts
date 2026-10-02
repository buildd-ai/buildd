/**
 * Question-gate experiment, claim-route glue (see packages/core/question-gate.ts).
 *
 * A no-op unless the runner sent the `question_gate` feature and the task's
 * team runs a `question_gate` experiment. Then the claimed worker carries a
 * `questionGate` marker, and the runner routes AskUserQuestion through
 * POST /api/workers/[id]/question-check before parking it. Never throws,
 * never defers: any failure leaves the marker off, which is today's flow.
 *
 * Enrolment (the assignment row) is written at the first check, not here:
 * the population is tasks that asked something.
 */
import type { ClaimTasksResponse } from '@buildd/shared';
import { QUESTION_GATE_RUNNER_FEATURE, type QuestionGateArmDecision } from '@buildd/core/question-gate';

export async function attachQuestionGate(
  claimedWorkers: ClaimTasksResponse['workers'],
  runner: { features: readonly string[] | undefined },
  deps: { resolveArm?: (teamId: string, taskId: string) => Promise<QuestionGateArmDecision | null> } = {},
): Promise<void> {
  if (!runner.features?.includes(QUESTION_GATE_RUNNER_FEATURE)) return;
  try {
    const resolveArm = deps.resolveArm ?? (async (teamId: string, taskId: string) => {
      const { resolveQuestionGateArm } = await import('@buildd/core/question-gate-source');
      return resolveQuestionGateArm(teamId, taskId);
    });
    for (const cw of claimedWorkers) {
      const task = cw.task as { id?: string; workspace?: { teamId?: string | null } } | undefined;
      const teamId = task?.workspace?.teamId;
      if (!task?.id || !teamId) continue;
      const arm = await resolveArm(teamId, task.id);
      if (!arm) continue;
      cw.questionGate = {
        experimentId: arm.experimentId,
        policyVersion: arm.policyVersion,
        arm: arm.arm,
        maxPushbacks: arm.maxPushbacks,
      };
    }
  } catch (e) {
    console.warn('[question-gate] claim marker skipped:', e);
  }
}

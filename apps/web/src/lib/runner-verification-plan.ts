import { isCriterionCheckTask } from '@/lib/specs/criterion-checks';
import { criterionBatchOf, type CriterionBatchCheck } from '@buildd/shared';

/**
 * Whether the cloud Worker should run a finished task's check command itself,
 * and which command (/api/runner/verification-run).
 *
 * Only a verification run gets one: a spec criterion check or a mission
 * `command` goal criterion, the two whose verdict must be the runner's exit
 * code and which take a late runner report (lib/late-runner-evidence.ts).
 * The command is resolved the way the runner resolves it
 * (apps/runner/src/runner-verification.ts resolveCommand): the loop's exit
 * condition first, then context.verificationCommand. A mission's criterion
 * batch is planned as its head and every criterion's command and limit.
 */
export type VerificationRunPlan =
  | { run: true; command: string; iteration: number }
  | { run: true; batch: { headSha: string; checks: CriterionBatchCheck[] }; iteration: number }
  | { run: false; reason: 'not_a_verification_run' | 'no_command' };

export function verificationRunPlan(task: {
  context: unknown;
  loopConfig: unknown;
  loopIteration?: number | null;
}): VerificationRunPlan {
  const batch = criterionBatchOf(task.context);
  if (batch) return { run: true, batch: { headSha: batch.headSha, checks: batch.checks }, iteration: 0 };
  if (!isCriterionCheckTask(task.context) && !isCriteriaVerificationTask(task.context)) {
    return { run: false, reason: 'not_a_verification_run' };
  }
  const exit = (task.loopConfig as { exitCondition?: { type?: unknown; command?: unknown } } | null)?.exitCondition;
  if (exit?.type !== 'command') return { run: false, reason: 'no_command' };
  const fromExit = typeof exit.command === 'string' ? exit.command.trim() : '';
  const fromContext = (task.context as { verificationCommand?: unknown } | null)?.verificationCommand;
  const command = fromExit || (typeof fromContext === 'string' ? fromContext.trim() : '');
  if (!command) return { run: false, reason: 'no_command' };
  return { run: true, command, iteration: task.loopIteration ?? 0 };
}

/**
 * True when this task is a mission criteria verification task (cheap context
 * check on the `criteriaVerification` marker). Re-exported by
 * lib/mission-criteria-verify.ts; defined here so core needs no import of it.
 */
export function isCriteriaVerificationTask(context: unknown): boolean {
  const marker = (context as Record<string, unknown> | null)?.criteriaVerification as
    | { missionId?: unknown; criterionIndex?: unknown }
    | undefined;
  return typeof marker?.missionId === 'string' && typeof marker.criterionIndex === 'number';
}

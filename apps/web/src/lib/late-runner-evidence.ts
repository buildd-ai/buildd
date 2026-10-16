import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { handleCriteriaVerificationOutcome, isCriteriaVerificationTask } from '@/lib/mission-criteria-verify';
import { handleCriterionCheckOutcome, isCriterionCheckTask } from '@/lib/specs/criterion-checks';
import { stampEvidence } from '@/lib/verification-provenance';

/**
 * The runner's own verification report, arriving after the worker is already
 * terminal. The usual way that happens is harmless (the agent completed via
 * complete_task, and the runner recorded its evidence just before, from a
 * PreToolUse hook). The other way is the agent PATCHing its worker terminal
 * itself with evidence of its own: that write wins the terminal race and the
 * runner's terminal PATCH is refused.
 *
 * For a verification run (a spec criterion check or a mission `command`
 * criterion), whose verdict must be the runner's exit code, the late runner
 * report is kept anyway: stored on the worker when what is there is missing or
 * agent-reported, then turned into the verdict. Runner evidence already on the
 * row is never replaced. Everything else about the late PATCH is still refused
 * by the caller.
 */
export async function recordLateRunnerEvidence(input: {
  workerId: string;
  taskId: string | null;
  evidence: unknown;
}): Promise<{ handled: boolean; reason?: string }> {
  const ev = stampEvidence(input.evidence, { viaTaskToken: false });
  if (!ev || !input.taskId) return { handled: false, reason: 'no evidence' };
  const [task] = await db.select({ context: tasks.context }).from(tasks).where(eq(tasks.id, input.taskId)).limit(1);
  const kind = isCriterionCheckTask(task?.context) ? 'check' : isCriteriaVerificationTask(task?.context) ? 'criterion' : null;
  if (!kind) return { handled: false, reason: 'not a verification run' };

  const [stored] = await db.update(workers)
    .set({ verificationEvidence: ev })
    .where(and(
      eq(workers.id, input.workerId),
      eq(workers.taskId, input.taskId),
      sql`(${workers.verificationEvidence} IS NULL OR ${workers.verificationEvidence}->>'reportedVia' = 'task_token')`,
    ))
    .returning({ id: workers.id });
  if (!stored) return { handled: false, reason: 'runner evidence already recorded' };

  if (kind === 'check') await handleCriterionCheckOutcome(input.taskId, ev);
  else await handleCriteriaVerificationOutcome(input.taskId, ev);
  return { handled: true };
}

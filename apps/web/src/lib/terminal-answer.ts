/**
 * Withdraw an interactive worker's open ask_human question because the person
 * answered it at the terminal (docs/specs/terminal-question-redirect.md).
 *
 * The plugin's UserPromptSubmit hook says a person typed into the session
 * (`prompted`, decided on the machine; the prompt is never sent). They are at
 * the keyboard, so the question is answered there: the worker goes back to
 * `running`, the Needs-you card goes away, and no answer is queued, because
 * none came through buildd.
 *
 * The claiming write is /respond's own gate (`waitingFor IS NOT NULL`), so
 * exactly one of "answered in buildd" and "answered at the terminal" wins. A
 * permission prompt is never withdrawn: only a `question`.
 */
import { db } from '@buildd/core/db';
import { missionNotes, tasks, workers } from '@buildd/core/db/schema';
import { and, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import { INTERACTIVE_WORKER_RUNNER } from '@buildd/shared';
import { triggerEvent, channels, events } from '@/lib/pusher';

export function terminalWithdrawWhere(workerId: string): SQL | undefined {
  return and(
    eq(workers.id, workerId),
    eq(workers.runner, INTERACTIVE_WORKER_RUNNER),
    eq(workers.status, 'waiting_input'),
    isNotNull(workers.waitingFor),
    sql`${workers.waitingFor}->>'type' = ${'question'}`,
  );
}

export async function withdrawQuestionAnsweredInTerminal(workerId: string, now: Date = new Date()): Promise<boolean> {
  const [won] = await db
    .update(workers)
    .set({
      status: 'running',
      waitingFor: null,
      currentAction: 'Answered in the terminal',
      updatedAt: now,
    })
    .where(terminalWithdrawWhere(workerId))
    .returning({ id: workers.id, taskId: workers.taskId });
  if (!won) return false;

  // Best-effort from here: the question is already withdrawn.
  try {
    const task = won.taskId
      ? await db.query.tasks.findFirst({ where: eq(tasks.id, won.taskId), columns: { id: true, missionId: true } })
      : null;
    if (task) {
      await db.insert(missionNotes).values({
        missionId: task.missionId ?? null,
        taskId: task.id,
        workerId,
        authorType: 'system',
        type: 'update',
        title: 'Answered in the terminal',
        body: 'The person answered this question in the session itself, so it was withdrawn here.',
        status: 'open',
      });
    }
  } catch (err) {
    console.error(`[Worker ${workerId}] Terminal-answer note failed:`, err);
  }

  // The status changed outside PATCH /api/workers/[id], which normally emits
  // it: open Needs-you views drop the card on this.
  const runningEvent = { workerId, taskId: won.taskId, status: 'running', updatedAt: now.toISOString() };
  await Promise.all([
    triggerEvent(channels.worker(workerId), events.WORKER_PROGRESS, runningEvent),
    won.taskId ? triggerEvent(channels.task(won.taskId), events.WORKER_PROGRESS, runningEvent) : null,
  ]).catch(() => { /* a missed push only leaves a stale card */ });

  return true;
}

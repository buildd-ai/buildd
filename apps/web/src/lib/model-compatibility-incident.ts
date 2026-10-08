import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { recordModelCompatibilityIncident } from '@buildd/core/model-certification-store';

/**
 * A worker died on the provider's version gate ("Claude Code X does not
 * support this model; version A.B.C or newer is required"). Tell central
 * certification which model it was: the floor is learned for every runner
 * (so the next claim routes around it) and soak restarts for teams that wait.
 * Fire-and-forget: never throws, never delays the PATCH.
 */
export async function reportWorkerModelIncident(taskId: string | null | undefined, error: string): Promise<void> {
  if (!taskId) return;
  try {
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId), columns: { context: true } });
    const model = (task?.context as { model?: unknown } | null)?.model;
    if (typeof model === 'string' && model.startsWith('claude-')) {
      await recordModelCompatibilityIncident(model, error);
    }
  } catch {
    // Best effort.
  }
}

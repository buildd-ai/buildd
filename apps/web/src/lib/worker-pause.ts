/**
 * Pausing a running agent (task baf3809a).
 *
 * A pause asks the runner to stop the session at its next safe point (no tool
 * executing), keep the worktree and session id, and report waiting_input with
 * `waitingFor.type = 'pause'`. From there it is a parked question: answering it
 * (Resume) takes the same path as any answer (answer-resume.ts) and continues
 * the SAME session; a cloud run with resumable runs parks its bundle and frees
 * the container; the existing waiting_input timeouts bound how long it waits.
 *
 * The request is stored on the worker (`pauseRequestedAt`) and served on every
 * worker PATCH response until the worker parks, and also pushed realtime, so
 * neither a missed push nor a runner with no realtime connection loses it.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { triggerEvent, channels, events } from '@/lib/pusher';

export { pauseRefusal, pauseServed, type PauseRefusal } from './worker-pause-policy';

/**
 * Record the request (only while the worker is still running, so a race with
 * its end is a no-op) and push it. Returns false when the worker stopped
 * running in between.
 */
export async function requestWorkerPause(workerId: string, now = new Date()): Promise<boolean> {
  const [row] = await db
    .update(workers)
    .set({ pauseRequestedAt: now, updatedAt: now })
    .where(and(eq(workers.id, workerId), eq(workers.status, 'running')))
    .returning({ id: workers.id });
  if (!row) return false;
  await triggerEvent(channels.worker(workerId), events.WORKER_COMMAND, { action: 'pause', timestamp: now.getTime() })
    .catch(() => { /* the PATCH response carries it */ });
  return true;
}

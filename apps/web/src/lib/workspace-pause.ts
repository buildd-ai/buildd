/**
 * "Pause new starts until <time>" for one workspace (workspaces.new_starts_paused_until).
 * Runner claims skip its pending tasks until then (claim route, workspacePaused
 * gate); running work carries on and a person's interactive claim is never
 * paused. It resumes on its own: setting a pause schedules a wake for every
 * waiting task at the until-time, and resuming early wakes them now.
 */
import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { enqueueDispatchSql } from '@buildd/core/dispatch-outbox';
import { and, eq } from 'drizzle-orm';
import { resolveDeferredStart } from '@/lib/deferred-start';
import { kickDispatch, wakeTasks } from '@/lib/dispatch-authority';

/** Longest pause one request may set. Longer holds belong on the mission (held) or the tasks (startAt). */
export const MAX_PAUSE_MS = 7 * 24 * 60 * 60 * 1000;
/** Waiting tasks woken per pause change; the claim gate is the guarantee, the wake only saves a poll. */
const WAKE_LIMIT = 500;
const BATCH = 50;

export function isPaused(until: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!until) return false;
  const t = new Date(until);
  return !Number.isNaN(t.getTime()) && t > now;
}

/** The pause end a request asks for: `{ for: '4h' }`, `{ until: ISO }`, or `{ until: null }` to resume now. */
export function resolvePauseUntil(
  body: { for?: unknown; until?: unknown },
  now: Date = new Date(),
): { until: Date | null } | { error: string } {
  if (body.until === null && body.for === undefined) return { until: null };
  if (body.until === undefined && body.for === undefined) {
    return { error: 'Say how long: for (45m|3h|2d), until (an ISO time), or until: null to resume now' };
  }
  let until: Date | null;
  try {
    until = resolveDeferredStart({ startAt: body.until, startIn: body.for, now }).startAt;
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Invalid pause time';
    return { error: msg.replace(/startAt/g, 'until').replace(/startIn/g, 'for') };
  }
  if (!until) return { error: 'Say how long to pause' };
  if (until.getTime() - now.getTime() > MAX_PAUSE_MS) return { error: 'A pause can last at most 7 days' };
  return { until };
}

/** Write the pause (or clear it) and line up the wakes that make resuming automatic. */
export async function setWorkspacePause(workspaceId: string, until: Date | null, userId: string | null): Promise<void> {
  await db.update(workspaces)
    .set({ newStartsPausedUntil: until, newStartsPausedBy: until ? userId : null, updatedAt: new Date() })
    .where(eq(workspaces.id, workspaceId));

  const waiting = await db.query.tasks.findMany({
    where: and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, 'pending')),
    columns: { id: true },
    limit: WAKE_LIMIT,
  });
  const ids = waiting.map(t => t.id);
  if (ids.length === 0) return;
  if (!until) {
    await wakeTasks(ids, 'task.unblocked');
    return;
  }
  let failed = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const results = await Promise.allSettled(
      ids.slice(i, i + BATCH).map(taskId => db.execute(enqueueDispatchSql({ taskId, cause: 'task.unblocked', notBefore: until }))),
    );
    failed += results.filter(r => r.status === 'rejected').length;
  }
  // The claim gate still lifts at `until`; runners polling then pick the work up.
  if (failed) console.error(`[workspace-pause] ${failed}/${ids.length} resume wakes failed for ${workspaceId}`);
  kickDispatch();
}

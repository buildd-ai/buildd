/**
 * A worker going terminal frees a concurrency slot (the account's
 * `maxConcurrentWorkers` cap — apps/web/src/app/api/workers/claim/route.ts).
 * Nothing else proactively re-checks a task whose claim a cloud container
 * deferred for exactly that reason (EXIT_CLAIM_DEFERRED, apps/runner/src/
 * run-once.ts): before this wake it waited for the cloud-runner's own
 * backoff retry (apps/cloud-runner/src/supervisor.ts) or a slow sweep, both
 * minutes away rather than seconds.
 *
 * Scoped to a workspace with an active cloud-dispatch webhook: a host-polled
 * workspace already discovers a freed slot on its next poll, and a wake here
 * would just be a pointless outbox row for a destination that `webhookWants`
 * (dispatch-adapters.ts) will decline anyway.
 *
 * A wake means "reconsider this task now", never "assign it" (see
 * dispatch-authority.ts) — the claim route still applies every real gate, so
 * this picks a reasonable candidate rather than replicating that gate stack.
 */
import { and, eq, ne } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { missions, tasks, workspaces } from '@buildd/core/db/schema';
import { isCloudDispatchWebhook } from '@buildd/shared';
import { claimablePendingWhere } from '@/app/api/cron/queue-stall/fleet-idle';
import { depsGate } from '@/app/api/workers/claim/deps-gate';
import { wakeTask } from '@/lib/dispatch-authority';
import { sqlOrderByFn, sqlWhere } from '@buildd/core/db/relational-sql';

export async function wakeOldestPendingTaskOnCapacityFreed(
  workspaceId: string,
  excludeTaskId: string | null,
): Promise<void> {
  try {
    const workspace = await db.query.workspaces.findFirst({
      where: sqlWhere(eq(workspaces.id, workspaceId)),
      columns: { webhookConfig: true },
    });
    if (!isCloudDispatchWebhook(workspace?.webhookConfig as { enabled?: unknown; events?: unknown } | null | undefined)) {
      return;
    }

    const candidate = await db.query.tasks.findFirst({
      where: sqlWhere(and(
        eq(tasks.workspaceId, workspaceId),
        claimablePendingWhere(new Date()),
        excludeTaskId ? ne(tasks.id, excludeTaskId) : undefined,
      )),
      orderBy: sqlOrderByFn((t, { desc, asc }) => [desc(t.priority), asc(t.createdAt)]),
      columns: { id: true },
    });
    if (!candidate) return;
    await wakeTask(candidate.id, 'capacity.freed');
  } catch (err) {
    console.error(`[capacity-freed] wake failed for workspace ${workspaceId}:`, err);
  }
}

/**
 * A worker on a mission task going terminal frees a slot against the
 * mission's `maxConcurrentTasks` cap (claim route, `mission_concurrent`).
 * A sibling the claim route deferred for exactly that reason has nothing
 * else to re-check it on a host-polled workspace: runners are push-driven
 * and their fallback poll is hourly (RUNNER_HEARTBEAT_INTERVAL_MS), and
 * `wakeOldestPendingTaskOnCapacityFreed` only fires for a cloud-dispatch
 * webhook workspace. So a deferred task sat pending with idle runners while
 * `explain` (correctly, by then) said "next in line, no gate" — a final
 * verification was stranded behind a criterion check that had long finished.
 *
 * Fires for any workspace, but only for a mission that has a cap: with no
 * cap there is no slot to free. A wake means "reconsider this task now",
 * never "assign it" (dispatch-authority.ts) — the claim route re-applies
 * every gate, the mission cap included.
 */
export async function wakeMissionSlotWaiter(finishedTaskId: string | null): Promise<void> {
  if (!finishedTaskId) return;
  try {
    const finished = await db.query.tasks.findFirst({
      where: sqlWhere(eq(tasks.id, finishedTaskId)),
      columns: { missionId: true },
    });
    const missionId = finished?.missionId ?? null;
    if (!missionId) return;

    const mission = await db.query.missions.findFirst({
      where: sqlWhere(eq(missions.id, missionId)),
      columns: { maxConcurrentTasks: true },
    });
    if (mission?.maxConcurrentTasks == null) return;

    const candidate = await db.query.tasks.findFirst({
      where: sqlWhere(and(
        eq(tasks.missionId, missionId),
        claimablePendingWhere(new Date()),
        // A dependency-blocked sibling is not waiting on the slot; waking it
        // would spend the one wake on a claim the deps gate refuses.
        depsGate(),
        ne(tasks.id, finishedTaskId),
      )),
      orderBy: sqlOrderByFn((t, { desc, asc }) => [desc(t.priority), asc(t.createdAt)]),
      columns: { id: true },
    });
    if (!candidate) return;
    await wakeTask(candidate.id, 'capacity.freed');
  } catch (err) {
    console.error(`[mission-slot-freed] wake failed after task ${finishedTaskId}:`, err);
  }
}

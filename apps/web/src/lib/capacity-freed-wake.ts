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
import { tasks, workspaces } from '@buildd/core/db/schema';
import { isCloudDispatchWebhook } from '@buildd/shared';
import { claimablePendingWhere } from '@/app/api/cron/queue-stall/fleet-idle';
import { wakeTask } from '@/lib/dispatch-authority';

export async function wakeOldestPendingTaskOnCapacityFreed(
  workspaceId: string,
  excludeTaskId: string | null,
): Promise<void> {
  try {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { webhookConfig: true },
    });
    if (!isCloudDispatchWebhook(workspace?.webhookConfig as { enabled?: unknown; events?: unknown } | null | undefined)) {
      return;
    }

    const candidate = await db.query.tasks.findFirst({
      where: and(
        eq(tasks.workspaceId, workspaceId),
        claimablePendingWhere(new Date()),
        excludeTaskId ? ne(tasks.id, excludeTaskId) : undefined,
      ),
      orderBy: (t, { desc, asc }) => [desc(t.priority), asc(t.createdAt)],
      columns: { id: true },
    });
    if (!candidate) return;
    await wakeTask(candidate.id, 'capacity.freed');
  } catch (err) {
    console.error(`[capacity-freed] wake failed for workspace ${workspaceId}:`, err);
  }
}

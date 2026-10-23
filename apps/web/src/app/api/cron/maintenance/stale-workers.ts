import { db } from '@buildd/core/db';
import { workerHeartbeats } from '@buildd/core/db/schema';
import { reportOps } from '@buildd/core/report-ops';
import { and, lt } from 'drizzle-orm';
import { HEARTBEAT_STALE_MS, failWorkersOfOfflineRunners, heartbeatRowHasNoLiveWorkers, notifyStalledVisualAudits } from '@/lib/stale-workers';
import { sqlWhere } from '@buildd/core/db/relational-sql';

/**
 * Lightweight stale-worker cleanup: find heartbeat rows past the "not dead"
 * cutoff (HEARTBEAT_STALE_MS) and hand their accounts to the shared
 * offline-runner rule (failWorkersOfOfflineRunners), which fails each worker
 * whose OWN runner is past the cutoff. Runs on the hourly
 * `maintenance` cron tick so orphans are caught without waiting for a runner
 * to call /api/tasks/cleanup — a dead runner never will.
 *
 * Best-effort: every failure is swallowed (logged only) so the cron tick still
 * returns 200 and the other maintenance sweep still runs.
 *
 * Returns the number of orphaned workers that were failed.
 */
export async function runStaleWorkerCleanup(now: Date): Promise<number> {
  let heartbeatOrphans = 0;
  try {
    const heartbeatCutoff = new Date(now.getTime() - HEARTBEAT_STALE_MS);
    const staleHBs = await db.query.workerHeartbeats.findMany({
      where: sqlWhere(lt(workerHeartbeats.lastHeartbeatAt, heartbeatCutoff)),
      columns: { id: true, accountId: true },
    });
    if (staleHBs.length > 0) {
      const staleAccountIds = [...new Set(staleHBs.map(hb => hb.accountId))];
      // A stale row only says ONE runner went quiet. Which of that account's
      // workers are orphaned — the ones under THAT runner — is the shared
      // rule's call. This used to fail every live worker of the account
      // itself, including those under its other, live runner and its
      // interactive (MCP) workers (task 5c0ea9bc).
      heartbeatOrphans = await failWorkersOfOfflineRunners({ accountIds: staleAccountIds }, now);
      // Alert that a runner went offline — fires even when it had no active
      // workers (the orphan-failover above only covers running workers, so an
      // idle-but-wedged runner — e.g. one stuck on an unreachable server URL —
      // would otherwise vanish silently). reportOps dedups by source|message
      // for ~1h, so the per-minute cron won't spam.
      void reportOps({
        source: 'runner-offline',
        severity: 'error',
        message: 'Runner heartbeat stale — runner offline or not reaching the server',
        detail: `${staleHBs.length} stale heartbeat(s); accounts: ${staleAccountIds.join(', ')}; orphaned workers failed: ${heartbeatOrphans}`,
      });
      // Delete stale heartbeat records — never one a live-status worker still
      // names, so the rule above can keep judging that worker by its runner.
      await db.delete(workerHeartbeats).where(and(lt(workerHeartbeats.lastHeartbeatAt, heartbeatCutoff), heartbeatRowHasNoLiveWorkers()));
    }
  } catch (cleanupErr) {
    console.warn('[Cron] Stale worker cleanup failed:', cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
  }
  // A runner that went quiet while updating: told once, and its paused tasks
  // released after an hour (lib/runner-update-watch.ts). The floor under the
  // gated */5 tick of /api/cron/runner-update-watch.
  try {
    const { runUpdateWatch, createUpdateWatchDeps } = await import('@/lib/runner-update-watch');
    await runUpdateWatch(createUpdateWatchDeps(), now);
  } catch (watchErr) {
    console.warn('[Cron] Runner update watch failed:', watchErr instanceof Error ? watchErr.message : watchErr);
  }
  // A visual audit left waiting with no browser runner online: told once to
  // the conversation its mission came from (display only, never a cancel).
  try {
    await notifyStalledVisualAudits(now);
  } catch (stallErr) {
    console.warn('[Cron] Visual audit stall notice failed:', stallErr instanceof Error ? stallErr.message : stallErr);
  }
  return heartbeatOrphans;
}

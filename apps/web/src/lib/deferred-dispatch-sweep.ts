/**
 * Deferred-start dispatch sweep.
 *
 * A requeue that sets a future `tasks.startAt` (budget reset, Codex deferral,
 * mount gap, auth failover, stale-worker backoff) is nudged at requeue time,
 * but the nudge is skipped on purpose while the task is still deferred
 * (dispatchRetriedTask). Nothing nudged it again once `startAt` passed: a
 * poll-based runner finds it on its next poll, a push-only consumer (the
 * Cloudflare dispatcher, docs/design/cloudflare-sandbox-runner.md) never does.
 *
 * This sweep is that second nudge. It rides the pr-reconcile route's hourly
 * cadence (docs/design/cron-wake-windows.md: no new cron, no new Neon wake
 * window) and sends every task whose `startAt` has passed through
 * dispatchRetriedTask — webhook first, TASK_ASSIGNED fallback.
 *
 * Idempotency is a stamp on the task itself, `context.deferredDispatchedFor`,
 * holding the `startAt` (epoch ms) that was dispatched. The stamp is written by
 * the same UPDATE that selects the row, so two overlapping ticks cannot both
 * win it. Keyed to the value, not a boolean: a task deferred again to a new
 * `startAt` is a new dispatch.
 *
 * Skips what the claim route would refuse anyway and a person parked on
 * purpose: held task, held mission, local-executor mission, unresolved
 * dependencies.
 */
import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { inArray, sql, type SQL } from 'drizzle-orm';
import { notHeldOrLocal } from '@/app/api/workers/claim/held-gate';
import { depsGate } from '@/app/api/workers/claim/deps-gate';
import { dispatchRetriedTask, type DispatchWorkspace } from '@/lib/task-dispatch';

export const DEFERRED_DISPATCH_STAMP_KEY = 'deferredDispatchedFor';

/** Bounds one run so the route finishes inside maxDuration; a backlog drains across runs. */
export const DEFERRED_DISPATCH_BATCH = 50;

export interface DeferredDispatchResult {
  dispatched: number;
  failed: number;
}

interface DispatchedRow {
  id: string;
  title: string;
  description: string | null;
  workspaceId: string;
  mode: 'execution' | 'planning';
  priority: number;
  missionId: string | null;
  backend: string | null;
  roleSlug: string | null;
  runnerPreference: string | null;
}

/** `start_at` as the stamp value: epoch ms, independent of session timezone. */
const startAtStamp = (): SQL => sql`(extract(epoch from ${tasks.startAt}) * 1000)::bigint::text`;

/**
 * Atomically claim the dispatch for every pending task whose `startAt` has
 * passed and that has not been dispatched for that `startAt` yet, and return
 * those rows. The guard is repeated on the outer UPDATE: under READ COMMITTED a
 * concurrent tick that lost the row lock re-evaluates it and finds the stamp.
 */
export function claimDueDeferredTasksQuery(limit: number): SQL {
  const notYetStamped = sql`(${tasks.context}->>${DEFERRED_DISPATCH_STAMP_KEY}::text) IS DISTINCT FROM ${startAtStamp()}`;
  return sql`
    UPDATE ${tasks}
    SET context = COALESCE(${tasks.context}, '{}'::jsonb)
      || jsonb_build_object(${DEFERRED_DISPATCH_STAMP_KEY}::text, ${startAtStamp()})
    WHERE ${tasks.id} IN (
      SELECT ${tasks.id} FROM ${tasks}
      WHERE ${tasks.status} = 'pending'
        AND ${tasks.startAt} IS NOT NULL
        AND ${tasks.startAt} <= now()
        AND ${notYetStamped}
        AND ${notHeldOrLocal()}
        AND ${depsGate()}
      ORDER BY ${tasks.startAt} ASC
      LIMIT ${limit}
    )
    AND ${tasks.status} = 'pending'
    AND ${tasks.startAt} <= now()
    AND ${notYetStamped}
    RETURNING
      ${tasks.id} AS "id",
      ${tasks.title} AS "title",
      ${tasks.description} AS "description",
      ${tasks.workspaceId} AS "workspaceId",
      ${tasks.mode} AS "mode",
      ${tasks.priority} AS "priority",
      ${tasks.missionId} AS "missionId",
      ${tasks.backend} AS "backend",
      ${tasks.roleSlug} AS "roleSlug",
      ${tasks.runnerPreference} AS "runnerPreference"
  `;
}

/** Remove the stamp so the next tick retries a dispatch that threw. */
async function releaseStamp(taskId: string): Promise<void> {
  await db.execute(sql`
    UPDATE ${tasks}
    SET context = ${tasks.context} - ${DEFERRED_DISPATCH_STAMP_KEY}::text
    WHERE ${tasks.id} = ${taskId}
  `);
}

export async function sweepDeferredDispatch(): Promise<DeferredDispatchResult> {
  const claimed = await db.execute(claimDueDeferredTasksQuery(DEFERRED_DISPATCH_BATCH));
  const rows = (claimed.rows ?? []) as unknown as DispatchedRow[];
  if (rows.length === 0) return { dispatched: 0, failed: 0 };

  const workspaceRows = await db.query.workspaces.findMany({
    where: inArray(workspaces.id, [...new Set(rows.map(r => r.workspaceId))]),
    columns: {
      id: true,
      name: true,
      repo: true,
      webhookConfig: true,
      githubInstallationId: true,
      githubRepoId: true,
    },
  });
  const workspaceById = new Map<string, DispatchWorkspace>(workspaceRows.map(w => [w.id, w]));

  const outcomes = await Promise.all(
    rows.map(async (row) => {
      try {
        // No startAt on the row: it has passed by construction, so
        // dispatchRetriedTask takes the webhook leg instead of treating the
        // task as still deferred.
        await dispatchRetriedTask(row, workspaceById.get(row.workspaceId) ?? {});
        return true;
      } catch (error) {
        console.error(`[DeferredDispatch] task ${row.id} dispatch failed:`, error);
        await releaseStamp(row.id).catch(() => {});
        return false;
      }
    }),
  );

  const dispatched = outcomes.filter(Boolean).length;
  return { dispatched, failed: outcomes.length - dispatched };
}

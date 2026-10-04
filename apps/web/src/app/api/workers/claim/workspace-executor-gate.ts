import { sql, type SQL } from 'drizzle-orm';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { CLOUD_DISPATCH_EVENTS, WORKSPACE_EXECUTORS, type RunnerExecutor } from '@buildd/shared';

/**
 * The workspace's effective executor (packages/shared/src/executor.ts
 * resolveWorkspaceExecutor), as SQL over the `ws_ex` alias: the explicit
 * gitConfig.executor when it is a known value, else 'cloud' when the webhook is
 * enabled and lists every cloud dispatch event, else 'any'. Never NULL.
 */
function effectiveExecutorSql(): SQL {
  const known = sql.raw(WORKSPACE_EXECUTORS.map(v => `'${v}'`).join(', '));
  return sql`CASE
    WHEN ws_ex.git_config->>'executor' IN (${known}) THEN ws_ex.git_config->>'executor'
    WHEN ws_ex.webhook_config->'enabled' = 'true'::jsonb
      AND ws_ex.webhook_config->'events' @> ${JSON.stringify([...CLOUD_DISPATCH_EVENTS])}::jsonb THEN 'cloud'
    ELSE 'any' END`;
}

/**
 * Claim gate: TRUE when the task's workspace lets this kind of claim take it.
 * A host claim skips workspaces whose work runs in the cloud; a cloud claim
 * skips host-only ones. Two-valued (NOT EXISTS over a never-NULL CASE), so the
 * explicit-claim probe can name it.
 *
 * Applied to every claim except an admin force claim, including a person's
 * explicit interactive claim_task {taskId}: the cloud container is already on
 * its way for that task, and taking it from a host session strands it the same
 * way a runner poll does.
 */
export function workspaceExecutorGate(claim: RunnerExecutor): SQL {
  const excluded = claim === 'cloud' ? 'host' : 'cloud';
  return sql`NOT EXISTS (
    SELECT 1 FROM ${workspaces} ws_ex
    WHERE ws_ex.id = ${tasks.workspaceId}
    AND (${effectiveExecutorSql()}) = ${excluded}
  )`;
}

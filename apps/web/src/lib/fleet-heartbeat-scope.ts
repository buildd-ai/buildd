/**
 * The heartbeats a team's fleet is made of: runners whose account is the
 * team's own, or is linked to one of the team's workspaces (an account of
 * another team can be, and then claims there). The same reach the claim rule
 * and /api/workers/active use, so Settings, Health and list_runners list the
 * same runners.
 *
 * Not `worker_heartbeats.workspace_ids`: the heartbeat route writes it as an
 * empty array, so matching on it silently dropped every linked runner.
 */
import { accounts, accountWorkspaces, workerHeartbeats } from '@buildd/core/db/schema';
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';

export function fleetHeartbeatScope(input: { teamId: string | null; wsIds: readonly string[] }): SQL | null {
  const { teamId, wsIds } = input;
  if (!teamId && wsIds.length === 0) return null;
  const linked = wsIds.length > 0
    ? sql`${workerHeartbeats.accountId} in (select ${accountWorkspaces.accountId} from ${accountWorkspaces} where ${and(
        inArray(accountWorkspaces.workspaceId, [...wsIds]),
        isNull(accountWorkspaces.removedAt),
      )})`
    : undefined;
  const own = teamId
    ? sql`${workerHeartbeats.accountId} in (select ${accounts.id} from ${accounts} where ${eq(accounts.teamId, teamId)})`
    : undefined;
  return or(linked, own) ?? null;
}

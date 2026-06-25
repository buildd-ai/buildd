import { db } from '@buildd/core/db';
import { accounts, accountWorkspaces, workerHeartbeats } from '@buildd/core/db/schema';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';

export interface RunnerHeartbeat {
  id: string;
  accountId: string;
  accountName: string | null;
  lastHeartbeatAt: string;
  activeWorkerCount: number;
  maxConcurrentWorkers: number;
}

/** Runner is "online" when its last beat is within the past 2 minutes. */
export function isRunnerOnline(lastHeartbeatAt: string | Date): boolean {
  return Date.now() - new Date(lastHeartbeatAt).getTime() < 2 * 60 * 1000;
}

/**
 * Fetch runner heartbeats seen within the past 150 minutes.
 * Scoped to the active team; optionally narrowed to accounts linked to
 * a specific workspace via accountWorkspaces.
 */
export async function getRunnerHeartbeats(
  teamId: string,
  workspaceId?: string | null,
): Promise<RunnerHeartbeat[]> {
  let accountIds: string[];

  if (workspaceId) {
    const linked = await db
      .select({ accountId: accountWorkspaces.accountId })
      .from(accountWorkspaces)
      .where(eq(accountWorkspaces.workspaceId, workspaceId));
    accountIds = [...new Set((linked as any[]).map((r: any) => r.accountId as string))];
  } else {
    const teamAccounts = await db.query.accounts.findMany({
      where: eq(accounts.teamId, teamId),
      columns: { id: true },
    });
    accountIds = (teamAccounts as any[]).map((a: any) => a.id as string);
  }

  if (accountIds.length === 0) return [];

  const cutoff = new Date(Date.now() - 150 * 60 * 1000);
  const hbs = await db.query.workerHeartbeats.findMany({
    where: and(
      inArray(workerHeartbeats.accountId, accountIds),
      gt(workerHeartbeats.lastHeartbeatAt, cutoff),
    ),
    orderBy: desc(workerHeartbeats.lastHeartbeatAt),
    with: { account: { columns: { name: true } } },
  });

  return (hbs as any[]).map((hb: any) => ({
    id: hb.id,
    accountId: hb.accountId,
    accountName: (hb as any).account?.name ?? null,
    lastHeartbeatAt: hb.lastHeartbeatAt.toISOString(),
    activeWorkerCount: hb.activeWorkerCount,
    maxConcurrentWorkers: hb.maxConcurrentWorkers,
  }));
}

import { db } from '@buildd/core/db';
import { accountWorkspaces, workerHeartbeats, workers } from '@buildd/core/db/schema';
import { and, desc, gt, inArray } from 'drizzle-orm';

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

export interface RunnerRelevanceCandidate {
  accountId: string;
  accountTeamId: string | null;
}

/**
 * Decide which heartbeating accounts belong on a team's Health page.
 * Relevant when the account is in the team, explicitly linked to one of the
 * scoped workspaces, or has actually run workers in one. Mere claim
 * *eligibility* is not enough — open-access workspaces are claimable by any
 * account on the platform, and strangers' runners must not appear here.
 */
export function selectRelevantRunnerAccounts(
  candidates: RunnerRelevanceCandidate[],
  opts: {
    teamId: string;
    linkedAccountIds: ReadonlySet<string>;
    workedAccountIds: ReadonlySet<string>;
  },
): Set<string> {
  const relevant = new Set<string>();
  for (const c of candidates) {
    if (
      c.accountTeamId === opts.teamId ||
      opts.linkedAccountIds.has(c.accountId) ||
      opts.workedAccountIds.has(c.accountId)
    ) {
      relevant.add(c.accountId);
    }
  }
  return relevant;
}

/**
 * Fetch runner heartbeats seen within the past 150 minutes that are relevant
 * to the given team and workspace scope (see selectRelevantRunnerAccounts).
 * Runner accounts often live in the owner's personal team while serving
 * another team's open workspaces, so scoping by accounts.teamId alone
 * hides them.
 */
export async function getRunnerHeartbeats(
  teamId: string,
  workspaceIds: string[],
): Promise<RunnerHeartbeat[]> {
  if (workspaceIds.length === 0) return [];

  const cutoff = new Date(Date.now() - 150 * 60 * 1000);
  const hbs = await db.query.workerHeartbeats.findMany({
    where: gt(workerHeartbeats.lastHeartbeatAt, cutoff),
    orderBy: desc(workerHeartbeats.lastHeartbeatAt),
    with: { account: { columns: { name: true, teamId: true } } },
  });
  if (hbs.length === 0) return [];

  const hbAccountIds = [...new Set((hbs as any[]).map((hb: any) => hb.accountId as string))];

  const [links, worked] = await Promise.all([
    db
      .select({ accountId: accountWorkspaces.accountId })
      .from(accountWorkspaces)
      .where(and(
        inArray(accountWorkspaces.accountId, hbAccountIds),
        inArray(accountWorkspaces.workspaceId, workspaceIds),
      )),
    db
      .selectDistinct({ accountId: workers.accountId })
      .from(workers)
      .where(and(
        inArray(workers.accountId, hbAccountIds),
        inArray(workers.workspaceId, workspaceIds),
      )),
  ]);

  const relevant = selectRelevantRunnerAccounts(
    (hbs as any[]).map((hb: any) => ({
      accountId: hb.accountId as string,
      accountTeamId: (hb.account?.teamId as string | undefined) ?? null,
    })),
    {
      teamId,
      linkedAccountIds: new Set((links as any[]).map((r: any) => r.accountId as string)),
      workedAccountIds: new Set(
        (worked as any[]).map((r: any) => r.accountId as string | null).filter(Boolean) as string[],
      ),
    },
  );

  return (hbs as any[])
    .filter((hb: any) => relevant.has(hb.accountId))
    .map((hb: any) => ({
      id: hb.id,
      accountId: hb.accountId,
      accountName: hb.account?.name ?? null,
      lastHeartbeatAt: hb.lastHeartbeatAt.toISOString(),
      activeWorkerCount: hb.activeWorkerCount,
      maxConcurrentWorkers: hb.maxConcurrentWorkers,
    }));
}

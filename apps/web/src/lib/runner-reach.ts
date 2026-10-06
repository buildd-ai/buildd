import { db } from '@buildd/core/db';
import { accountWorkspaces, workerHeartbeats } from '@buildd/core/db/schema';
import { eq, gt } from 'drizzle-orm';
import { RUNNER_ONLINE_WINDOW_MS } from './runner-heartbeats-shared';
import { diagnoseRunnerReach, needsLinkForOwnTeam, type RunnerReachDiagnosis } from './runner-reach-diagnosis';

/**
 * Server half of ./runner-reach-diagnosis: loads the workspace's links and the
 * runners online now. An open workspace returns null without a query.
 */
export async function loadRunnerReachDiagnosis(workspace: {
  id: string;
  teamId: string;
  accessMode: string | null;
}): Promise<RunnerReachDiagnosis | null> {
  if (!needsLinkForOwnTeam(workspace)) return null;
  const cutoff = new Date(Date.now() - RUNNER_ONLINE_WINDOW_MS);
  const [links, heartbeats] = await Promise.all([
    db.query.accountWorkspaces.findMany({
      where: eq(accountWorkspaces.workspaceId, workspace.id),
      columns: { accountId: true, canClaim: true, canCreate: true },
    }),
    db.query.workerHeartbeats.findMany({
      where: gt(workerHeartbeats.lastHeartbeatAt, cutoff),
      columns: { accountId: true },
      with: { account: { columns: { teamId: true } } },
    }),
  ]);
  const linkByAccount = new Map(links.map((l) => [l.accountId, l]));
  const onlineRunners = heartbeats
    .filter((hb) => hb.account?.teamId)
    .map((hb) => ({
      accountId: hb.accountId,
      accountTeamId: hb.account!.teamId,
      link: linkByAccount.get(hb.accountId) ?? null,
    }));
  return diagnoseRunnerReach({
    workspace,
    onlineRunners,
    linkedClaimerCount: links.filter((l) => l.canClaim).length,
  });
}

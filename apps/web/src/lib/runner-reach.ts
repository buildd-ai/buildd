import { db } from '@buildd/core/db';
import { accountWorkspaces, workerHeartbeats } from '@buildd/core/db/schema';
import { and, eq, gt } from 'drizzle-orm';
import { RUNNER_ONLINE_CANDIDATE_WINDOW_MS } from '@buildd/shared';
import { isRunnerOnline } from './runner-heartbeats-shared';
import { runnerLiveCandidateCutoff, withLiveRunnerBeats } from './runner-beats';
import { diagnoseRunnerReach, needsLinkForOwnTeam, type RunnerReachDiagnosis } from './runner-reach-diagnosis';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { liveLinkCondition } from '@/lib/granted-links';

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
  const now = Date.now();
  const [links, candidates] = await Promise.all([
    db.query.accountWorkspaces.findMany({
      where: sqlWhere(and(eq(accountWorkspaces.workspaceId, workspace.id), liveLinkCondition())),
      columns: { accountId: true, canClaim: true, canCreate: true },
    }),
    db.query.workerHeartbeats.findMany({
      where: sqlWhere(gt(workerHeartbeats.lastHeartbeatAt, runnerLiveCandidateCutoff(now, RUNNER_ONLINE_CANDIDATE_WINDOW_MS))),
      columns: { accountId: true, localUiUrl: true, lastHeartbeatAt: true, presenceConnected: true },
      with: { account: { columns: { teamId: true } } },
    }),
  ]);
  // A stored beat can be one write interval old; the Redis beat is "now" (lib/runner-beats.ts).
  const heartbeats = (await withLiveRunnerBeats(candidates))
    .filter((hb) => isRunnerOnline(hb.lastHeartbeatAt, now, hb.presenceConnected));
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

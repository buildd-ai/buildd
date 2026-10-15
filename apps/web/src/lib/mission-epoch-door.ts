/**
 * The missions module's doors onto the kernel's mission epochs
 * (docs/specs/workflow-kernel-library.md §6). Every transition is submitted
 * through the one kernel client, so it runs where the kernel is hosted; this
 * file only decides when to ask, and reads what the kernel recorded.
 *
 *  - a mission PR merged (every merge door and the merge webhook):
 *    `recordMissionPrMerged`;
 *  - work needs a writable branch and the newest delivery already merged (a
 *    task filed into the mission, a task PR opening): `ensureMissionWritableBranch`;
 *  - the mission PR for the open delivery opened: `bindMissionDeliveryPr`;
 *  - the hourly backstop: `reconcileMissionDeliveries`.
 */
import { db } from '@buildd/core/db';
import { missions } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { missionIntegrationBase, isMissionPrTask } from '@buildd/core/mission-integration';
import { githubApi } from '@/lib/github';
import { submitKernelCommand } from '@/lib/workflow/kernel-client';
import { missionEpochsOf, writableEpoch } from '@/lib/workflow/delivery-ship';
import { resolveMissionRepoWorkspaceId } from '@/lib/mission-repo-workspace';

const SYSTEM = { kind: 'system' as const, id: 'system:mission_epochs' };

async function repoWorkspace(missionId: string): Promise<string | null> {
  const m = await db.query.missions.findFirst({ where: sqlWhere(eq(missions.id, missionId)), columns: { workspaceId: true } });
  return (await resolveMissionRepoWorkspaceId({ missionId, missionWorkspaceId: m?.workspaceId ?? null })).workspaceId;
}

/**
 * A mission PR merged. Reads the merge from GitHub (the merge commit, the
 * head that merged), then records it: the delivery becomes terminal, the
 * mission rotates to one successor when work remains, and the merged branch
 * is settled before it is retired. Never throws: a failure is retried by the
 * hourly reconcile, which re-reads the same PR.
 */
export async function recordMissionPrMerged(
  task: { title?: string | null; taskClass?: string | null; missionId?: string | null } | null | undefined,
  installationId: number,
  repoFullName: string,
  prNumber?: number | null,
): Promise<{ recorded: boolean; reason: string }> {
  if (!task || !isMissionPrTask(task) || !task.missionId) return { recorded: false, reason: 'not_mission_pr' };
  const missionId = task.missionId;
  try {
    const mission = await db.query.missions.findFirst({
      where: sqlWhere(eq(missions.id, missionId)),
      columns: { workingBranch: true, integrationBranchEnabled: true },
    });
    if (!missionIntegrationBase(mission)) return { recorded: false, reason: 'not_opted_in' };
    let n = prNumber ?? null;
    if (n == null) {
      const { findMissionPrOwner } = await import('@/lib/mission-pr');
      n = (await findMissionPrOwner(missionId))?.prNumber ?? null;
    }
    if (n == null) return { recorded: false, reason: 'no_pr' };
    const pr = await githubApi(installationId, `/repos/${repoFullName}/pulls/${n}`);
    if (pr?.merged !== true) return { recorded: false, reason: 'not_merged' };
    const workspaceId = await repoWorkspace(missionId);
    if (!workspaceId) return { recorded: false, reason: 'no_repo' };
    const answer = await submitKernelCommand('mission_epoch', {
      action: 'merged', workspaceId, missionId, prNumber: n, repoFullName,
      headRef: typeof pr?.head?.ref === 'string' ? pr.head.ref : null,
      mergeCommitSha: typeof pr?.merge_commit_sha === 'string' ? pr.merge_commit_sha : null,
      mergedHeadSha: typeof pr?.head?.sha === 'string' ? pr.head.sha : null,
      mergedAt: typeof pr?.merged_at === 'string' ? pr.merged_at : new Date().toISOString(),
      actor: 'system:mission_pr_merged',
    }, { principal: SYSTEM, withDelivery: false });
    const r = answer.result;
    if (r.action !== 'merged') return { recorded: false, reason: 'unexpected_answer' };
    return { recorded: r.result === 'applied' || r.result === 'noop', reason: r.reason };
  } catch (err) {
    console.error(`[mission-epochs] recording mission ${missionId}'s merged PR failed (the hourly reconcile retries):`, err);
    return { recorded: false, reason: 'error' };
  }
}

/**
 * Work needs the mission's writable branch. A no-op (one read) for a
 * mission with an open delivery, one that predates delivery records (its
 * branch keeps working exactly as before) or one with no integration branch.
 * When the newest delivery already merged, the kernel cuts exactly one
 * successor and the mission's branch moves to it. Returns the branch to use,
 * or null when nothing changed.
 */
export async function ensureMissionWritableBranch(missionId: string, reason: string): Promise<string | null> {
  try {
    const epochs = await missionEpochsOf(missionId);
    if (epochs.length === 0 || writableEpoch({ epochs })) return null;
    const workspaceId = await repoWorkspace(missionId);
    if (!workspaceId) return null;
    const answer = await submitKernelCommand('mission_epoch', {
      action: 'ensure_writable', workspaceId, missionId, reason, actor: `system:${reason}`,
    }, { principal: SYSTEM, withDelivery: false });
    const r = answer.result;
    return r.action === 'ensure_writable' ? r.branch : null;
  } catch (err) {
    console.error(`[mission-epochs] could not open a writable delivery for mission ${missionId}:`, err);
    return null;
  }
}

/** The mission PR for the open delivery opened (or was adopted). Best effort. */
export async function bindMissionDeliveryPr(p: { missionId: string; workspaceId: string; prNumber: number; repoFullName: string; ownerTaskId: string | null; headRef: string | null }): Promise<void> {
  try {
    await submitKernelCommand('mission_epoch', { action: 'bind_pr', ...p, actor: 'system:mission_pr_opened' }, { principal: SYSTEM, withDelivery: false });
  } catch (err) {
    console.error(`[mission-epochs] binding PR #${p.prNumber} to mission ${p.missionId}'s delivery failed:`, err);
  }
}

/** The hourly backstop: finish whatever a delivery transition left owed. */
export async function reconcileMissionDeliveries(missionId: string): Promise<string[]> {
  const epochs = await missionEpochsOf(missionId);
  if (epochs.length === 0) return [];
  const workspaceId = await repoWorkspace(missionId);
  if (!workspaceId) return [];
  const answer = await submitKernelCommand('mission_epoch', { action: 'reconcile', workspaceId, missionId }, { principal: SYSTEM, withDelivery: false });
  const r = answer.result;
  return r.action === 'reconcile' ? r.steps : [];
}

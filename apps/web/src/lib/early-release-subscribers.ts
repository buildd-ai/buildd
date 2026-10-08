/**
 * Early release (docs/design/early-release.md): what a PR becoming reviewable
 * and an upstream task's merge mean for the tasks waiting on it. Core (the
 * GitHub webhook) emits the facts (lib/core-events.ts); this owns the
 * reaction. Order and the composition root: apps/web/src/modules.ts.
 *
 * - `pr.review_ready`: check every pending task that depends on the upstream
 *   task's PR. Workspace-gated inside the dispatcher itself
 *   (gitConfig.earlyRelease.mode), so the one workspace read here is the only
 *   cost for a workspace that has not opted in.
 * - `task.pr_merge_delivered`: a dependent released `start_stacked` against
 *   this task's branch opened its PR as a draft (create_pr, via
 *   findStackedReleaseForBase) because the upstream might still change. Now
 *   that it is merged, un-draft it; GitHub's own retarget-on-delete moves its
 *   base once the branch itself is deleted.
 */
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { subscriber, type AnySubscriber } from '@/lib/core-events';
import { scheduleEarlyReleaseDispatch } from '@/lib/early-release-dispatch-trigger';
import { undraftStackedDependents } from '@/lib/early-release-stacking';

export const earlyReleaseSubscribers: readonly AnySubscriber[] = [
  subscriber('releases', 'pr.review_ready', 'early-release-dispatch', async e => {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, e.worker.workspaceId),
      columns: { teamId: true, gitConfig: true },
    });
    if (!workspace) return;
    scheduleEarlyReleaseDispatch({
      workspaceId: e.worker.workspaceId,
      teamId: workspace.teamId,
      gitConfig: workspace.gitConfig,
      upstreamTaskId: e.worker.taskId,
      upstreamPrNumber: e.pr.number,
      upstreamBranch: e.pr.headRef,
      repoFullName: e.repoFullName,
      installationId: e.installationId,
      upstreamAdditions: e.pr.additions,
      upstreamDeletions: e.pr.deletions,
    });
  }),
  subscriber('releases', 'task.pr_merge_delivered', 'early-release-undraft-stacked', e => {
    undraftStackedDependents(e.taskId).catch(err =>
      console.error(`[early-release] undraftStackedDependents failed for task ${e.taskId}:`, err),
    );
  }),
];

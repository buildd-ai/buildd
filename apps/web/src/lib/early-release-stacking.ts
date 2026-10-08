/**
 * Early release — stacking mechanics: force a `start_stacked` dependent's PR
 * open as a draft, and un-draft it once the upstream it's stacked on merges.
 * See `knowledge-base: buildd/design/early-release.md`, "Stacking mechanics".
 *
 * Reuses the existing stacked-plan-phase plumbing end to end — the runner's
 * `resolveWorktreeBase()` already branches off any named base, and
 * `isStackedPhaseBase()`/`resolveTaskPrBase()` (packages/core/mission-integration.ts)
 * already accept a `context.baseBranch` that names a task in `dependsOn`. This
 * module only answers the two questions that machinery doesn't: "should THIS
 * PR open as a draft" (asked at `create_pr`) and "which open PRs does this
 * now-merged upstream's stack need un-drafted" (asked from the merge webhook).
 *
 * There is deliberately no buildd-initiated base-retarget call here — once the
 * upstream branch is deleted post-merge, GitHub's own retarget-on-delete moves
 * the dependent's base on its own.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { dependencyReleases, githubRepos, workers } from '@buildd/core/db/schema';
import { isTerminalPrLifecycle } from '@/lib/dep-gate-contract';
import { markPullRequestReadyForReview } from '@/lib/github';

/**
 * Is `baseBranch` a non-revoked `start_stacked` early-release base for this
 * dependent task? Checked against the specific base — not just "any
 * start_stacked row for this task" — because a dependent can have several
 * `dependsOn` edges and only one of them may have released it stacked; the
 * base this PR is actually opening against is the one that matters.
 */
export interface FindStackedReleaseDeps {
  findRelease?: (dependentTaskId: string, baseBranch: string) => Promise<{ id: string } | null>;
}

async function defaultFindRelease(dependentTaskId: string, baseBranch: string): Promise<{ id: string } | null> {
  const row = await db.query.dependencyReleases.findFirst({
    where: and(
      eq(dependencyReleases.dependentTaskId, dependentTaskId),
      eq(dependencyReleases.decision, 'start_stacked'),
      eq(dependencyReleases.baseBranch, baseBranch),
      isNull(dependencyReleases.revokedAt),
    ),
    columns: { id: true },
  });
  return row ?? null;
}

export async function findStackedReleaseForBase(
  dependentTaskId: string | null | undefined,
  baseBranch: string | null | undefined,
  deps: FindStackedReleaseDeps = {},
): Promise<boolean> {
  if (!dependentTaskId || !baseBranch) return false;
  const findRelease = deps.findRelease ?? defaultFindRelease;
  const row = await findRelease(dependentTaskId, baseBranch);
  return !!row;
}

export interface StackedDependentPr {
  taskId: string;
  prNumber: number;
  installationId: number;
  repoFullName: string;
}

export interface UndraftStackedDependentsDeps {
  /** Dependent task ids with a non-revoked `start_stacked` release against `upstreamTaskId`. */
  findStackedDependentTaskIds?: (upstreamTaskId: string) => Promise<string[]>;
  /** The dependent's own open PR and the GitHub coordinates to call ready-for-review with, or null when there is none to act on. */
  findOpenPrForTask?: (taskId: string) => Promise<Omit<StackedDependentPr, 'taskId'> | null>;
  markReady?: (installationId: number, repoFullName: string, prNumber: number) => Promise<{ ok: true } | { ok: false; message: string }>;
}

async function defaultFindStackedDependentTaskIds(upstreamTaskId: string): Promise<string[]> {
  const rows = await db
    .select({ dependentTaskId: dependencyReleases.dependentTaskId })
    .from(dependencyReleases)
    .where(
      and(
        eq(dependencyReleases.upstreamTaskId, upstreamTaskId),
        eq(dependencyReleases.decision, 'start_stacked'),
        isNull(dependencyReleases.revokedAt),
      ),
    );
  return rows.map((r) => r.dependentTaskId);
}

async function defaultFindOpenPrForTask(taskId: string): Promise<Omit<StackedDependentPr, 'taskId'> | null> {
  const worker = await db.query.workers.findFirst({
    where: eq(workers.taskId, taskId),
    orderBy: (w, { desc }) => [desc(w.createdAt)],
    with: { workspace: true },
  });
  if (!worker?.prNumber || worker.mergedAt || isTerminalPrLifecycle(worker.prLifecycleStatus)) return null;
  if (!worker.workspace?.githubRepoId) return null;

  const repo = await db.query.githubRepos.findFirst({
    where: eq(githubRepos.id, worker.workspace.githubRepoId),
    with: { installation: true },
  });
  if (!repo?.installation) return null;

  return { prNumber: worker.prNumber, installationId: repo.installation.installationId, repoFullName: repo.fullName };
}

/**
 * Un-draft every live dependent stacked on `upstreamTaskId`'s now-merged PR.
 * Called from the merge webhook, right after `checkDependsOnResolved` — best
 * effort and per-dependent isolated, since a merge response must never fail
 * over this.
 */
export async function undraftStackedDependents(
  upstreamTaskId: string,
  deps: UndraftStackedDependentsDeps = {},
): Promise<void> {
  const findStackedDependentTaskIds = deps.findStackedDependentTaskIds ?? defaultFindStackedDependentTaskIds;
  const findOpenPrForTask = deps.findOpenPrForTask ?? defaultFindOpenPrForTask;
  const markReady = deps.markReady ?? ((i, r, n) => markPullRequestReadyForReview(i, r, n));

  const dependentTaskIds = await findStackedDependentTaskIds(upstreamTaskId);
  for (const taskId of dependentTaskIds) {
    try {
      const pr = await findOpenPrForTask(taskId);
      if (!pr) continue;
      const result = await markReady(pr.installationId, pr.repoFullName, pr.prNumber);
      if (!result.ok) {
        console.error(
          `[early-release] failed to undraft PR #${pr.prNumber} for dependent task ${taskId}: ${result.message}`,
        );
      }
    } catch (err) {
      console.error(`[early-release] undraft failed for dependent task ${taskId}:`, err);
    }
  }
}

/**
 * Read-through PR state refresh — a render-time FAST PATH, not a poller.
 *
 * Called from Home, mission detail and task list routes so a view someone is
 * actually looking at reflects a merge that landed seconds ago. Convergence is
 * NOT its job: lib/pr-reconcile.ts (the single GitHub poller, on the hourly
 * pr-reconcile cron) is what guarantees every row's lifecycle state is inside
 * its tier SLA whether or not anybody opens a page. Before that guarantee
 * existed, this function WAS the only defence, and its bounded batch is exactly
 * why four merged PRs sat on Home for up to 90 days.
 *
 * Rate-limited to match the backfill script (200 ms between GitHub calls).
 * Batch capped at 10 workers per render to bound GitHub API fan-out — and
 * ordered least-recently-checked first, so under a backlog the cap is a fair
 * queue rather than an arbitrary sample that can starve the same rows forever.
 * Non-fatal: GitHub errors are logged; prLastCheckedAt is left unset so the
 * next render retries.
 */

import { db } from '@buildd/core/db';
import { workers, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { githubApi, fetchCiLifecycleStatus } from '@/lib/github';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { checkDependsOnResolved } from '@/lib/task-dependencies';
import {
  WORKSPACE_INSTALLATION_WITH,
  pickWorkspaceRepoIdentity,
  installationIdForRepo,
} from '@/lib/workspace-installation';
import { resolvePrRepo } from '@/lib/repo-scope';

const BATCH_CAP = 10;
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_MS = 200;

const TERMINAL_STATUSES = ['merged', 'closed', 'unresolvable'] as ('pr_open' | 'ci_running' | 'ci_green' | 'ci_failed' | 'merged' | 'conflict' | 'closed' | 'unresolvable' | null)[];

export interface StalePrCandidate {
  id: string;
  prNumber: number | null;
  /**
   * The PR's own url — the authoritative source for which repo to query, since
   * a worker's PR is often not in its workspace's repo. Optional so existing
   * callers compile; omitting it falls back to the workspace repo.
   */
  prUrl?: string | null;
  workspaceId: string;
  taskId: string | null;
  prLifecycleStatus: string | null;
  prLastCheckedAt: Date | null;
}

/**
 * Refresh stale PR state by querying workers in the given workspaces from the
 * DB. Used by the task list route where workers are not already in memory.
 */
export async function refreshStaleWorkersForWorkspaces(workspaceIds: string[]): Promise<void> {
  if (workspaceIds.length === 0) return;

  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

  const candidates = await db.query.workers.findMany({
    where: and(
      inArray(workers.workspaceId, workspaceIds),
      isNotNull(workers.prNumber),
      or(
        isNull(workers.prLifecycleStatus),
        notInArray(workers.prLifecycleStatus, TERMINAL_STATUSES),
      ),
      or(
        isNull(workers.prLastCheckedAt),
        lt(workers.prLastCheckedAt, staleCutoff),
      ),
    ),
    columns: { id: true, prNumber: true, prUrl: true, workspaceId: true, taskId: true, prLifecycleStatus: true },
    // Least-recently-checked first. Without an ordering the cap made this an
    // arbitrary sample of the backlog, so a row could be passed over on every
    // single render — indefinitely.
    orderBy: sql`${workers.prLastCheckedAt} ASC NULLS FIRST`,
    limit: BATCH_CAP,
  });

  await _processWorkerBatch(
    candidates.map(c => ({
      id: c.id,
      prNumber: c.prNumber!,
      prUrl: c.prUrl,
      workspaceId: c.workspaceId,
      taskId: c.taskId,
      prLifecycleStatus: c.prLifecycleStatus,
    })),
  );
}

/**
 * Refresh stale PR state from a pre-fetched list of workers (e.g. those
 * already returned by the mission detail query). Avoids a second DB round-trip.
 */
export async function refreshStaleWorkers(candidates: StalePrCandidate[]): Promise<void> {
  const now = Date.now();
  const stale = candidates
    .filter(w => {
      if (!w.prNumber) return false;
      if (TERMINAL_STATUSES.includes(w.prLifecycleStatus as any)) return false;
      const lastChecked = w.prLastCheckedAt?.getTime() ?? 0;
      return now - lastChecked >= STALE_THRESHOLD_MS;
    })
    // Same fairness rule as the DB-backed variant: the cap must take the
    // oldest-checked rows, never an arbitrary slice of the backlog.
    .sort((a, b) => (a.prLastCheckedAt?.getTime() ?? 0) - (b.prLastCheckedAt?.getTime() ?? 0))
    .slice(0, BATCH_CAP);

  await _processWorkerBatch(
    stale.map(w => ({
      id: w.id,
      prNumber: w.prNumber!,
      prUrl: w.prUrl,
      workspaceId: w.workspaceId,
      taskId: w.taskId,
      prLifecycleStatus: w.prLifecycleStatus,
    })),
  );
}

// ─── Internal ─────────────────────────────────────────────────────────────────

const CI_STATUSES = new Set(['ci_running', 'ci_failed', 'ci_green']);

interface _Candidate {
  id: string;
  prNumber: number;
  prUrl?: string | null;
  workspaceId: string;
  taskId: string | null;
  prLifecycleStatus: string | null;
}

async function _processWorkerBatch(candidates: _Candidate[]): Promise<void> {
  if (candidates.length === 0) return;

  /** Repo → installation, memoized for the batch. See pr-reconcile.ts. */
  const installationByRepo = new Map<string, number | null>();
  const resolveInstallationCached = async (repo: string): Promise<number | null> => {
    if (!installationByRepo.has(repo)) {
      installationByRepo.set(repo, await installationIdForRepo(repo).catch(() => null));
    }
    return installationByRepo.get(repo) ?? null;
  };

  // Group by workspace to share one installation token per workspace.
  const byWorkspace = new Map<string, _Candidate[]>();
  for (const w of candidates) {
    if (!byWorkspace.has(w.workspaceId)) byWorkspace.set(w.workspaceId, []);
    byWorkspace.get(w.workspaceId)!.push(w);
  }

  for (const [workspaceId, wsWorkers] of byWorkspace) {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { repo: true },
      with: WORKSPACE_INSTALLATION_WITH,
    });

    // Repo identity from the linked github_repos row, not the free-text column.
    const wsIdentity = pickWorkspaceRepoIdentity(ws);
    const workspaceRepo = wsIdentity.fullName;
    const workspaceInstallationId = wsIdentity.installationId;

    for (let i = 0; i < wsWorkers.length; i++) {
      const worker = wsWorkers[i];

      // The PR's own repo first, the workspace only as a fallback — see
      // lib/repo-scope.ts. `workspaces.repo` holds a URL rather than a slug,
      // and the PR is often in a different repo than the workspace anyway.
      const repo = resolvePrRepo({ prUrl: worker.prUrl, workspaceRepo });
      if (!repo) continue;

      const installationId =
        (repo === workspaceRepo ? workspaceInstallationId : null)
        ?? await resolveInstallationCached(repo)
        ?? workspaceInstallationId;
      if (!installationId) continue;

      if (i > 0) {
        await new Promise<void>(r => setTimeout(r, RATE_LIMIT_MS));
      }

      try {
        const pr = await githubApi(
          installationId,
          `/repos/${repo}/pulls/${worker.prNumber}`,
        ) as { state: string; merged: boolean; merged_at: string | null; head: { sha: string } };

        const now = new Date();
        // The PR resolved, so whatever failure streak this row had is over.
        // Reaching this line means the GitHub call above returned successfully
        // (a throw would have skipped straight to the catch), so this is
        // always a CONFIRMED state — prLastVerifiedAt advances alongside
        // prLastCheckedAt, unlike the catch branch below.
        const update: Record<string, unknown> = {
          prLastCheckedAt: now,
          prLastVerifiedAt: now,
          prCheckFailureCount: 0,
          updatedAt: now,
        };
        let didMerge = false;

        if (pr.merged && pr.merged_at) {
          update.mergedAt = new Date(pr.merged_at);
          update.prLifecycleStatus = 'merged';
          didMerge = true;
        } else if (pr.state === 'closed') {
          update.prLifecycleStatus = 'closed';
        } else if (pr.state === 'open' && CI_STATUSES.has(worker.prLifecycleStatus ?? '')) {
          // Reconcile CI state: fetch live check-suite verdict for open CI-tracked PRs.
          // This corrects stale ci_failed→ci_green and ci_green→ci_failed transitions
          // that webhooks may have missed or not yet delivered.
          const headSha = (pr as any).head?.sha as string | undefined;
          if (headSha) {
            const liveStatus = await fetchCiLifecycleStatus(installationId, repo, headSha);
            if (liveStatus !== null && liveStatus !== worker.prLifecycleStatus) {
              update.prLifecycleStatus = liveStatus;
            }
          }
        }

        await db.update(workers).set(update).where(eq(workers.id, worker.id));

        await triggerEvent(channels.workspace(workspaceId), events.WORKER_PROGRESS, {
          taskId: worker.taskId,
        });

        if (didMerge && worker.taskId) {
          checkDependsOnResolved(worker.taskId).catch(err =>
            console.error(`[pr-state-refresh] checkDependsOnResolved failed for task ${worker.taskId}:`, err),
          );
        }
      } catch (err) {
        // Non-fatal: log and leave prLastCheckedAt unset so next render retries.
        console.error(`[pr-state-refresh] worker ${worker.id} PR #${worker.prNumber}:`, err);
      }
    }
  }
}

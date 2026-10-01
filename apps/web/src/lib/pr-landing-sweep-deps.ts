/**
 * Database, Redis and GitHub bindings for the landing sweeper
 * (lib/pr-landing-sweep.ts holds the orchestration and its idempotency rules).
 *
 * Nothing here decides whether a PR lands. It answers "which PRs might need
 * landing" and "what does landPr need to know about this one"; `landPr` does
 * the deciding. A candidate is dropped here only when `landPr` could not act on
 * it anyway, so calling it would only write a ledger row.
 */

import { db } from '@buildd/core/db';
import { tasks, workers, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { landPr, resolveLandingMode } from '@/lib/pr-landing';
import { readLandingMarker } from '@/lib/pr-landing-marker';
import { readPrReviewStatus } from '@/lib/pr-review-request';
import { resolvePolicy, RESOLVE_POLICY_MISSION_COLUMNS } from '@/lib/merge-policy';
import { resolvePrRepo } from '@/lib/repo-scope';
import { TERMINAL_PR_LIFECYCLE } from '@/lib/dep-gate-contract';
import {
  WORKSPACE_INSTALLATION_WITH,
  pickWorkspaceRepoIdentity,
  installationIdForRepo,
} from '@/lib/workspace-installation';
import { listDue, markDue, clearDue, reseedDue } from '@/lib/redis';
import {
  PR_LANDING_DUE_QUEUE,
  runLandingSweep,
  type LandingSweepDeps,
  type LandingSweepOptions,
  type LandingSweepResult,
  type LandingTarget,
  type PeekedPr,
  type PrRef,
} from '@/lib/pr-landing-sweep';

const TERMINAL_LIFECYCLE = [...TERMINAL_PR_LIFECYCLE];

/**
 * Open worker PRs in an `enforce` workspace whose newest review says approve.
 *
 * Deliberately NOT narrowed to lifecycle `ci_green`: a lost green event leaves
 * a PR at `ci_running`, which is the very case this backstop exists for, and
 * `landPr` reads live CI anyway. Nor narrowed to a review of the current head:
 * an approval carried across a refresh is judged inside `landPr`.
 */
async function listFloor(limit: number): Promise<PrRef[]> {
  const newestReviewVerdict = sql`(
    SELECT COALESCE(rt.result->>'effectiveVerdict', rt.result->'structuredOutput'->>'verdict')
    FROM ${tasks} rt
    WHERE rt.workspace_id = ${workers.workspaceId}
      AND rt.category = 'review'
      AND rt.context->>'prNumber' = ${workers.prNumber}::text
    ORDER BY rt.created_at DESC
    LIMIT 1
  )`;
  const rows = await db
    .selectDistinct({ workspaceId: workers.workspaceId, prNumber: workers.prNumber })
    .from(workers)
    .where(
      and(
        isNotNull(workers.prNumber),
        isNull(workers.mergedAt),
        or(isNull(workers.prLifecycleStatus), notInArray(workers.prLifecycleStatus, TERMINAL_LIFECYCLE)),
        sql`EXISTS (
          SELECT 1 FROM ${workspaces} w
          WHERE w.id = ${workers.workspaceId} AND w.git_config->'landing'->>'mode' = 'enforce'
        )`,
        sql`${newestReviewVerdict} = 'approve'`,
      ),
    )
    .limit(limit);
  return rows.flatMap((r) => (r.prNumber === null ? [] : [{ workspaceId: r.workspaceId, prNumber: r.prNumber }]));
}

/** One run's bindings. Workspace rows are memoised for the run; nothing outlives it. */
export function createLandingSweepDeps(): LandingSweepDeps {
  type WorkspaceRow = NonNullable<Awaited<ReturnType<typeof loadWorkspace>>>;
  const workspaceCache = new Map<string, WorkspaceRow | null>();
  const installationByRepo = new Map<string, number | null>();

  async function loadWorkspace(id: string) {
    return db.query.workspaces.findFirst({
      where: eq(workspaces.id, id),
      with: WORKSPACE_INSTALLATION_WITH,
    });
  }

  async function workspaceFor(id: string): Promise<WorkspaceRow | null> {
    if (!workspaceCache.has(id)) workspaceCache.set(id, (await loadWorkspace(id)) ?? null);
    return workspaceCache.get(id) ?? null;
  }

  async function installationFor(repo: string): Promise<number | null> {
    if (!installationByRepo.has(repo)) {
      installationByRepo.set(repo, await installationIdForRepo(repo).catch(() => null));
    }
    return installationByRepo.get(repo) ?? null;
  }

  return {
    listFloor,
    listDue: (nowMs, limit) => listDue(PR_LANDING_DUE_QUEUE, nowMs, limit),

    async resolveTarget(ref) {
      const worker = await db.query.workers.findFirst({
        where: and(
          eq(workers.workspaceId, ref.workspaceId),
          eq(workers.prNumber, ref.prNumber),
          isNull(workers.mergedAt),
          or(isNull(workers.prLifecycleStatus), notInArray(workers.prLifecycleStatus, TERMINAL_LIFECYCLE)),
        ),
        orderBy: desc(workers.createdAt),
        columns: { id: true, taskId: true, prUrl: true, prBaseRef: true },
      });
      if (!worker) return { ok: false, skip: 'no_open_worker' };

      const workspace = await workspaceFor(ref.workspaceId);
      if (!workspace) return { ok: false, skip: 'no_open_worker' };
      if (resolveLandingMode(workspace.gitConfig) !== 'enforce') return { ok: false, skip: 'not_enforce' };

      // Same policy chain the webhook resolves on a green check suite.
      const task = worker.taskId
        ? await db.query.tasks.findFirst({
            where: eq(tasks.id, worker.taskId),
            with: { mission: { columns: RESOLVE_POLICY_MISSION_COLUMNS } },
            columns: { id: true, requiresReview: true, missionId: true },
          })
        : null;
      const mission = task?.mission ?? null;
      const policyFor = (baseRef: string | null) =>
        resolvePolicy(workspace, mission, task ?? null, { baseRef: baseRef ?? worker.prBaseRef });
      if (policyFor(worker.prBaseRef).tier === 'human') return { ok: false, skip: 'human_tier' };

      const review = await readPrReviewStatus({ workspaceId: ref.workspaceId, prNumber: ref.prNumber });
      if (review.state !== 'approved') return { ok: false, skip: 'not_approved' };

      const identity = pickWorkspaceRepoIdentity(workspace);
      const repo = resolvePrRepo({ prUrl: worker.prUrl, workspaceRepo: identity.fullName });
      if (!repo) return { ok: false, skip: 'no_repo' };
      const installationId =
        (repo === identity.fullName ? identity.installationId : null)
        ?? (await installationFor(repo))
        ?? identity.installationId;
      if (!installationId) return { ok: false, skip: 'no_installation' };

      const target: LandingTarget = {
        workspaceId: ref.workspaceId,
        prNumber: ref.prNumber,
        installationId,
        repoFullName: repo,
        policyFor,
        owner: { taskId: worker.taskId, workerId: worker.id },
        mission,
        releaseConfig: workspace.releaseConfig ?? null,
        gitConfig: workspace.gitConfig ?? null,
      };
      return { ok: true, target };
    },

    async peek(target): Promise<PeekedPr> {
      const pr = (await githubApi(target.installationId, `/repos/${target.repoFullName}/pulls/${target.prNumber}`)) as {
        state?: string;
        merged?: boolean;
        draft?: boolean;
        head?: { sha?: string };
        base?: { ref?: string };
      };
      const headSha = pr.head?.sha;
      if (!headSha) throw new Error('GitHub returned no head commit');
      return {
        state: pr.merged ? 'merged' : pr.state === 'open' ? 'open' : 'closed',
        draft: pr.draft === true,
        headSha,
        baseRef: pr.base?.ref ?? null,
      };
    },

    readMarker: (target) =>
      target.owner.taskId ? readLandingMarker(target.owner.taskId, target.prNumber) : Promise.resolve(null),

    // No `dispatchFix`: the doors have not handed the fix-filing logic over, and
    // wiring a second copy here would be a second decision path. Until one
    // does, a `needs_fix` the sweep produces carries no task id.
    land: (input) => landPr(input),

    markDue: (member, dueAtMs) => markDue(PR_LANDING_DUE_QUEUE, member, dueAtMs),
    clearDue: (members) => clearDue(PR_LANDING_DUE_QUEUE, members),
    reseedDue: (entries) => reseedDue(PR_LANDING_DUE_QUEUE, entries),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

/** The sweep as the cron route calls it. */
export function sweepLandingPrs(opts: LandingSweepOptions): Promise<LandingSweepResult> {
  return runLandingSweep(opts, createLandingSweepDeps());
}

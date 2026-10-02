/**
 * Database, Redis and GitHub bindings for the red-PR sweep
 * (lib/ci-red-sweep.ts holds the orchestration and its idempotency rules).
 *
 * Nothing here decides whether a PR gets a CI retry: `retryCiFailureForPr`
 * (the webhook's own function) does. This answers "which PRs are red", "is
 * this one still red, and since when", and "who owns it".
 */

import { db } from '@buildd/core/db';
import { tasks, workers, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, isNotNull, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { ciLifecycleFromSuites } from '@/lib/ci-lifecycle';
import { resolvePrRepo } from '@/lib/repo-scope';
import { TERMINAL_PR_LIFECYCLE } from '@/lib/dep-gate-contract';
import {
  WORKSPACE_INSTALLATION_WITH,
  pickWorkspaceRepoIdentity,
  installationIdForRepo,
} from '@/lib/workspace-installation';
import { listDue, markDue, clearDue, reseedDue } from '@/lib/redis';
import { fireGateEvent, GATE_SLUGS } from '@/lib/gate-ledger';
import { escalateCiRedHead, isAdoptedPrTask, retryCiFailureForPr } from '@/lib/ci-failure-retry';
import { CI_RED_DUE_QUEUE } from '@/lib/ci-red-queue';
import {
  runCiRedSweep,
  type CiRedChecks,
  type CiRedPeek,
  type CiRedSweepDeps,
  type CiRedSweepOptions,
  type CiRedSweepResult,
  type CiRedTarget,
} from '@/lib/ci-red-sweep';

const TERMINAL_LIFECYCLE = [...TERMINAL_PR_LIFECYCLE];

/**
 * Open worker PRs whose lifecycle is `ci_failed` and whose owner has not been
 * stopped. A stopped owner (failed — which is what an escalation sets — or
 * cancelled) is already a human's; an adopted PR's bookkeeping task is always
 * `completed`, so it stays in. Exported so the predicate can be rendered and
 * asserted rather than mocked away.
 */
export function ciRedFloorWhere(): SQL {
  return and(
    isNotNull(workers.prNumber),
    isNull(workers.mergedAt),
    eq(workers.prLifecycleStatus, 'ci_failed'),
    sql`EXISTS (
      SELECT 1 FROM ${tasks} t
      WHERE t.id = ${workers.taskId}
        AND (t.status NOT IN ('failed', 'cancelled') OR coalesce(t.context->>'adoptedPr', 'false') <> 'false')
    )`,
  )!;
}

async function listFloor(limit: number) {
  const rows = await db
    .selectDistinct({ workspaceId: workers.workspaceId, prNumber: workers.prNumber })
    .from(workers)
    .where(ciRedFloorWhere())
    .limit(limit);
  return rows.flatMap((r) => (r.prNumber === null ? [] : [{ workspaceId: r.workspaceId, prNumber: r.prNumber }]));
}

/** The head's verdict and when it went red, from its check suites. */
export function checksFromSuites(
  suites: Array<{ status: string; conclusion: string | null; latest_check_runs_count?: number; updated_at?: string | null }> | null | undefined,
): CiRedChecks {
  const lifecycle = ciLifecycleFromSuites(suites);
  let redSinceMs: number | null = null;
  if (lifecycle === 'ci_failed') {
    for (const s of suites ?? []) {
      if (s.status !== 'completed' || ['success', 'skipped', 'neutral'].includes(s.conclusion ?? '')) continue;
      const at = s.updated_at ? Date.parse(s.updated_at) : NaN;
      if (!Number.isNaN(at) && (redSinceMs === null || at > redSinceMs)) redSinceMs = at;
    }
  }
  return { lifecycle, redSinceMs };
}

export function createCiRedSweepDeps(): CiRedSweepDeps {
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
    listDue: (nowMs, limit) => listDue(CI_RED_DUE_QUEUE, nowMs, limit),

    async resolveTarget(ref) {
      const worker = await db.query.workers.findFirst({
        where: and(
          eq(workers.workspaceId, ref.workspaceId),
          eq(workers.prNumber, ref.prNumber),
          isNull(workers.mergedAt),
          or(isNull(workers.prLifecycleStatus), notInArray(workers.prLifecycleStatus, TERMINAL_LIFECYCLE)),
        ),
        orderBy: desc(workers.createdAt),
        columns: { id: true, taskId: true, prUrl: true },
      });
      if (!worker?.taskId) return { ok: false, skip: 'no_open_worker' };

      const task = await db.query.tasks.findFirst({
        where: eq(tasks.id, worker.taskId),
        columns: { id: true, title: true, workspaceId: true, missionId: true, status: true, context: true, result: true },
      });
      if (!task) return { ok: false, skip: 'no_open_worker' };
      if ((task.status === 'failed' || task.status === 'cancelled') && !isAdoptedPrTask(task)) {
        return { ok: false, skip: 'owner_stopped' };
      }

      const workspace = await workspaceFor(ref.workspaceId);
      if (!workspace) return { ok: false, skip: 'no_open_worker' };
      const identity = pickWorkspaceRepoIdentity(workspace);
      const repo = resolvePrRepo({ prUrl: worker.prUrl, workspaceRepo: identity.fullName });
      if (!repo) return { ok: false, skip: 'no_repo' };
      const installationId =
        (repo === identity.fullName ? identity.installationId : null)
        ?? (await installationFor(repo))
        ?? identity.installationId;
      if (!installationId) return { ok: false, skip: 'no_installation' };

      const target: CiRedTarget = {
        workspaceId: ref.workspaceId,
        prNumber: ref.prNumber,
        installationId,
        repoFullName: repo,
        owner: {
          taskId: task.id,
          workerId: worker.id,
          title: task.title,
          workspaceId: task.workspaceId,
          missionId: task.missionId ?? null,
          status: task.status,
          context: (task.context as Record<string, unknown> | null) ?? null,
          result: task.result,
        },
      };
      return { ok: true, target };
    },

    async peek(target): Promise<CiRedPeek> {
      const pr = (await githubApi(target.installationId, `/repos/${target.repoFullName}/pulls/${target.prNumber}`)) as {
        state?: string;
        merged?: boolean;
        draft?: boolean;
        head?: { sha?: string };
      };
      const headSha = pr.head?.sha;
      if (!headSha) throw new Error('GitHub returned no head commit');
      return {
        state: pr.merged ? 'merged' : pr.state === 'open' ? 'open' : 'closed',
        draft: pr.draft === true,
        headSha,
      };
    },

    async readChecks(target, headSha) {
      const data = (await githubApi(
        target.installationId,
        `/repos/${target.repoFullName}/commits/${headSha}/check-suites`,
      )) as { check_suites?: Parameters<typeof checksFromSuites>[0] };
      return checksFromSuites(data?.check_suites);
    },

    retry: (input) => retryCiFailureForPr(input),

    async escalateNoPush(target, headSha, priorAttemptTaskId) {
      const detail =
        `An attempt already ran on PR #${target.prNumber} at this head and finished without pushing; ` +
        `CI is still red and no fix is in flight.`;
      const escalated = await escalateCiRedHead({
        installationId: target.installationId,
        repoFullName: target.repoFullName,
        prNumber: target.prNumber,
        headSha,
        task: {
          id: target.owner.taskId,
          title: target.owner.title,
          workspaceId: target.owner.workspaceId,
          missionId: target.owner.missionId,
          result: target.owner.result,
        },
        detail,
        missionTitle: 'CI failing — fix attempt pushed nothing',
        missionMessage: `${target.owner.title} — CI is still red after a fix attempt that pushed nothing. Needs a human.`,
      });
      if (escalated) {
        fireGateEvent({
          gate: GATE_SLUGS.CI_RETRY_SKIPPED,
          surface: 'cron:ci-red',
          outcome: 'stranded',
          reason: 'red PR escalated: an attempt already ran on this head and pushed nothing',
          workspaceId: target.workspaceId,
          taskId: target.owner.taskId,
          workerId: target.owner.workerId,
          callerOrigin: 'system',
          detail: {
            skipReason: 'head_already_retried',
            escalated: true,
            prNumber: target.prNumber,
            headSha,
            repo: target.repoFullName,
            priorAttemptTaskId,
          },
        });
      }
      return escalated;
    },

    markDue: (member, dueAtMs) => markDue(CI_RED_DUE_QUEUE, member, dueAtMs),
    clearDue: (members) => clearDue(CI_RED_DUE_QUEUE, members),
    reseedDue: (entries) => reseedDue(CI_RED_DUE_QUEUE, entries),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

/** The sweep as the cron route calls it. */
export function sweepCiRedPrs(opts: CiRedSweepOptions): Promise<CiRedSweepResult> {
  return runCiRedSweep(opts, createCiRedSweepDeps());
}

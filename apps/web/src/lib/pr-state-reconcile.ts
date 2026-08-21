import { db } from '@buildd/core/db';
import {
  githubInstallations,
  missions,
  tasks,
  workers,
  workspaces,
} from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { githubApi as _githubApi } from '@/lib/github';

export interface PrStateFix {
  workerId: string;
  prUrl: string;
  prNumber: number;
  before: { mergedAt: string | null; prLifecycleStatus: string | null };
  after: { mergedAt: string | null; prLifecycleStatus: string };
}

export interface ReconcileResult {
  checked: number;
  fixes: PrStateFix[];
  /** PRs we could not verify (no installation, or GitHub errored). */
  unverified: Array<{ prUrl: string; reason: string }>;
}

/** `https://github.com/owner/name/pull/7` → `{ repo: 'owner/name', number: 7 }` */
export function parsePrUrl(prUrl: string): { repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(prUrl);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

/**
 * Reconciles worker PR state against GitHub.
 *
 * buildd learns that a PR merged from a single `pull_request` webhook delivery.
 * GitHub does not retry App webhooks, and until repo-scoped lookups landed a
 * delivery could be applied to the wrong repo's worker entirely — so a merged
 * PR could sit with `mergedAt = null` forever, silently blocking every task
 * that depends on it and leaving an unsatisfiable "merge this" card on the
 * dashboard. This asks GitHub for the truth and writes it down.
 *
 * Read-mostly, no agent spend, and idempotent: safe to call on page open.
 */
export async function reconcileWorkerPrState(
  workerRows: Array<{
    id: string;
    prUrl: string;
    prNumber: number | null;
    mergedAt: Date | string | null;
    prLifecycleStatus: string | null;
    workspaceId: string;
  }>,
  opts?: { dryRun?: boolean; githubApi?: typeof _githubApi },
): Promise<ReconcileResult> {
  const githubApi = opts?.githubApi ?? _githubApi;
  const fixes: PrStateFix[] = [];
  const unverified: ReconcileResult['unverified'] = [];

  // Resolve one installation id per workspace up front.
  const workspaceIds = [...new Set(workerRows.map((w) => w.workspaceId))];
  const installationByWorkspace = new Map<string, number>();
  if (workspaceIds.length > 0) {
    const rows = await db
      .select({
        workspaceId: workspaces.id,
        installationId: githubInstallations.installationId,
      })
      .from(workspaces)
      .innerJoin(githubInstallations, eq(githubInstallations.id, workspaces.githubInstallationId))
      .where(inArray(workspaces.id, workspaceIds));
    for (const r of rows) installationByWorkspace.set(r.workspaceId, r.installationId);
  }

  for (const worker of workerRows) {
    const parsed = parsePrUrl(worker.prUrl);
    if (!parsed) {
      unverified.push({ prUrl: worker.prUrl, reason: 'unparseable prUrl' });
      continue;
    }
    const installationId = installationByWorkspace.get(worker.workspaceId);
    if (!installationId) {
      unverified.push({ prUrl: worker.prUrl, reason: 'workspace has no GitHub installation' });
      continue;
    }

    let pr: { merged_at?: string | null; state?: string } | null = null;
    try {
      pr = await githubApi(installationId, `/repos/${parsed.repo}/pulls/${parsed.number}`);
    } catch (e) {
      unverified.push({ prUrl: worker.prUrl, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (!pr) {
      unverified.push({ prUrl: worker.prUrl, reason: 'empty GitHub response' });
      continue;
    }

    const truthMergedAt = pr.merged_at ?? null;
    const truthLifecycle = truthMergedAt ? 'merged' : pr.state === 'closed' ? 'closed' : 'pr_open';
    const currentMergedAt = worker.mergedAt ? new Date(worker.mergedAt).toISOString() : null;

    // Compare merge instants at second precision: buildd stamps its own
    // `new Date()` on the webhook, a beat after GitHub's merge_at.
    const sameInstant =
      currentMergedAt != null &&
      truthMergedAt != null &&
      Math.abs(new Date(currentMergedAt).getTime() - new Date(truthMergedAt).getTime()) < 60_000;
    const mergeStateMatches = (currentMergedAt == null && truthMergedAt == null) || sameInstant;

    if (mergeStateMatches && worker.prLifecycleStatus === truthLifecycle) continue;

    const fix: PrStateFix = {
      workerId: worker.id,
      prUrl: worker.prUrl,
      prNumber: parsed.number,
      before: { mergedAt: currentMergedAt, prLifecycleStatus: worker.prLifecycleStatus },
      after: { mergedAt: truthMergedAt, prLifecycleStatus: truthLifecycle },
    };
    fixes.push(fix);

    if (!opts?.dryRun) {
      await db
        .update(workers)
        .set({
          mergedAt: truthMergedAt ? new Date(truthMergedAt) : null,
          prLifecycleStatus: truthLifecycle as any,
          updatedAt: new Date(),
        })
        .where(eq(workers.id, worker.id));
    }
  }

  return { checked: workerRows.length, fixes, unverified };
}

/** `reconcileWorkerPrState` over every PR-bearing worker in one mission. */
export async function reconcileMissionPrState(
  missionId: string,
  opts?: { dryRun?: boolean; githubApi?: typeof _githubApi },
): Promise<ReconcileResult> {
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { id: true },
  });
  if (!mission) return { checked: 0, fixes: [], unverified: [] };

  const rows = await db
    .select({
      id: workers.id,
      prUrl: workers.prUrl,
      prNumber: workers.prNumber,
      mergedAt: workers.mergedAt,
      prLifecycleStatus: workers.prLifecycleStatus,
      workspaceId: workers.workspaceId,
    })
    .from(workers)
    .innerJoin(tasks, eq(tasks.id, workers.taskId))
    .where(and(eq(tasks.missionId, missionId), isNotNull(workers.prUrl)));

  return reconcileWorkerPrState(
    rows.filter((r): r is typeof r & { prUrl: string } => r.prUrl != null),
    opts,
  );
}

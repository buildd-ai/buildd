/**
 * Import what GitHub says about a set of worker PRs into the fact cache
 * (docs/specs/workflow-state-kernel.md §11: a reconciler may import a fact, it
 * may never assign state). Replaces `pr-state-reconcile.ts`, which wrote the
 * columns directly and mapped every open PR back to `pr_open`, regressing a
 * `ci_green` or `conflict` reading the webhooks had recorded.
 *
 * A merged or closed PR becomes a `recordPrFact` fact (terminal wins, GitHub's
 * `merged_at`); a kernel-owned delivery imports the same close through the
 * seam. An open PR writes nothing: "still open" is not news, and the webhooks
 * and the CI sweep own the finer open-state facts.
 *
 * Read-mostly, no agent spend, idempotent: safe to call on page open.
 */
import { db } from '@buildd/core/db';
import { missions, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { prFactApplies, recordPrFact, type PrFact } from '@buildd/core/pr-facts';
import { githubApi as _githubApi } from '@/lib/github';
import { WORKSPACE_INSTALLATION_WITH, pickWorkspaceInstallationId } from '@/lib/workspace-installation';

export interface PrFactFix {
  workerId: string;
  prUrl: string;
  prNumber: number;
  before: { mergedAt: string | null; prLifecycleStatus: string | null };
  after: { mergedAt: string | null; prLifecycleStatus: string };
}

export interface PrFactImportResult {
  checked: number;
  fixes: PrFactFix[];
  /** PRs we could not verify (no installation, or GitHub errored). */
  unverified: Array<{ prUrl: string; reason: string }>;
}

/** `https://github.com/owner/name/pull/7` → `{ repo: 'owner/name', number: 7 }` */
export function parsePrUrl(prUrl: string): { repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(prUrl);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

export interface WorkerPrRow {
  id: string;
  prUrl: string;
  prNumber: number | null;
  mergedAt: Date | string | null;
  prLifecycleStatus: string | null;
  workspaceId: string;
}

export interface PrFactImportDeps {
  dryRun?: boolean;
  githubApi?: typeof _githubApi;
  /** Records the fact; injectable for tests. */
  record?: typeof recordPrFact;
  /** §11: hand a close/merge to the kernel for a kernel-owned PR. Injectable for tests. */
  importToKernel?: (p: { workspaceId: string; repoFullName: string; prNumber: number; installationId: number }) => Promise<unknown>;
}

async function defaultImportToKernel(p: { workspaceId: string; repoFullName: string; prNumber: number; installationId: number }): Promise<unknown> {
  const { observePrState } = await import('@/lib/workflow/seam');
  return observePrState({ ...p, source: 'sweep:pr-fact-import' });
}

export async function importWorkerPrFacts(workerRows: WorkerPrRow[], opts: PrFactImportDeps = {}): Promise<PrFactImportResult> {
  const githubApi = opts.githubApi ?? _githubApi;
  const record = opts.record ?? recordPrFact;
  const importToKernel = opts.importToKernel ?? defaultImportToKernel;
  const fixes: PrFactFix[] = [];
  const unverified: PrFactImportResult['unverified'] = [];

  const workspaceIds = [...new Set(workerRows.map((w) => w.workspaceId))];
  const installationByWorkspace = new Map<string, number>();
  if (workspaceIds.length > 0) {
    const rows = await db.query.workspaces.findMany({
      where: inArray(workspaces.id, workspaceIds),
      columns: { id: true },
      with: WORKSPACE_INSTALLATION_WITH,
    });
    for (const r of rows) {
      const installationId = pickWorkspaceInstallationId(r);
      if (installationId) installationByWorkspace.set(r.id, installationId);
    }
  }

  for (const worker of workerRows) {
    const parsed = parsePrUrl(worker.prUrl);
    if (!parsed) { unverified.push({ prUrl: worker.prUrl, reason: 'unparseable prUrl' }); continue; }
    const installationId = installationByWorkspace.get(worker.workspaceId);
    if (!installationId) { unverified.push({ prUrl: worker.prUrl, reason: 'workspace has no GitHub installation' }); continue; }

    let pr: { merged_at?: string | null; merged?: boolean; state?: string } | null = null;
    try {
      pr = await githubApi(installationId, `/repos/${parsed.repo}/pulls/${parsed.number}`);
    } catch (e) {
      unverified.push({ prUrl: worker.prUrl, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (!pr) { unverified.push({ prUrl: worker.prUrl, reason: 'empty GitHub response' }); continue; }

    const fact: PrFact | null = pr.merged_at ? { kind: 'merged', mergedAt: pr.merged_at } : pr.state === 'closed' ? { kind: 'closed' } : null;
    if (!fact) continue;
    const before = { mergedAt: worker.mergedAt ? new Date(worker.mergedAt).toISOString() : null, prLifecycleStatus: worker.prLifecycleStatus };
    const fix: PrFactFix = {
      workerId: worker.id, prUrl: worker.prUrl, prNumber: parsed.number, before,
      after: fact.kind === 'merged'
        ? { mergedAt: before.mergedAt ?? new Date(fact.mergedAt).toISOString(), prLifecycleStatus: 'merged' }
        : { mergedAt: before.mergedAt, prLifecycleStatus: 'closed' },
    };
    if (opts.dryRun) {
      if (prFactApplies(fact, { prLifecycleStatus: worker.prLifecycleStatus, mergedAt: worker.mergedAt })) fixes.push(fix);
      continue;
    }
    const applied = await record({ workerId: worker.id }, fact);
    if (applied.length > 0) fixes.push(fix);
    await importToKernel({ workspaceId: worker.workspaceId, repoFullName: parsed.repo, prNumber: parsed.number, installationId })
      .catch((err) => console.error(`[pr-fact-import] kernel close import failed for ${worker.prUrl}:`, err));
  }

  return { checked: workerRows.length, fixes, unverified };
}

/** `importWorkerPrFacts` over every PR-bearing worker in one mission. */
export async function importMissionPrFacts(missionId: string, opts: PrFactImportDeps = {}): Promise<PrFactImportResult> {
  const mission = await db.query.missions.findFirst({ where: eq(missions.id, missionId), columns: { id: true } });
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

  return importWorkerPrFacts(rows.filter((r): r is typeof r & { prUrl: string } => r.prUrl != null), opts);
}

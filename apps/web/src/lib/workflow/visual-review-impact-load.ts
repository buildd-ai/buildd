/**
 * Server side of the visual-impact assessment: reads the mission integration
 * branch diff against trunk and asks the kernel's `visual_impact` decision
 * point (`VISUAL_IMPACT_POINT`) through the `Decide` port, which buildd answers
 * with the `buildd.visual_impact` decision kind (decision-port.ts). No second
 * decision engine: this file only builds the request and maps the response.
 *
 * With a delivery for the mission's integration PR the answer goes through
 * `decideAndRecord`: recorded as a decision fact on that delivery, once per
 * head, and replayed from the fact after that (AC-27, AC-28). Without one it is
 * asked through `decideAt` and recorded nowhere. Either way the decision
 * model's own ledger row is written as before.
 */
import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { missions, workflowDeliveries, workspaces } from '@buildd/core/db/schema';
import { visualReviewPolicyOf } from '@buildd/shared';
import { decideAndRecord, decideAt, VISUAL_IMPACT_POINT, type DecideDeps } from '@buildd/workflow-kernel/decide';
import type { KernelPorts } from '@buildd/workflow-kernel/ports';
import { repoFor } from '@/lib/mission-surface-audit-gate';
import { resolveVisualReviewPolicy } from './visual-review-policy';
import {
  assessVisualImpact,
  impactAnswerOf,
  type ImpactDecider,
  type ImpactFile,
  type VisualImpactAssessment,
} from './visual-review-impact';

/**
 * The decision model's own call is bounded at 5s; the kernel's bound sits
 * above it so a slow but answering model is not cut off by the port.
 */
export const VISUAL_IMPACT_DECIDE_TIMEOUT_MS = 15_000;

/** GitHub's compare endpoint stops at 300 files; past that the list is incomplete. */
const COMPARE_PAGES = 3;
const COMPARE_PAGE_SIZE = 100;

/** The branch diff with patches, or null when it cannot be read completely. */
export async function loadBranchDiff(workspaceId: string, base: string, head: string): Promise<ImpactFile[] | null> {
  try {
    const repo = await repoFor(workspaceId);
    if (!repo) return null;
    const { githubApi } = await import('@/lib/github');
    const files: ImpactFile[] = [];
    for (let page = 1; page <= COMPARE_PAGES; page++) {
      const res = await githubApi(
        repo.installationId,
        `/repos/${repo.fullName}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=${COMPARE_PAGE_SIZE}&page=${page}`,
      ) as { files?: Array<{ filename?: string; previous_filename?: string; patch?: string }> };
      const batch = Array.isArray(res?.files) ? res.files : [];
      for (const f of batch) {
        if (f.filename) files.push({ path: f.filename, patch: f.patch ?? null });
        if (f.previous_filename) files.push({ path: f.previous_filename, patch: null });
      }
      if (batch.length < COMPARE_PAGE_SIZE) return files;
    }
    return null; // 300+ files: treat as unreadable, never as "nothing UI"
  } catch (err) {
    console.error('[visual-review-impact] could not read branch diff (assessing as review_required):', err);
    return null;
  }
}

/**
 * Jev at the kernel's `visual_impact` point: the port's decider, bounded and
 * defaulted by the package, recorded on `delivery` when the mission's PR has one.
 */
export function createBuilddImpactDecider(
  scope: { teamId: string; workspaceId: string; missionId: string },
  ports: Pick<KernelPorts, 'store' | 'decide'>,
  delivery: { deliveryId: string; headSha: string; prNumber: number | null } | null,
): ImpactDecider {
  return async features => {
    const deps: Omit<DecideDeps, 'recorded'> = { decide: ports.decide, timeoutMs: VISUAL_IMPACT_DECIDE_TIMEOUT_MS };
    const input = { headSha: delivery?.headSha ?? '', features: features as unknown, scope };
    const { fact } = delivery
      ? await decideAndRecord(ports.store, { workspaceId: scope.workspaceId, deliveryId: delivery.deliveryId, prNumber: delivery.prNumber, source: 'visual_impact' }, VISUAL_IMPACT_POINT, input, deps)
      : await decideAt(VISUAL_IMPACT_POINT, input, deps);
    return impactAnswerOf(fact);
  };
}

/** Assess a mission's integration branch at its current head. Null when the mission or its workspace is gone. */
export async function assessMissionVisualImpact(missionId: string): Promise<VisualImpactAssessment | null> {
  const mission = await db.query.missions.findFirst({
    where: sqlWhere(eq(missions.id, missionId)),
    columns: { id: true, workspaceId: true, autoSurfaceAudit: true, workingBranch: true, primaryPrNumber: true },
  });
  if (!mission?.workspaceId) return null;
  const ws = await db.query.workspaces.findFirst({
    where: sqlWhere(eq(workspaces.id, mission.workspaceId)),
    columns: { teamId: true, gitConfig: true },
  });
  if (!ws) return null;

  const policy = resolveVisualReviewPolicy({
    workspace: visualReviewPolicyOf(ws.gitConfig),
    mission: { autoSurfaceAudit: mission.autoSurfaceAudit },
  });

  let headSha: string | null = null;
  let deliveryId: string | null = null;
  const configuredBase = (ws.gitConfig as { defaultBranch?: unknown } | null)?.defaultBranch;
  let base = typeof configuredBase === 'string' ? configuredBase : null;
  if (mission.primaryPrNumber) {
    const [d] = await db
      .select({ id: workflowDeliveries.id, currentHeadSha: workflowDeliveries.currentHeadSha, baseRef: workflowDeliveries.baseRef })
      .from(workflowDeliveries)
      .where(and(eq(workflowDeliveries.workspaceId, mission.workspaceId), eq(workflowDeliveries.prNumber, mission.primaryPrNumber)))
      .limit(1);
    headSha = d?.currentHeadSha ?? null;
    deliveryId = d?.id ?? null;
    base = d?.baseRef ?? base;
  }

  // Policy off needs no diff at all.
  const files = policy.mode === 'off' || !base || !headSha ? null : await loadBranchDiff(mission.workspaceId, base, headSha);
  const { ports } = await (await import('./kernel-ports')).workflowKernel();
  return assessVisualImpact({
    policy,
    files,
    headSha,
    decide: createBuilddImpactDecider(
      { teamId: ws.teamId, workspaceId: mission.workspaceId, missionId },
      ports,
      deliveryId && headSha ? { deliveryId, headSha, prNumber: mission.primaryPrNumber ?? null } : null,
    ),
  });
}

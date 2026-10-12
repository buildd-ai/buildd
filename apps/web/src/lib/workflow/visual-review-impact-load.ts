/**
 * Server side of the visual-impact assessment: reads the mission integration
 * branch diff against trunk and asks the `buildd.visual_impact` decision kind
 * through the shared decision substrate. No second decision engine: this file
 * only builds the request and maps the response. Reads only; nothing is
 * written except the decision ledger row `runBuilddDecision` always writes.
 */
import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { missions, workflowDeliveries, workspaces } from '@buildd/core/db/schema';
import { visualReviewPolicyOf } from '@buildd/shared';
import { runBuilddDecision } from '@buildd/core/decision-policy';
import { visualImpactKind } from '@buildd/core/decision-kind-visual-impact';
import { repoFor } from '@/lib/mission-surface-audit-gate';
import { resolveVisualReviewPolicy } from './visual-review-policy';
import {
  assessVisualImpact,
  type ImpactDecider,
  type ImpactFile,
  type VisualImpactAssessment,
} from './visual-review-impact';

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

/** Jev, through `runBuilddDecision` (capability check, the team's decision model, the ledger row). */
export function createBuilddImpactDecider(scope: { teamId: string; workspaceId: string; missionId: string }): ImpactDecider {
  return async features => {
    const response = await runBuilddDecision(
      visualImpactKind,
      { features, subjectRef: { type: 'mission', id: scope.missionId } },
      { teamId: scope.teamId, workspaceId: scope.workspaceId, missionId: scope.missionId },
    );
    return { decision: response.decision, confidence: response.confidence, reasonCode: response.reasonCode, source: response.source };
  };
}

/** Assess a mission's integration branch at its current head. Null when the mission or its workspace is gone. */
export async function assessMissionVisualImpact(missionId: string): Promise<VisualImpactAssessment | null> {
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { id: true, workspaceId: true, autoSurfaceAudit: true, workingBranch: true, primaryPrNumber: true },
  });
  if (!mission?.workspaceId) return null;
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, mission.workspaceId),
    columns: { teamId: true, gitConfig: true },
  });
  if (!ws) return null;

  const policy = resolveVisualReviewPolicy({
    workspace: visualReviewPolicyOf(ws.gitConfig),
    mission: { autoSurfaceAudit: mission.autoSurfaceAudit },
  });

  let headSha: string | null = null;
  let base = (ws.gitConfig as { defaultBranch?: string } | null)?.defaultBranch ?? null;
  if (mission.primaryPrNumber) {
    const [d] = await db
      .select({ currentHeadSha: workflowDeliveries.currentHeadSha, baseRef: workflowDeliveries.baseRef })
      .from(workflowDeliveries)
      .where(and(eq(workflowDeliveries.workspaceId, mission.workspaceId), eq(workflowDeliveries.prNumber, mission.primaryPrNumber)))
      .limit(1);
    headSha = d?.currentHeadSha ?? null;
    base = d?.baseRef ?? base;
  }

  // Policy off needs no diff at all.
  const files = policy.mode === 'off' || !base || !headSha ? null : await loadBranchDiff(mission.workspaceId, base, headSha);
  return assessVisualImpact({
    policy,
    files,
    headSha,
    decide: createBuilddImpactDecider({ teamId: ws.teamId, workspaceId: mission.workspaceId, missionId }),
  });
}

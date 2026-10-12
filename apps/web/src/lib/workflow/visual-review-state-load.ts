/**
 * The one helper every surface reads for a mission's visual-review state:
 * gathers the inputs (workspace policy, the surface-audit gate, the visual
 * review model, the waiver, the integration PR delivery) and hands them to the
 * pure `deriveMissionVisualReview`. Server-only. Reads only; the lifecycle
 * writers stay `ensureMissionSurfaceAudit` / `requestMissionSurfaceAudit`.
 */
import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { isTerminalTaskStatus } from '@buildd/shared';
import { missions, workflowDeliveries, workspaces } from '@buildd/core/db/schema';
import { visualReviewPolicyOf } from '@buildd/shared';
import { evaluateSurfaceAuditGate, loadSurfaceAuditGateTasks, loadSurfaceAuditWaiver } from '@/lib/mission-surface-audit-gate';
import { loadVisualReview } from '@/lib/visual-review-load';
import { resolveVisualReviewPolicy } from './visual-review-policy';
import {
  deriveMissionVisualReview,
  integrationPrFromDeliveryState,
  type MissionVisualReviewState,
  type VisualReviewStateInput,
} from './visual-review-state';



export async function getMissionVisualReviewState(missionId: string): Promise<MissionVisualReviewState | null> {
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { id: true, workspaceId: true, autoSurfaceAudit: true, workingBranch: true, primaryPrNumber: true },
  });
  if (!mission) return null;

  const [ws, tasks, waiver] = await Promise.all([
    mission.workspaceId
      ? db.query.workspaces.findFirst({ where: eq(workspaces.id, mission.workspaceId), columns: { gitConfig: true, githubRepoId: true } })
      : Promise.resolve(undefined),
    loadSurfaceAuditGateTasks(missionId),
    loadSurfaceAuditWaiver(missionId),
  ]);
  const gitConfig = (ws?.gitConfig ?? null) as { defaultBranch?: string } | null;
  const policy = resolveVisualReviewPolicy({
    workspace: visualReviewPolicyOf(ws?.gitConfig),
    mission: { autoSurfaceAudit: mission.autoSurfaceAudit },
  });

  const model = await loadVisualReview({ id: mission.id, workspaceId: mission.workspaceId });
  const gate = await evaluateSurfaceAuditGate({ id: mission.id, autoSurfaceAudit: true }, tasks).catch(() => null);
  const uiChange: VisualReviewStateInput['uiChange'] =
    gate && gate.required ? { state: 'yes', source: gate.source, uiFiles: gate.uiPaths.length }
    : gate && gate.why === 'no_ui_change' ? { state: 'no', source: null, uiFiles: 0 }
    : { state: 'unknown', source: null, uiFiles: 0 };

  let integrationPr: VisualReviewStateInput['branch']['integrationPr'] = null;
  let headSha: string | null = null;
  let base: string | null = gitConfig?.defaultBranch ?? null;
  if (mission.primaryPrNumber && mission.workspaceId) {
    const [d] = await db
      .select({ state: workflowDeliveries.state, currentHeadSha: workflowDeliveries.currentHeadSha, baseRef: workflowDeliveries.baseRef })
      .from(workflowDeliveries)
      .where(and(eq(workflowDeliveries.workspaceId, mission.workspaceId), eq(workflowDeliveries.prNumber, mission.primaryPrNumber)))
      .limit(1);
    if (d) {
      integrationPr = integrationPrFromDeliveryState(mission.primaryPrNumber, d.state);
      headSha = d.currentHeadSha ?? null;
      base = d.baseRef ?? base;
    }
  }

  const uiBuilders = tasks.filter(t => t.taskClass === 'work' && t.roleSlug !== 'visual-auditor');
  const audit = model.audit ? { id: model.audit.id, createdAt: model.audit.createdAt, errorType: model.audit.errorType } : null;

  return deriveMissionVisualReview({
    policy,
    uiChange,
    audit,
    review: audit
      ? {
          phase: model.phase,
          screens: model.summary.shots,
          effectiveIssues: model.summary.effectiveIssues,
          awaitingHuman: model.summary.awaitingHuman,
          openFixes: model.fixTasks.filter(f => !isTerminalTaskStatus(f.status)).length,
          roundCapOpen: model.roundCapOpen,
          needsYouReason: model.needsYou?.reason ?? null,
          captured: model.progress?.captured ?? 0,
          expected: model.progress?.expected ?? null,
        }
      : null,
    waiver,
    branch: { headSha, base, integrationPr, workLanded: uiBuilders.length > 0 && uiBuilders.every(t => isTerminalTaskStatus(t.status)) },
  });
}

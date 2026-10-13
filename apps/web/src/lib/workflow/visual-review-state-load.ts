/**
 * The one helper every surface reads for a mission's visual-review state:
 * gathers the inputs (workspace policy, the surface-audit gate, the visual
 * review model, the waiver, the integration PR delivery) and hands them to the
 * pure `deriveMissionVisualReview`. Server-only. Reads only; the lifecycle
 * writers stay `ensureMissionSurfaceAudit` / `requestMissionSurfaceAudit`.
 */
import 'server-only';
import { and, desc, eq, like } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { sqlWhere, sqlOrderBy } from '@buildd/core/db/relational-sql';
import { isTerminalTaskStatus } from '@buildd/shared';
import { missions, tasks as tasksTable, workflowDeliveries, workspaces } from '@buildd/core/db/schema';
import { SURFACE_AUDIT_TITLE_PREFIX, surfaceAuditRound } from '@buildd/core/surface-audit';
import { visualReviewPolicyOf } from '@buildd/shared';
import { evaluateSurfaceAuditGate, loadSurfaceAuditGateTasks, loadSurfaceAuditWaiver } from '@/lib/mission-surface-audit-gate';
import { loadVisualReview } from '@/lib/visual-review-load';
import { resolveVisualReviewPolicy } from './visual-review-policy';
import { autoRetriesLeft, type ScheduleAudit } from './visual-review-schedule';
import {
  deriveMissionVisualReview,
  integrationPrFromDeliveryState,
  captureConfigErrorFrom,
  readAuditedSha,
  type MissionVisualReviewState,
  type VisualReviewStateInput,
} from './visual-review-state';


/** The mission's audit tasks, newest first, in the shape the scheduler and the evidence check read. */
export async function loadMissionAuditLedger(missionId: string): Promise<ScheduleAudit[]> {
  const rows = await db.query.tasks.findMany({
    where: sqlWhere(and(eq(tasksTable.missionId, missionId), like(tasksTable.title, `${SURFACE_AUDIT_TITLE_PREFIX}%`))),
    columns: { id: true, title: true, status: true, context: true, result: true, updatedAt: true, createdAt: true },
    orderBy: sqlOrderBy(desc(tasksTable.createdAt)),
  });
  return rows.map(r => ({
    id: r.id,
    status: r.status,
    round: surfaceAuditRound(r),
    headSha: readAuditedSha(r.context),
    updatedAt: new Date(r.updatedAt ?? r.createdAt).getTime(),
    captureConfigError: r.status === 'failed' ? captureConfigErrorFrom(r.result) : null,
  }));
}

export async function getMissionVisualReviewState(
  missionId: string,
  opts: { uiChange?: VisualReviewStateInput['uiChange'] } = {},
): Promise<MissionVisualReviewState | null> {
  const mission = await db.query.missions.findFirst({
    where: sqlWhere(eq(missions.id, missionId)),
    columns: { id: true, workspaceId: true, autoSurfaceAudit: true, workingBranch: true, primaryPrNumber: true },
  });
  if (!mission) return null;

  const [ws, tasks, waiver] = await Promise.all([
    mission.workspaceId
      ? db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, mission.workspaceId)), columns: { gitConfig: true, githubRepoId: true } })
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
  const gateUiChange: VisualReviewStateInput['uiChange'] =
    gate && gate.required ? { state: 'yes', source: gate.source, uiFiles: gate.uiPaths.length }
    : gate && gate.why === 'no_ui_change' ? { state: 'no', source: null, uiFiles: 0 }
    : { state: 'unknown', source: null, uiFiles: 0 };
  const uiChange = opts.uiChange ?? gateUiChange;

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
  const ledger = await loadMissionAuditLedger(missionId);
  const latestAudit = ledger.find(a => a.id === model.audit?.id) ?? null;
  const failedOnHead = headSha ? ledger.filter(a => a.status === 'failed' && a.headSha === headSha).length : 0;
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
    auditedSha: latestAudit ? latestAudit.headSha : null,
    autoRetriesLeft: autoRetriesLeft(failedOnHead),
    captureConfigError: latestAudit?.captureConfigError ?? null,
    branch: { headSha, base, integrationPr, workLanded: uiBuilders.length > 0 && uiBuilders.every(t => isTerminalTaskStatus(t.status)) },
  });
}

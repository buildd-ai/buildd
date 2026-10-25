import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { missions, workflowDeliveries } from '@buildd/core/db/schema';
import { requestMissionSurfaceAudit, type RequestSurfaceAuditResult } from '@/lib/mission-surface-audit';
import { loadMissionAuditLedgers } from '@/lib/workflow/visual-review-state-load';

export type RecheckResult = RequestSurfaceAuditResult | { ok: false; reason: 'no_head' };

/**
 * A person asked for the screens to be checked again. A queued or running audit
 * is returned as it is; otherwise the next round is filed for the integration
 * branch's current head, whatever the schedule's policy says (it is a person's
 * request, not the automatic filing). Nothing is filed without a head to name.
 */
export async function recheckMissionVisualReview(missionId: string): Promise<RecheckResult> {
  const [mission] = await db
    .select({ workspaceId: missions.workspaceId, primaryPrNumber: missions.primaryPrNumber })
    .from(missions)
    .where(eq(missions.id, missionId))
    .limit(1);
  if (!mission) return { ok: false, reason: 'mission_not_found' };
  let headSha: string | null = null;
  if (mission.workspaceId && mission.primaryPrNumber != null) {
    const [d] = await db
      .select({ head: workflowDeliveries.currentHeadSha })
      .from(workflowDeliveries)
      .where(and(eq(workflowDeliveries.workspaceId, mission.workspaceId), eq(workflowDeliveries.prNumber, mission.primaryPrNumber)))
      .limit(1);
    headSha = d?.head ?? null;
  }
  if (!headSha) return { ok: false, reason: 'no_head' };
  const ledger = (await loadMissionAuditLedgers([missionId])).get(missionId) ?? [];
  const round = ledger.reduce((m, a) => Math.max(m, a.round), 0) + 1;
  return requestMissionSurfaceAudit(missionId, { headSha, round, reason: 'recheck' });
}

import 'server-only';
import { requestMissionSurfaceAudit, type RequestSurfaceAuditResult } from '@/lib/mission-surface-audit';
import { getMissionVisualReviewState, loadMissionAuditLedgers } from '@/lib/workflow/visual-review-state-load';

export type RecheckResult = RequestSurfaceAuditResult | { ok: false; reason: 'no_head' };

/**
 * A person asked for the screens to be checked again. A queued or running audit
 * is returned as it is; otherwise the next round is filed for the integration
 * branch's current head, whatever the schedule's policy says (it is a person's
 * request, not the automatic filing). Nothing is filed without a head to name.
 */
export async function recheckMissionVisualReview(missionId: string): Promise<RecheckResult> {
  const state = await getMissionVisualReviewState(missionId);
  if (!state) return { ok: false, reason: 'mission_not_found' };
  const headSha = state.branch.headSha;
  if (!headSha) return { ok: false, reason: 'no_head' };
  const ledger = (await loadMissionAuditLedgers([missionId])).get(missionId) ?? [];
  const round = ledger.reduce((m, a) => Math.max(m, a.round), 0) + 1;
  return requestMissionSurfaceAudit(missionId, { headSha, round, reason: 'recheck' });
}

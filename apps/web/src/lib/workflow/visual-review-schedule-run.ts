/**
 * Server half of the visual-review scheduler: loads the facts, asks
 * `planVisualReviewSchedule`, executes the answer through the one existing
 * writer (`requestMissionSurfaceAudit`, idempotent on the audit task).
 *
 * Triggers: the cron sweep over open missions with an integration PR
 * (`sweepVisualReviewSchedule`), and any door that refuses a mission PR for an
 * owed review (`guardMissionPrMerge` via `ready-to-merge.ts`) so the review is
 * on its way the first time anything tries to land the branch.
 */
import 'server-only';
import { and, eq, isNotNull, notInArray } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { missions, tasks, workspaces } from '@buildd/core/db/schema';
import { requestMissionSurfaceAudit } from '@/lib/mission-surface-audit';
import { loadBrowserRunnerHeartbeats } from '@/lib/runner-heartbeats';
import { browserRunnerOnline } from '@/lib/visual-audit-runner';
import { assessMissionVisualImpact } from './visual-review-impact-load';
import { uiChangeFromImpact, type VisualImpactAssessment } from './visual-review-impact';
import { planVisualReviewSchedule, type ScheduleAction } from './visual-review-schedule';
import { getMissionVisualReviewState, loadMissionAuditLedger } from './visual-review-state-load';

export interface ScheduleOutcome {
  missionId: string;
  plan: ScheduleAction;
  /** The audit task the plan filed or re-stamped. */
  taskId?: string;
}

export async function scheduleMissionVisualReview(missionId: string, now = Date.now()): Promise<ScheduleOutcome | null> {
  const mission = await db.query.missions.findFirst({
    where: sqlWhere(eq(missions.id, missionId)),
    columns: { id: true, status: true, workspaceId: true, executor: true },
  });
  if (!mission || !mission.workspaceId || mission.status === 'completed' || mission.status === 'archived') return null;

  let state = await getMissionVisualReviewState(missionId);
  if (!state) return null;

  // The classifier replaces the file-glob gate as the answer to "does this owe a review" whenever
  // nothing has been filed yet or the pass went stale. Jev is only reached for ambiguous files.
  let impact: VisualImpactAssessment | null = null;
  const head = state.branch.headSha;
  if (head && state.scope.workLanded && ['optional', 'not_applicable', 'needed'].includes(state.status)) {
    impact = await assessMissionVisualImpact(missionId).catch(err => {
      console.error('[visual-review-schedule] impact assessment failed (treating as review_required):', err);
      return null;
    });
    if (impact) state = (await getMissionVisualReviewState(missionId, { uiChange: uiChangeFromImpact(impact, head) })) ?? state;
  }

  const [audits, ws] = await Promise.all([
    loadMissionAuditLedger(missionId),
    db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, mission.workspaceId)) }),
  ]);
  const hbs = ws ? await loadBrowserRunnerHeartbeats(ws, now).catch(() => null) : null;

  const plan = planVisualReviewSchedule({
    state,
    impact: impact ? { verdict: impact.verdict, headSha: impact.headSha } : null,
    audits,
    browserRunnerOnline: hbs && ws ? browserRunnerOnline(hbs, ws.id, now) : null,
    executorLocal: mission.executor === 'local',
    now,
  });

  if (plan.action === 'restamp') {
    const row = await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, plan.auditId)), columns: { context: true } });
    const ctx = row?.context && typeof row.context === 'object' && !Array.isArray(row.context) ? row.context as Record<string, unknown> : {};
    // Atomic on status: an audit claimed in the meantime keeps the head it started on.
    await db.update(tasks)
      .set({ context: { ...ctx, visualReview: { headSha: plan.headSha, reason: 'new_head' } }, updatedAt: new Date() })
      .where(and(eq(tasks.id, plan.auditId), eq(tasks.status, 'pending')));
    return { missionId, plan, taskId: plan.auditId };
  }
  if (plan.action === 'enqueue') {
    const res = await requestMissionSurfaceAudit(missionId, { headSha: plan.headSha, round: plan.round, reason: plan.reason, attempt: plan.attempt });
    return { missionId, plan, ...(res.ok ? { taskId: res.taskId } : {}) };
  }
  return { missionId, plan };
}

/** Open missions with an integration PR; one pass of the scheduler over each. Bounded per run. */
export async function sweepVisualReviewSchedule(now = Date.now(), limit = 50): Promise<ScheduleOutcome[]> {
  const rows = await db
    .select({ id: missions.id })
    .from(missions)
    .where(and(isNotNull(missions.primaryPrNumber), notInArray(missions.status, ['completed', 'archived'])))
    .limit(limit);
  const out: ScheduleOutcome[] = [];
  for (const r of rows) {
    try {
      const o = await scheduleMissionVisualReview(r.id, now);
      if (o) out.push(o);
    } catch (err) {
      console.error(`[visual-review-schedule] mission ${r.id.slice(0, 8)} failed:`, err);
    }
  }
  return out;
}

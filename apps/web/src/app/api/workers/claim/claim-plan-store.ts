/**
 * The claim planner's I/O, kept out of the route so a route test can stub it
 * wholesale (see ./claim-plan-input for the pure half).
 *
 * Reads: one batch per claim request, only when some candidate's workspace has
 * the planner on — the latest prediction per candidate, the stored Jev overlap
 * answers touching them, their `ordered_behind` record counts (starvation
 * credit) and their direct dependents. Every read fails open to "no signal":
 * a planner input missing a hint is still a valid plan, a failed claim is not.
 *
 * Writes: fire-and-forget gate-ledger rows, never awaited by the claim.
 */
import { db } from '@buildd/core/db';
import { gateEvents, orchestrationManifestPredictions, orchestrationOverlapAnswers } from '@buildd/core/db/schema';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { GATE_SLUGS, recordDeferralOnce, recordOrCoalesceRepeat } from '@buildd/core/gate-events';
import type { ClaimPlan } from '@buildd/core/claim-planner';
import { dependentCountQuery } from '@/lib/dependent-count-query';
import type { ClaimPlannerMode, PlannerPrediction, PlannerSignals, StoredOverlapAnswer } from './claim-plan-input';

export const ORDERED_BEHIND_REASON = 'ordered_behind';
export const CLAIM_PLAN_REASON = 'claim_plan';
const SURFACE = 'POST /api/workers/claim';
/** One plan row per (workspace, mode, identical plan + picks) per window; repeats bump its count. */
const PLAN_RECORD_WINDOW_MS = 60 * 60 * 1000;

async function safe<T>(label: string, fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[claim-planner] ${label} unavailable (planning without it):`, (err as Error)?.message ?? err);
    return fallback;
  }
}

export async function loadPlannerSignals(taskIds: string[], workspaceIds: string[]): Promise<PlannerSignals> {
  if (taskIds.length === 0) {
    return { predictions: new Map(), overlapAnswers: [], starvationCredit: new Map(), dependentCount: new Map() };
  }
  const p = orchestrationManifestPredictions;
  const o = orchestrationOverlapAnswers;
  const [predictions, overlapAnswers, starvationCredit, dependentCount] = await Promise.all([
    safe('predictions', new Map<string, PlannerPrediction>(), async () => {
      const rows = await db
        .selectDistinctOn([p.taskId], {
          taskId: p.taskId,
          selected: p.selected,
          setConfidence: p.setConfidence,
          expectedSize: p.expectedSize,
          unknownScope: p.unknownScope,
        })
        .from(p)
        .where(inArray(p.taskId, taskIds))
        .orderBy(p.taskId, desc(p.createdAt));
      return new Map(rows.map(r => [r.taskId, {
        selected: Array.isArray(r.selected) ? r.selected : [],
        setConfidence: r.setConfidence ?? null,
        expectedSize: r.expectedSize ? { files: r.expectedSize.files, minutes: r.expectedSize.minutes } : null,
        unknownScope: r.unknownScope,
      }]));
    }),
    safe('overlap answers', [] as StoredOverlapAnswer[], async () => {
      const rows = await db
        .select({ pairKey: o.pairKey, taskAId: o.taskAId, taskBId: o.taskBId, answer: o.answer })
        .from(o)
        .where(and(
          inArray(o.workspaceId, workspaceIds),
          or(inArray(o.taskAId, taskIds), inArray(o.taskBId, taskIds)),
        ))
        .orderBy(desc(o.createdAt));
      // Latest answer per pair wins.
      const seen = new Set<string>();
      const out: StoredOverlapAnswer[] = [];
      for (const r of rows) {
        if (seen.has(r.pairKey)) continue;
        seen.add(r.pairKey);
        if (r.answer === 'REAL' || r.answer === 'NOT_REAL') out.push({ taskAId: r.taskAId, taskBId: r.taskBId, answer: r.answer });
      }
      return out;
    }),
    safe('starvation credit', new Map<string, number>(), async () => {
      const rows = await db
        .select({ taskId: gateEvents.taskId, n: sql<number>`count(*)::int` })
        .from(gateEvents)
        .where(and(
          inArray(gateEvents.taskId, taskIds),
          eq(gateEvents.gate, GATE_SLUGS.CLAIM_LOOP_DEFERRAL),
          eq(gateEvents.outcome, 'deferred'),
          eq(gateEvents.reason, ORDERED_BEHIND_REASON),
        ))
        .groupBy(gateEvents.taskId);
      return new Map(rows.filter(r => r.taskId).map(r => [r.taskId as string, Number(r.n) || 0]));
    }),
    safe('dependent counts', new Map<string, number>(), async () => {
      const res = await db.execute(dependentCountQuery(taskIds));
      const rows = (res.rows ?? []) as Array<{ taskId: string; dependentCount: number }>;
      return new Map(rows.map(r => [r.taskId, Number(r.dependentCount) || 0]));
    }),
  ]);
  return { predictions, overlapAnswers, starvationCredit, dependentCount };
}

export interface OrderedBehindEvent {
  taskId: string;
  workspaceId: string;
  missionId: string | null;
  /** The blocker's task id when it has one, else its planner node id. */
  blockedBy: string;
  edge: string;
  orientation: string;
}

/**
 * One `ordered_behind` deferral per (task, blocker) pair, ever: a repeat poll
 * that sees the same blocker writes nothing. Fire-and-forget.
 */
export function fireOrderedBehind(e: OrderedBehindEvent): void {
  void recordDeferralOnce(
    {
      gate: GATE_SLUGS.CLAIM_LOOP_DEFERRAL,
      surface: SURFACE,
      outcome: 'deferred',
      reason: ORDERED_BEHIND_REASON,
      workspaceId: e.workspaceId,
      missionId: e.missionId,
      taskId: e.taskId,
      callerOrigin: 'worker',
      detail: { edge: e.edge, orientation: e.orientation },
    },
    { blockedBy: e.blockedBy },
  ).catch(() => {});
}

/** Cap on ids carried in one plan row; the counts say how many were left out. */
const PLAN_RECORD_MAX_IDS = 25;

/**
 * Record a plan beside the picks the claim actually made. Identical (plan,
 * picks) pairs within the window collapse into one row whose `detail.count`
 * climbs, so a quiet queue polled every few seconds is one row an hour.
 */
export function fireClaimPlanRecord(input: {
  mode: Exclude<ClaimPlannerMode, 'off'>;
  workspaceId: string | null;
  plan: ClaimPlan;
  actualPicks: string[];
  candidateCount: number;
}): void {
  const planned = input.plan.picks.map(p => p.id);
  const actual = [...input.actualPicks];
  const orientation = input.plan.orientation.map(o => `${o.taskId}<${o.blockedBy}:${o.edge}`);
  const signature = `${planned.join(',')}|${actual.join(',')}|${orientation.join(',')}`;
  void recordOrCoalesceRepeat(
    {
      gate: GATE_SLUGS.CLAIM_LOOP_DEFERRAL,
      surface: SURFACE,
      outcome: 'accepted',
      reason: CLAIM_PLAN_REASON,
      workspaceId: input.workspaceId,
      callerOrigin: 'worker',
      detail: {
        planned: planned.slice(0, PLAN_RECORD_MAX_IDS),
        actual: actual.slice(0, PLAN_RECORD_MAX_IDS),
        agree: planned.length === actual.length && planned.every((id, i) => id === actual[i]),
        orderedBehind: input.plan.orientation.slice(0, PLAN_RECORD_MAX_IDS),
        orderedBehindCount: input.plan.orientation.length,
        candidateCount: input.candidateCount,
        underPressure: input.plan.underPressure,
      },
    },
    {
      key: { mode: input.mode, workspace: input.workspaceId ?? 'multi', signature: hashSignature(signature) },
      windowMs: PLAN_RECORD_WINDOW_MS,
    },
  ).catch(() => {});
}

/** Short stable hash (FNV-1a) — the key only has to tell plans apart, not be reversible. */
function hashSignature(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

import type {
  OrchestrationDecisionCounts, OrchestrationDecisionGroup, OrchestrationDecisionStats, OrchestrationPredictionCounts,
} from '@buildd/shared';
import { db } from '@buildd/core/db';
import { orchestrationDecisions, orchestrationManifestPredictions, orchestrationTouchLabels, tasks } from '@buildd/core/db/schema';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { coordinationFilters, fetchDecisionCapabilities, type CoordinationWindow } from './coordination-stats-query';

/** One grouped row from the decision ledger: a decision group on one UTC day. */
export interface DecisionDayRow extends Omit<OrchestrationDecisionGroup, 'unlabelled'> { day: string }
export interface PredictionDayRow extends Omit<OrchestrationPredictionCounts, 'unlabelled'> { day: string; stopReason: string }

const n = (v: unknown) => Number(v ?? 0);
const minIso = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a < b ? a : b);
const maxIso = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a > b ? a : b);

function addDecision(into: OrchestrationDecisionCounts, row: DecisionDayRow) {
  into.total += n(row.total); into.applied += n(row.applied); into.suggested += n(row.suggested);
  into.fallback += n(row.fallback); into.labelled += n(row.labelled);
  into.unlabelled = into.total - into.labelled;
}
function addPrediction(into: OrchestrationPredictionCounts, row: PredictionDayRow) {
  into.total += n(row.total); into.complete += n(row.complete); into.unknownScope += n(row.unknownScope);
  into.allApplied += n(row.allApplied); into.labelled += n(row.labelled);
  into.unlabelled = into.total - into.labelled;
}
const emptyDecision = (): OrchestrationDecisionCounts => ({ total: 0, applied: 0, suggested: 0, fallback: 0, labelled: 0, unlabelled: 0 });
const emptyPrediction = (): OrchestrationPredictionCounts => ({ total: 0, complete: 0, unknownScope: 0, allApplied: 0, labelled: 0, unlabelled: 0 });

/** Pure roll-up of the grouped rows into totals, per-group, per-day and per-stop-reason views. */
export function rollupOrchestrationDecisions(
  decisionRows: DecisionDayRow[], predictionRows: PredictionDayRow[],
): Pick<OrchestrationDecisionStats, 'decisions' | 'manifestPredictions'> {
  const decisions = { ...emptyDecision(), firstAt: null as string | null, lastAt: null as string | null };
  const groups = new Map<string, OrchestrationDecisionGroup>();
  const days = new Map<string, OrchestrationDecisionCounts & { day: string; capability: string }>();
  for (const row of decisionRows) {
    addDecision(decisions, row);
    decisions.firstAt = minIso(decisions.firstAt, row.firstAt);
    decisions.lastAt = maxIso(decisions.lastAt, row.lastAt);
    const groupKey = [row.capability, row.decisionId, row.fingerprint, row.candidatePolicyVersion, row.experimentArm, row.mode].join('\u0000');
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        capability: row.capability, decisionId: row.decisionId, fingerprint: row.fingerprint,
        candidatePolicyVersion: row.candidatePolicyVersion, experimentArm: row.experimentArm, mode: row.mode,
        ...emptyDecision(), firstAt: null, lastAt: null,
      };
      groups.set(groupKey, group);
    }
    addDecision(group, row);
    group.firstAt = minIso(group.firstAt, row.firstAt);
    group.lastAt = maxIso(group.lastAt, row.lastAt);
    const dayKey = `${row.day}\u0000${row.capability}`;
    let day = days.get(dayKey);
    if (!day) { day = { day: row.day, capability: row.capability, ...emptyDecision() }; days.set(dayKey, day); }
    addDecision(day, row);
  }

  const predictions = emptyPrediction();
  const predictionDays = new Map<string, OrchestrationPredictionCounts & { day: string }>();
  const stopReasons = new Map<string, number>();
  for (const row of predictionRows) {
    addPrediction(predictions, row);
    let day = predictionDays.get(row.day);
    if (!day) { day = { day: row.day, ...emptyPrediction() }; predictionDays.set(row.day, day); }
    addPrediction(day, row);
    stopReasons.set(row.stopReason, (stopReasons.get(row.stopReason) ?? 0) + n(row.total));
  }

  const byDay = (a: { day: string }, b: { day: string }) => a.day.localeCompare(b.day);
  return {
    decisions: {
      ...decisions,
      byGroup: [...groups.values()].sort((a, b) => b.total - a.total),
      byDay: [...days.values()].sort((a, b) => byDay(a, b) || a.capability.localeCompare(b.capability)),
      byReason: [],
    },
    manifestPredictions: {
      ...predictions,
      byDay: [...predictionDays.values()].sort(byDay),
      byStopReason: [...stopReasons].map(([stopReason, total]) => ({ stopReason, total })).sort((a, b) => b.total - a.total),
    },
  };
}

/** Aggregates in Postgres (grouped by decision group and UTC day), rolled up in memory. */
export async function fetchOrchestrationDecisionStats(input: {
  workspaceIds: string[]; missionId?: string; window: CoordinationWindow;
}): Promise<OrchestrationDecisionStats> {
  const filters = coordinationFilters(input);
  const windowStart = new Date(filters.windowStart);
  const decisionCapabilities = await fetchDecisionCapabilities(input.workspaceIds);
  const coverage = {
    note: 'A row is written only for teams that opted the capability in (teams.enabledDecisionShadows); see decisionCapabilities before reading zero as "no evidence". '
      + 'labelled = the task has an orchestration_touch_labels row, written when a worker on it reaches a terminal status, so recent rows are unlabelled until their task finishes.',
  };
  if (!input.workspaceIds.length) {
    return { ...filters, decisionCapabilities, ...rollupOrchestrationDecisions([], []), coverage };
  }

  const d = orchestrationDecisions;
  const decisionLabelled = sql`exists (select 1 from ${orchestrationTouchLabels} where ${orchestrationTouchLabels.taskId} = ${d.taskId})`;
  const decisionDay = sql<string>`to_char(${d.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const decisionWhere = and(
    inArray(d.workspaceId, input.workspaceIds), gte(d.createdAt, windowStart),
    input.missionId ? eq(d.missionId, input.missionId) : undefined,
  );
  const decisionRows = await db.select({
    capability: d.capability, decisionId: d.decisionId, fingerprint: d.fingerprint,
    candidatePolicyVersion: d.candidatePolicyVersion, experimentArm: d.experimentArm, mode: d.mode,
    day: decisionDay,
    total: sql<number>`count(*)::int`,
    applied: sql<number>`count(*) filter (where ${d.status} = 'applied')::int`,
    suggested: sql<number>`count(*) filter (where ${d.status} = 'suggested')::int`,
    fallback: sql<number>`count(*) filter (where ${d.status} = 'fallback')::int`,
    labelled: sql<number>`count(*) filter (where ${decisionLabelled})::int`,
    firstAt: sql<string | null>`min(${d.createdAt})::text`,
    lastAt: sql<string | null>`max(${d.createdAt})::text`,
  }).from(d).where(decisionWhere)
    .groupBy(d.capability, d.decisionId, d.fingerprint, d.candidatePolicyVersion, d.experimentArm, d.mode, decisionDay);

  const reasonRows = await db.select({
    capability: d.capability, status: d.status, reason: d.reason,
    total: sql<number>`count(*)::int`,
  }).from(d).where(decisionWhere).groupBy(d.capability, d.status, d.reason);

  const p = orchestrationManifestPredictions;
  const predictionDay = sql<string>`to_char(${p.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const predictionRows = await db.select({
    day: predictionDay, stopReason: p.stopReason,
    total: sql<number>`count(*)::int`,
    complete: sql<number>`count(*) filter (where ${p.complete})::int`,
    unknownScope: sql<number>`count(*) filter (where ${p.unknownScope})::int`,
    allApplied: sql<number>`count(*) filter (where ${p.allApplied})::int`,
    labelled: sql<number>`count(*) filter (where exists (select 1 from ${orchestrationTouchLabels} where ${orchestrationTouchLabels.taskId} = ${p.taskId}))::int`,
  }).from(p).where(and(
    inArray(p.workspaceId, input.workspaceIds), gte(p.createdAt, windowStart),
    input.missionId ? sql`exists (select 1 from ${tasks} where ${tasks.id} = ${p.taskId} and ${tasks.missionId} = ${input.missionId})` : undefined,
  )).groupBy(predictionDay, p.stopReason);

  const rolled = rollupOrchestrationDecisions(decisionRows as DecisionDayRow[], predictionRows as PredictionDayRow[]);
  rolled.decisions.byReason = reasonRows
    .map(row => ({ capability: row.capability, status: row.status, reason: row.reason ?? null, total: n(row.total) }))
    .sort((a, b) => b.total - a.total);
  return { ...filters, decisionCapabilities, ...rolled, coverage };
}

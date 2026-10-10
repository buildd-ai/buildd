/**
 * Reads and writes behind the platform-owner API (/api/admin/*). Every
 * function here is cross-tenant by design: the gate is in front of the route
 * (lib/admin/owner-gate.ts), and the scope is whatever the owner asked for —
 * one workspace, one team, or every workspace.
 *
 * Nothing new is computed here: each loader is the same lib the team-scoped
 * route or the Health → Operator page already uses, given a wider scope.
 */
import { db } from '@buildd/core/db';
import {
  chatRetros, decisionRecords, experiments, orchestrationDecisions, tasks, teams, workers, workspaces,
} from '@buildd/core/db/schema';
import { and, desc, eq, gte, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { runExperimentHealth } from '@buildd/core/experiment-health-source';
import type { ExperimentHealthFinding } from '@buildd/core/experiment-health';
import { normalizeDecisionShadows } from '@buildd/core/inference-policy';
import { applyExperimentUpdate, findOtherRunning, type ExperimentRow } from '@/lib/experiments-store';
import { fetchOrchestrationDecisionStats } from '@/lib/orchestration-decision-stats-query';
import { computeUsageStats, describeScan, type GroupDimension } from '@/lib/usage-stats';
import { fetchUsageRows, USAGE_ROW_LIMIT } from '@/lib/usage-stats-query';
import { getDispatchHealth } from '@/lib/dispatch-health';
import { getGateAnalytics, getGateReasonFamily } from '@/lib/gate-analytics-query';
import { getLandingMetrics } from '@/lib/pr-landing-metrics';
import { getFailureAnalytics, getFailureSignatureFamily } from '@/lib/failure-analytics';
import { getStalledIngestReport } from '@/lib/knowledge-ingest-stalls';
import { buildSubagentDelegationPanel } from '@/lib/subagent-time';
import { fetchSubagentTimeRows, SUBAGENT_TIME_CAPTURED_SINCE, SUBAGENT_TIME_ROW_LIMIT } from '@/lib/subagent-time-query';
import { buildErrorPatternPanel } from '@/lib/error-pattern-cost';
import {
  fetchErrorPatternRows, errorPatternEffectiveStart, ERROR_TRACE_GATED_SINCE, ERROR_PATTERN_ROW_LIMIT,
} from '@/lib/error-pattern-cost-query';
import { countWorkersInWindow } from '@/lib/action-events';
import { readChatRetroSettings, effectiveChatRetroSettings, type ChatRetroSettings } from '@/lib/chat-retro/settings';
import { deleteTeamLessons, dogfoodOwnerExists, writeTeamSettings } from '@/lib/chat-retro/store';
import { loadFlowSeries, loadFlowUsage } from '@/lib/insights-flow-query';
import type { FlowWindow } from '@/lib/insights-flow';
import { BAND_LABEL, tasksInBand, type BandKey } from '@/components/insights/flow-chart-model';
import { loadAgentAccessReport } from '@/lib/agent-capabilities/access-log';
import type { DecisionFeatureCount } from './decision-features';
import type { AdminScope, AdminWindow } from './scope';

export { applyExperimentUpdate, findOtherRunning };

// ── Scope ─────────────────────────────────────────────────────────────────────

/** The workspaces a scope covers, or null when its team/workspace does not exist. */
export async function resolveScopeWorkspaces(scope: AdminScope): Promise<{ workspaceIds: string[] } | null> {
  if (scope.workspaceId) {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, scope.workspaceId), columns: { id: true, teamId: true } });
    if (!ws || (scope.teamId && ws.teamId !== scope.teamId)) return null;
    return { workspaceIds: [ws.id] };
  }
  if (scope.teamId) {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, scope.teamId), columns: { id: true } });
    if (!team) return null;
    const rows = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.teamId, scope.teamId));
    return { workspaceIds: rows.map(r => r.id) };
  }
  const rows = await db.select({ id: workspaces.id }).from(workspaces);
  return { workspaceIds: rows.map(r => r.id) };
}

// ── Decisions ─────────────────────────────────────────────────────────────────

/** Per-capability counts and cost from both decision ledgers. */
export async function loadDecisionFeatureCounts(opts: { since: Date; workspaceIds: string[] }): Promise<DecisionFeatureCount[]> {
  if (opts.workspaceIds.length === 0) return [];
  const fromLedger = async (table: typeof decisionRecords | typeof orchestrationDecisions, overridden: SQL) => {
    const rows = await db
      .select({
        capability: table.capability,
        count: sql<number>`count(*)::int`,
        applied: sql<number>`(count(*) filter (where ${table.status} = 'applied'))::int`,
        suggested: sql<number>`(count(*) filter (where ${table.status} = 'suggested'))::int`,
        fallback: sql<number>`(count(*) filter (where ${table.status} = 'fallback'))::int`,
        overridden: sql<number>`${overridden}`,
        costUsd: sql<number>`coalesce(sum(${table.costUsd}), 0)::float8`,
        inputTokens: sql<number>`coalesce(sum(${table.inputTokens}), 0)::float8`,
      })
      .from(table)
      .where(and(inArray(table.workspaceId, opts.workspaceIds), gte(table.createdAt, opts.since)))
      .groupBy(table.capability);
    return rows.map(r => ({ ...r, count: Number(r.count), applied: Number(r.applied), suggested: Number(r.suggested),
      fallback: Number(r.fallback), overridden: Number(r.overridden), costUsd: Number(r.costUsd), inputTokens: Number(r.inputTokens) }));
  };
  const [ledger, orchestration] = await Promise.all([
    fromLedger(decisionRecords, sql`(count(*) filter (where ${decisionRecords.overriddenAt} is not null))::int`),
    fromLedger(orchestrationDecisions, sql`0`),
  ]);
  return [...ledger, ...orchestration];
}

/** The get_decision_stats backend (orchestration decisions + manifest predictions), any scope. */
export async function loadDecisionStats(opts: { workspaceIds: string[]; window: AdminWindow; missionId?: string }) {
  return fetchOrchestrationDecisionStats(opts);
}

// ── Experiments ───────────────────────────────────────────────────────────────

/** Every team's experiments (tier pools excluded, as on the team surface), newest first. */
export async function listExperiments(opts: { teamId: string | null }): Promise<ExperimentRow[]> {
  const scope = opts.teamId
    ? and(eq(experiments.teamId, opts.teamId), ne(experiments.kind, 'tier_pool'))
    : ne(experiments.kind, 'tier_pool');
  return db.select().from(experiments).where(scope).orderBy(desc(experiments.createdAt));
}

/** Enrolment health of the running ones; a failed check drops that entry, not the list. */
export async function loadExperimentHealth(rows: ExperimentRow[]): Promise<Record<string, ExperimentHealthFinding[]>> {
  const health: Record<string, ExperimentHealthFinding[]> = {};
  await Promise.all(rows.filter(r => r.status === 'running').map(async r => {
    const findings = await runExperimentHealth(r).catch(() => null);
    if (findings) health[r.id] = findings;
  }));
  return health;
}

export async function getExperiment(id: string): Promise<ExperimentRow | null> {
  const [row] = await db.select().from(experiments)
    .where(and(eq(experiments.id, id), ne(experiments.kind, 'tier_pool')));
  return row ?? null;
}

// ── Team experiment flags ─────────────────────────────────────────────────────

export interface TeamExperimentFlags {
  /** The opt-in decision capabilities the team has on (teams.enabledDecisionShadows). */
  enabledDecisionShadows: string[] | null;
  /** Chat retro, as stored and as in effect. */
  chatRetro: ChatRetroSettings;
  /** An owner's account dogfood holds chat retro on whatever is stored. */
  chatRetroDogfood: boolean;
}

export async function readTeamExperimentFlags(teamId: string): Promise<TeamExperimentFlags | null> {
  const [row] = await db
    .select({
      enabledDecisionShadows: teams.enabledDecisionShadows,
      chatRetro: teams.chatRetro,
      dogfood: sql<boolean>`${dogfoodOwnerExists()}`,
    })
    .from(teams)
    .where(eq(teams.id, teamId));
  if (!row) return null;
  const shadows = normalizeDecisionShadows(row.enabledDecisionShadows ?? null);
  const dogfood = row.dogfood === true;
  return {
    enabledDecisionShadows: shadows.ok ? shadows.value : (row.enabledDecisionShadows ?? null),
    chatRetro: effectiveChatRetroSettings(readChatRetroSettings(row.chatRetro), dogfood),
    chatRetroDogfood: dogfood,
  };
}

export async function writeTeamExperimentFlags(
  teamId: string,
  next: { enabledDecisionShadows?: string[] | null; chatRetro?: ChatRetroSettings; deleteLessons: boolean },
): Promise<{ deletedLessons: number }> {
  if (next.enabledDecisionShadows !== undefined) {
    await db.update(teams)
      .set({ enabledDecisionShadows: next.enabledDecisionShadows, updatedAt: new Date() })
      .where(eq(teams.id, teamId));
  }
  if (next.chatRetro) await writeTeamSettings(teamId, next.chatRetro);
  const deletedLessons = next.deleteLessons ? await deleteTeamLessons(teamId) : 0;
  return { deletedLessons };
}

// ── Chat retros ───────────────────────────────────────────────────────────────

/** Recent retro rows across teams: labels and counts, never message text. */
export async function listChatRetros(opts: { teamId: string | null; since: Date; limit: number }) {
  return db
    .select({
      id: chatRetros.id, teamId: chatRetros.teamId, workspaceId: chatRetros.workspaceId,
      conversationId: chatRetros.conversationId, status: chatRetros.status,
      skipReason: chatRetros.skipReason, userTurns: chatRetros.userTurns, turns: chatRetros.turns,
      inputTokens: chatRetros.inputTokens, outputTokens: chatRetros.outputTokens,
      intent: chatRetros.intent, satisfied: chatRetros.satisfied,
      wastedTurns: chatRetros.wastedTurns, wastedTokens: chatRetros.wastedTokens,
      primaryCause: chatRetros.primaryCause, fixClass: chatRetros.fixClass,
      toolName: chatRetros.toolName, signature: chatRetros.signature, createdAt: chatRetros.createdAt,
    })
    .from(chatRetros)
    .where(and(gte(chatRetros.createdAt, opts.since), opts.teamId ? eq(chatRetros.teamId, opts.teamId) : undefined))
    .orderBy(desc(chatRetros.createdAt))
    .limit(opts.limit);
}

// ── Usage, dispatch, gates, failures ──────────────────────────────────────────

/** The get_usage_stats backend over any set of workspaces. */
export async function loadUsage(opts: { workspaceIds: string[]; since: Date; groupBy: GroupDimension }) {
  const rows = opts.workspaceIds.length ? await fetchUsageRows({ workspaceIds: opts.workspaceIds, windowStart: opts.since }) : [];
  return {
    scan: describeScan(rows, opts.since, USAGE_ROW_LIMIT),
    ...computeUsageStats(rows, opts.groupBy),
  };
}

export async function loadDispatchHealth(workspaceIds: string[]) {
  return getDispatchHealth(workspaceIds);
}

/** The get_failure_analytics family=gate backend: the gate ledger, plus time-to-land on the overview. */
export async function loadGates(opts: { workspaceIds: string[]; window: AdminWindow; errorPrefix: string | null }) {
  const gates = await getGateAnalytics(opts.workspaceIds, opts.window);
  if (opts.errorPrefix) {
    return { gates, gateFamily: await getGateReasonFamily(opts.workspaceIds, opts.window, opts.errorPrefix) };
  }
  return { gates, landing: await getLandingMetrics(opts.workspaceIds, opts.window) };
}

/** Failure triage internals: the ranked signatures, an optional prefix family, stalled ingest. */
export async function loadFailures(opts: { workspaceIds: string[]; window: AdminWindow; errorPrefix: string | null }) {
  const [analytics, family, stalledIngest] = await Promise.all([
    getFailureAnalytics(opts.workspaceIds, opts.window),
    opts.errorPrefix ? getFailureSignatureFamily(opts.workspaceIds, opts.window, opts.errorPrefix) : Promise.resolve(null),
    getStalledIngestReport(opts.workspaceIds),
  ]);
  return { analytics, family, stalledIngest };
}

// ── Operator ──────────────────────────────────────────────────────────────────

/**
 * The Health → Operator panels that are not covered by a route above:
 * delegated subagent time, error-trace pattern cost, and PRs buildd cannot
 * resolve. Each is guarded on its own: a failed read is null, not a 500.
 */
export async function loadOperatorData(opts: { workspaceIds: string[]; since: Date }) {
  const { workspaceIds, since } = opts;
  if (workspaceIds.length === 0) return { subagentDelegation: null, errorPatterns: null, orphanedPrs: [] };
  const [subagentDelegation, errorPatterns, orphanedPrs] = await Promise.all([
    fetchSubagentTimeRows({ workspaceIds, windowStart: since })
      .then(rows => buildSubagentDelegationPanel({
        rows, windowStart: since, rowLimit: SUBAGENT_TIME_ROW_LIMIT, capturedSince: SUBAGENT_TIME_CAPTURED_SINCE,
      }))
      .catch(() => null),
    Promise.all([
      fetchErrorPatternRows({ workspaceIds, windowStart: since }),
      countWorkersInWindow({ workspaceIds, windowStart: errorPatternEffectiveStart(since) }),
    ])
      .then(([rows, scannedWorkers]) => buildErrorPatternPanel({
        rows, scannedWorkers, windowStart: since, rowLimit: ERROR_PATTERN_ROW_LIMIT, gatedSince: ERROR_TRACE_GATED_SINCE,
      }))
      .catch(() => null),
    db.select({
      workerId: workers.id, workspaceId: workers.workspaceId, taskId: workers.taskId,
      prUrl: workers.prUrl, prNumber: workers.prNumber, reason: workers.prUnresolvableReason,
      failureCount: workers.prCheckFailureCount, lastCheckedAt: workers.prLastCheckedAt,
    })
      .from(workers)
      .where(and(inArray(workers.workspaceId, workspaceIds), eq(workers.prLifecycleStatus, 'unresolvable')))
      .orderBy(desc(workers.prLastCheckedAt))
      .limit(25)
      .catch(() => null),
  ]);
  return { subagentDelegation, errorPatterns, orphanedPrs };
}

/**
 * Health → Insights, cross-tenant: the flow series and its role/tier usage
 * counters for the scoped workspaces. The flow chart only has 7 and 30 day
 * windows, so a 24h read gets the 7 day series.
 */
export async function loadInsights(opts: { workspaceIds: string[]; window: FlowWindow }) {
  const [series, usage] = await Promise.all([
    loadFlowSeries(opts.workspaceIds, opts.window),
    loadFlowUsage(opts.workspaceIds, opts.window),
  ]);
  return { series, usage, truncated: series.truncated || usage.truncated };
}

export interface InsightsBandFilter { band: BandKey; from: number; to: number; at: number }

/**
 * The Insights band drilldown (the tasks behind one band of one bucket), the
 * same selection as lib/insights-task-list-filter.ts without its team
 * permission check: the owner gate is in front of the route. Null when the
 * bucket is outside the series.
 */
export async function loadInsightsBand(opts: { workspaceIds: string[]; filter: InsightsBandFilter }) {
  const { filter, workspaceIds } = opts;
  const window: FlowWindow = filter.to - filter.from <= 7 * 86_400_000 ? '7d' : '30d';
  const series = await loadFlowSeries(workspaceIds, window, filter.to);
  const index = Math.floor((filter.at - series.window.from) / series.bucketMs);
  const bucket = series.buckets[index];
  if (!bucket) return null;
  const ids = tasksInBand(series, index, filter.band).map(t => t.key).filter(key => !key.startsWith('worker:'));
  const start = filter.band === 'released' || filter.band === 'lost' ? filter.from : bucket.start;
  const rows = ids.length === 0 || workspaceIds.length === 0 ? [] : await db.query.tasks.findMany({
    where: and(inArray(tasks.id, ids.slice(0, 5000)), inArray(tasks.workspaceId, workspaceIds)),
    columns: { id: true, title: true, status: true, workspaceId: true, updatedAt: true },
    with: { mission: { columns: { title: true } } },
  });
  return {
    band: filter.band,
    label: BAND_LABEL[filter.band],
    from: new Date(start).toISOString(),
    to: new Date(bucket.end).toISOString(),
    tasks: rows.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      workspaceId: t.workspaceId,
      missionTitle: (t.mission as { title: string } | null)?.title ?? null,
      updatedAt: (t.updatedAt ?? new Date()).toISOString(),
    })),
  };
}

/** Health → Overview's agent access section, cross-tenant. */
export async function loadAgentAccess(opts: { workspaceIds: string[]; windowHours: number }) {
  return loadAgentAccessReport(opts.workspaceIds, opts.windowHours);
}

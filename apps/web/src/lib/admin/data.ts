/**
 * Reads and writes behind the platform-owner API (/api/admin/*). Every
 * function here is cross-tenant by design: the gate is in front of the route
 * (lib/admin/owner-gate.ts), and the scope is whatever the owner asked for —
 * one workspace, one team, or every workspace. Routes read through the views
 * in lib/admin/tenant-privacy.ts, which keep other teams aggregate-only.
 *
 * Nothing new is computed here: each loader is the same lib the team-scoped
 * route or the Health → Operator page already uses, given a wider scope.
 */
import { db } from '@buildd/core/db';
import {
  chatRetros, decisionOutcomes, decisionRecords, experiments, failureIncidents, gateEvents, missions, notificationDeliveries,
  orchestrationDecisions, platformAdminAuditEvents, systemCache, tasks, teamMembers, teams, workers, workspaces,
} from '@buildd/core/db/schema';
import { and, desc, eq, gte, inArray, like, ne, or, sql, type SQL } from 'drizzle-orm';
import { ESCALATION_GATE_CAPABILITY, verdictFromCode } from '@buildd/core/escalation-gate';
import { GATE_SLUGS } from '@buildd/core/gate-events';
import type { RecoveryCauseDetail, RecoveryFilter, RecoveryPanel } from '@buildd/shared';
import { readSentinelLastRun, SENTINEL_LAST_RUN_KEY, type RecoveryAttemptDetail } from '@/lib/failure-incident-recovery-events';
import { INCIDENT_SUBJECT_TYPE, incidentSubjectKey } from '@/lib/failure-incident-escalation';
import { buildRecoveryCauseDetail, buildRecoveryPanel, type CauseModelDecisions, type PriorityOverride, type QueueFacts, type QueueIncident } from './recovery/queue';
import { readOperatorReceipt } from '@/lib/operator-recovery-decisions';
import { buildAutomationState } from '@/lib/failure-incident-recovery-automation';
import { PRIORITY_CAPABILITY } from '@/lib/failure-incident-recovery-actions';
import { buildAutomationView, OPERATOR_RECOVERY_DECISION_KINDS, OPERATOR_RECOVERY_KEY_PREFIX } from './recovery/automation';
import { runExperimentHealth } from '@buildd/core/experiment-health-source';
import { runExperimentReadout } from '@buildd/core/experiment-readout-source';
import { MODEL_ROUTING_EXPERIMENT_KIND, parseModelRoutingConfig } from '@buildd/core/model-routing-experiment';
import { runHeartbeatTriageReadout } from '@buildd/core/heartbeat-triage-readout-source';
import { HEARTBEAT_TRIAGE_EXPERIMENT_KIND, parseHeartbeatTriageConfig } from '@buildd/core/heartbeat-triage-experiment';
import type { ExperimentHealthFinding } from '@buildd/core/experiment-health';
import { normalizeDecisionShadows, normalizeFeatureModes, type FeatureModes } from '@buildd/core/inference-policy';
import { AGENT_AUDIT_RULE_SOURCE, AGENT_AUDIT_SOURCE, type HealthOutcome } from '@buildd/core/decision-feature-health';
import { applyExperimentUpdate, findOtherRunning, type ExperimentRow } from '@/lib/experiments-store';
import { fetchOrchestrationDecisionStats } from '@/lib/orchestration-decision-stats-query';
import { computeUsageStats, describeScan, type GroupDimension } from '@/lib/usage-stats';
import { rankTopTasks } from './usage-extras';
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
import { fetchOperatorEstimateCounts, fetchOperatorEstimateRows, OPERATOR_ROW_LIMIT } from '@buildd/core/task-estimate-operator-source';
import type { DecisionFeatureCount, DecisionHealthRow } from './decision-features';
import type { AdminScope, AdminWindow } from './scope';
import { sqlWhere } from '@buildd/core/db/relational-sql';

export { applyExperimentUpdate, findOtherRunning };

// ── Scope ─────────────────────────────────────────────────────────────────────

/** The workspaces a scope covers with their teams, or null when its team/workspace does not exist. */
export async function resolveScopeWorkspaces(scope: AdminScope): Promise<{ workspaces: { id: string; teamId: string }[] } | null> {
  const columns = { id: workspaces.id, teamId: workspaces.teamId };
  if (scope.workspaceId) {
    const ws = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, scope.workspaceId)), columns: { id: true, teamId: true } });
    if (!ws || (scope.teamId && ws.teamId !== scope.teamId)) return null;
    return { workspaces: [ws] };
  }
  if (scope.teamId) {
    const team = await db.query.teams.findFirst({ where: sqlWhere(eq(teams.id, scope.teamId)), columns: { id: true } });
    if (!team) return null;
    return { workspaces: await db.select(columns).from(workspaces).where(eq(workspaces.teamId, scope.teamId)) };
  }
  return { workspaces: await db.select(columns).from(workspaces) };
}

/**
 * The teams the platform owner sees in full (lib/admin/tenant-privacy.ts):
 * those the key's creator is a member of, and the key's own team.
 */
export async function loadOwnTeams(account: { teamId: string; createdByUserId: string | null }): Promise<{ id: string; name: string }[]> {
  const memberOf = account.createdByUserId
    ? db.select({ teamId: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, account.createdByUserId))
    : null;
  return db.select({ id: teams.id, name: teams.name }).from(teams)
    .where(memberOf ? or(eq(teams.id, account.teamId), inArray(teams.id, memberOf)) : eq(teams.id, account.teamId));
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

/** Newest rows read per ledger for the health readout; past it the readout covers the newest rows only. */
export const DECISION_HEALTH_ROW_LIMIT = 20_000;

/**
 * The rows the per-feature health readout reads (lib/admin/decision-features.ts
 * `featureHealthById`): both ledgers, newest first, plus the agent audit
 * grades on decision_records rows. orchestration_decisions has no outcome
 * table, so its features read calls, fallbacks, latency and cost only.
 */
export async function loadDecisionHealthRows(opts: { since: Date; workspaceIds: string[] }): Promise<{
  rows: DecisionHealthRow[];
  outcomes: HealthOutcome[];
  truncated: boolean;
}> {
  if (opts.workspaceIds.length === 0) return { rows: [], outcomes: [], truncated: false };
  const inScope = <T extends typeof decisionRecords | typeof orchestrationDecisions>(t: T) =>
    and(inArray(t.workspaceId, opts.workspaceIds), gte(t.createdAt, opts.since));
  const [ledger, orchestration, outcomes] = await Promise.all([
    db.select({
      id: decisionRecords.id, capability: decisionRecords.capability, status: decisionRecords.status, applied: decisionRecords.applied,
      verdict: decisionRecords.verdict, reason: decisionRecords.reason, latencyMs: decisionRecords.latencyMs, costUsd: decisionRecords.costUsd,
      overriddenAt: decisionRecords.overriddenAt,
    }).from(decisionRecords).where(inScope(decisionRecords)).orderBy(desc(decisionRecords.createdAt)).limit(DECISION_HEALTH_ROW_LIMIT + 1),
    db.select({
      id: orchestrationDecisions.id, capability: orchestrationDecisions.capability, status: orchestrationDecisions.status,
      applied: orchestrationDecisions.applied, verdict: orchestrationDecisions.suggested, reason: orchestrationDecisions.reason,
      latencyMs: orchestrationDecisions.latencyMs, costUsd: orchestrationDecisions.costUsd,
    }).from(orchestrationDecisions).where(inScope(orchestrationDecisions)).orderBy(desc(orchestrationDecisions.createdAt)).limit(DECISION_HEALTH_ROW_LIMIT + 1),
    db.select({ decisionRecordId: decisionOutcomes.decisionRecordId, source: decisionOutcomes.source, label: decisionOutcomes.label })
      .from(decisionOutcomes)
      .innerJoin(decisionRecords, eq(decisionRecords.id, decisionOutcomes.decisionRecordId))
      .where(and(inArray(decisionOutcomes.source, [AGENT_AUDIT_SOURCE, AGENT_AUDIT_RULE_SOURCE]), inScope(decisionRecords)))
      .orderBy(decisionOutcomes.recordedAt),
  ]);
  const truncated = ledger.length > DECISION_HEALTH_ROW_LIMIT || orchestration.length > DECISION_HEALTH_ROW_LIMIT;
  const rows: DecisionHealthRow[] = [
    ...ledger.slice(0, DECISION_HEALTH_ROW_LIMIT).map(({ overriddenAt, ...r }) => ({ ...r, overridden: overriddenAt != null })),
    ...orchestration.slice(0, DECISION_HEALTH_ROW_LIMIT).map(r => ({ ...r, overridden: false })),
  ];
  return { rows, outcomes, truncated };
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
  /** Per-feature server/runner overrides (teams.inferenceFeatureModes); null = every feature follows billing. */
  inferenceFeatureModes: FeatureModes | null;
  /** Chat retro, as stored and as in effect. */
  chatRetro: ChatRetroSettings;
  /** An owner's account dogfood holds chat retro on whatever is stored. */
  chatRetroDogfood: boolean;
}

export async function readTeamExperimentFlags(teamId: string): Promise<TeamExperimentFlags | null> {
  const [row] = await db
    .select({
      enabledDecisionShadows: teams.enabledDecisionShadows,
      inferenceFeatureModes: teams.inferenceFeatureModes,
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
    inferenceFeatureModes: normalizeFeatureModes(row.inferenceFeatureModes),
    chatRetro: effectiveChatRetroSettings(readChatRetroSettings(row.chatRetro), dogfood),
    chatRetroDogfood: dogfood,
  };
}

export async function writeTeamExperimentFlags(
  teamId: string,
  next: { enabledDecisionShadows?: string[] | null; inferenceFeatureModes?: FeatureModes | null; chatRetro?: ChatRetroSettings; deleteLessons: boolean },
): Promise<{ deletedLessons: number }> {
  const columns = {
    ...(next.enabledDecisionShadows !== undefined ? { enabledDecisionShadows: next.enabledDecisionShadows } : {}),
    ...(next.inferenceFeatureModes !== undefined ? { inferenceFeatureModes: next.inferenceFeatureModes } : {}),
  };
  if (Object.keys(columns).length) {
    await db.update(teams).set({ ...columns, updatedAt: new Date() }).where(eq(teams.id, teamId));
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

/**
 * The get_usage_stats backend over any set of workspaces, plus what the admin
 * app's Usage page needs beside it: the same-length window before this one
 * (totals and groups, so "this week vs last" needs no second call) and the five
 * most expensive tasks in topTaskWorkspaceIds, with their titles.
 */
export async function loadUsage(opts: { workspaceIds: string[]; topTaskWorkspaceIds: string[]; since: Date; groupBy: GroupDimension; now?: Date }) {
  const now = opts.now ?? new Date();
  const span = now.getTime() - opts.since.getTime();
  const previousStart = new Date(opts.since.getTime() - span);
  const [rows, previousRows] = opts.workspaceIds.length
    ? await Promise.all([
        fetchUsageRows({ workspaceIds: opts.workspaceIds, windowStart: opts.since }),
        fetchUsageRows({ workspaceIds: opts.workspaceIds, windowStart: previousStart, windowEnd: opts.since }),
      ])
    : [[], []];
  const previous = computeUsageStats(previousRows, opts.groupBy);
  const topTaskScope = new Set(opts.topTaskWorkspaceIds);
  const ranked = rankTopTasks(rows.filter(r => topTaskScope.has(r.workspaceId)), 5);
  const titles = ranked.length
    ? await db.select({ id: tasks.id, title: tasks.title }).from(tasks).where(inArray(tasks.id, ranked.map(t => t.taskId)))
    : [];
  const titleOf = new Map(titles.map(t => [t.id, t.title]));
  return {
    scan: describeScan(rows, opts.since, USAGE_ROW_LIMIT),
    ...computeUsageStats(rows, opts.groupBy),
    previous: {
      since: previousStart.toISOString(),
      scan: describeScan(previousRows, previousStart, USAGE_ROW_LIMIT),
      totals: previous.totals,
      groups: previous.groups.map(g => ({ key: g.key, costUsd: g.costUsd, tasks: g.tasks })),
    },
    topTasks: ranked.map(t => ({ ...t, title: titleOf.get(t.taskId) ?? null })),
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
    where: sqlWhere(and(inArray(tasks.id, ids.slice(0, 5000)), inArray(tasks.workspaceId, workspaceIds))),
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

// ── Estimates ─────────────────────────────────────────────────────────────────

/**
 * Insights → Estimation's input: the window's frozen estimates with their
 * actuals (row-capped), the coverage counts (aggregated in the query) and the
 * names of the workspaces in scope, which the view keeps for own teams only.
 */
export async function loadEstimates(opts: { workspaceIds: string[]; since: Date; estimatorVersion: string | null }) {
  const [{ rows, truncated }, counts, names] = await Promise.all([
    fetchOperatorEstimateRows(opts),
    fetchOperatorEstimateCounts(opts),
    opts.workspaceIds.length
      ? db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(inArray(workspaces.id, opts.workspaceIds))
      : Promise.resolve([]),
  ]);
  return { rows, truncated, rowLimit: OPERATOR_ROW_LIMIT, counts, workspaceNames: Object.fromEntries(names.map(w => [w.id, w.name])) as Record<string, string> };
}

// ── Names and readouts ────────────────────────────────────────────────────────

/** Every team and its workspaces, by name: operator clients show names, never ids. */
export async function listTeamsWithWorkspaces(): Promise<{ id: string; name: string; workspaces: { id: string; name: string }[] }[]> {
  const [teamRows, workspaceRows] = await Promise.all([
    db.select({ id: teams.id, name: teams.name }).from(teams).orderBy(teams.name),
    db.select({ id: workspaces.id, name: workspaces.name, teamId: workspaces.teamId }).from(workspaces).orderBy(workspaces.name),
  ]);
  return teamRows.map(t => ({
    id: t.id,
    name: t.name,
    workspaces: workspaceRows.filter(w => w.teamId === t.id).map(w => ({ id: w.id, name: w.name })),
  }));
}

/**
 * One experiment's readout for its current policy version, dispatched by kind
 * exactly as GET /api/experiments/[id]/readout does. A kind with no readout
 * returns null.
 */
export async function loadExperimentReadout(row: ExperimentRow) {
  const policyVersion = row.policyVersion;
  const health = await runExperimentHealth(row).catch(() => null);
  if (row.kind === HEARTBEAT_TRIAGE_EXPERIMENT_KIND) {
    return { policyVersion, readout: await runHeartbeatTriageReadout({ id: row.id, policyVersion }, parseHeartbeatTriageConfig(row.config)), health };
  }
  if (row.kind === MODEL_ROUTING_EXPERIMENT_KIND) {
    const { minSamplePerArm } = parseModelRoutingConfig(row.config);
    return { policyVersion, readout: await runExperimentReadout({ id: row.id, policyVersion }, { minSamplePerArm }), health };
  }
  return { policyVersion, readout: null, health };
}

// ── Recovery queue (operator-recovery spec §7.1) ──────────────────────────────

const RECOVERY_INCIDENT_LIMIT = 1000;
const RECOVERY_ROW_LIMIT = 5000;
const DAY_MS = 86_400_000;
const WINDOW_DAYS = { '24h': 1, '7d': 7, '30d': 30 } as const;

export interface RecoveryReadOpts {
  workspaceIds: string[];
  /** No team or workspace narrowing: other teams may be named, and platform incidents (no workspace) are included. */
  platformWide: boolean;
  window: AdminWindow;
  now?: Date;
}

const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * Every fact the queue needs, in a fixed number of batched reads: the scoped
 * incidents in one query, then names, subject tasks, their workers, blocker PR
 * owners, attempt events, the sweep's last run, stored person verdicts and the
 * automation keys, each one query over the whole set. A read that fails comes
 * back null and shows up as missing evidence; it never fails the panel.
 */
export async function loadRecoveryFacts(opts: RecoveryReadOpts): Promise<QueueFacts> {
  const now = opts.now ?? new Date();
  const lookbackMs = Math.max(7, WINDOW_DAYS[opts.window]) * DAY_MS;
  const since = new Date(now.getTime() - lookbackMs);
  // Platform-wide is every incident, platform-scoped ones (no workspace) included;
  // a team or workspace scope reads only its own workspaces' rows.
  const scopeWhere = opts.platformWide
    ? undefined
    : opts.workspaceIds.length ? inArray(failureIncidents.workspaceId, opts.workspaceIds) : sql`false`;
  const rows = await db.select().from(failureIncidents)
    .where(and(scopeWhere, or(ne(failureIncidents.status, 'resolved'), gte(failureIncidents.resolvedAt, since))))
    .orderBy(desc(failureIncidents.lastSeenAt))
    .limit(RECOVERY_INCIDENT_LIMIT);
  const incidents: QueueIncident[] = rows.map(r => ({
    id: r.id, workspaceId: r.workspaceId, signature: r.signature, detectorVersion: r.detectorVersion, rule: r.rule,
    reasonCode: r.reasonCode, title: r.title, severity: r.severity, status: r.status,
    firstSeenAt: r.firstSeenAt.toISOString(), lastSeenAt: r.lastSeenAt.toISOString(),
    occurrenceCount: r.occurrenceCount, recurrenceCount: r.recurrenceCount,
    affectedRefs: r.affectedRefs ?? { taskIds: [], workerIds: [], prNumbers: [] }, evidenceRefs: r.evidenceRefs ?? [],
    impact: r.impact ?? {}, lastAlertedAt: isoOrNull(r.lastAlertedAt), lastAlertSeverity: r.lastAlertSeverity,
    linkedFixTaskId: r.linkedFixTaskId, acknowledgedAt: isoOrNull(r.acknowledgedAt), resolvedAt: isoOrNull(r.resolvedAt),
    recovery: r.recovery ?? null, version: r.version,
  }));

  const wsIds = [...new Set(incidents.map(i => i.workspaceId).filter((x): x is string => !!x))];
  const subjectIds = new Set<string>();
  const fixIds = new Set<string>();
  const prKeys: Array<{ workspaceId: string; prNumber: number }> = [];
  for (const i of incidents) {
    for (const id of i.recovery?.subjects?.filter(s => s.kind === 'task').map(s => s.id) ?? i.affectedRefs.taskIds) subjectIds.add(id);
    for (const id of i.affectedRefs.taskIds) subjectIds.add(id);
    if (i.linkedFixTaskId) fixIds.add(i.linkedFixTaskId);
    for (const b of i.recovery?.blockers ?? []) {
      if (b.kind === 'task') subjectIds.add(b.id);
      if (b.kind === 'pr' && i.workspaceId && /^\d+$/.test(b.id)) prKeys.push({ workspaceId: i.workspaceId, prNumber: Number(b.id) });
    }
  }
  const uuid = (id: string) => /^[0-9a-f-]{36}$/i.test(id);
  const taskIds = [...new Set([...subjectIds, ...fixIds])].filter(uuid);
  const incidentIds = incidents.map(i => i.id);
  const prNumbers = [...new Set(prKeys.map(k => k.prNumber))];
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const [wsRows, taskRows, workerRows, prRows, attemptRows, lastRunRow, verdictRows, automationRows, modelRows, overrideRows, modelDecisionRows] = await Promise.all([
    wsIds.length ? db.select({ id: workspaces.id, name: workspaces.name, teamId: workspaces.teamId }).from(workspaces).where(inArray(workspaces.id, wsIds)) : Promise.resolve([]),
    (taskIds.length
      ? db.select({ id: tasks.id, title: tasks.title, status: tasks.status, workspaceId: tasks.workspaceId, missionId: tasks.missionId, missionTitle: missions.title, missionWorkspaceId: missions.workspaceId })
        .from(tasks).leftJoin(missions, eq(missions.id, tasks.missionId)).where(inArray(tasks.id, taskIds))
      : Promise.resolve([])).catch(() => null),
    (taskIds.length
      ? db.select({
        taskId: workers.taskId, createdAt: workers.createdAt, status: workers.status, costUsd: workers.costUsd, costBasis: workers.costBasis,
        prNumber: workers.prNumber, prUrl: workers.prUrl, prState: workers.prLifecycleStatus, workspaceId: workers.workspaceId,
      }).from(workers)
        .where(and(inArray(workers.taskId, taskIds), or(gte(workers.createdAt, since), fixIds.size ? inArray(workers.taskId, [...fixIds].filter(uuid)) : sql`false`)))
        .orderBy(desc(workers.createdAt)).limit(RECOVERY_ROW_LIMIT)
      : Promise.resolve([])).catch(() => null),
    (prNumbers.length && wsIds.length
      ? db.select({ taskId: workers.taskId, prNumber: workers.prNumber, workspaceId: workers.workspaceId }).from(workers)
        .where(and(inArray(workers.workspaceId, wsIds), inArray(workers.prNumber, prNumbers)))
      : Promise.resolve([])).catch(() => []),
    (incidentIds.length
      ? db.select({ occurredAt: gateEvents.occurredAt, outcome: gateEvents.outcome, detail: gateEvents.detail }).from(gateEvents)
        .where(and(eq(gateEvents.gate, GATE_SLUGS.INCIDENT_RECOVERY), gte(gateEvents.occurredAt, new Date(now.getTime() - 30 * DAY_MS)),
          inArray(sql<string>`${gateEvents.detail}->>'incidentId'`, incidentIds)))
        .limit(RECOVERY_ROW_LIMIT)
      : Promise.resolve([])).catch(() => null),
    db.select({ value: systemCache.value }).from(systemCache).where(eq(systemCache.key, SENTINEL_LAST_RUN_KEY)).limit(1).catch(() => null),
    (incidentIds.length
      ? db.select({ subjectId: decisionRecords.subjectId, appliedAnswer: decisionRecords.appliedAnswer }).from(decisionRecords)
        .where(and(eq(decisionRecords.capability, ESCALATION_GATE_CAPABILITY), eq(decisionRecords.subjectType, INCIDENT_SUBJECT_TYPE),
          inArray(decisionRecords.subjectId, incidentIds.map(incidentSubjectKey))))
      : Promise.resolve([])).catch(() => null),
    db.select({ key: systemCache.key, value: systemCache.value, updatedAt: systemCache.updatedAt, expiresAt: systemCache.expiresAt }).from(systemCache)
      .where(like(systemCache.key, `${OPERATOR_RECOVERY_KEY_PREFIX}%`)).catch(() => null),
    // Calls that reached a model: a rule or a budget/breaker fallback asks none (§6.4).
    db.select({ count: sql<number>`(count(*) filter (where coalesce(${decisionRecords.attemptCount}, 0) > 0))::int`, costUsd: sql<number>`coalesce(sum(${decisionRecords.costUsd}), 0)::float8` }).from(decisionRecords)
      .where(and(inArray(decisionRecords.capability, [...OPERATOR_RECOVERY_DECISION_KINDS]), gte(decisionRecords.createdAt, startOfDay))).catch(() => null),
    // §5.6 owner overrides: the newest row per cause wins; expiry is the queue's to check.
    db.select({ subjectId: decisionRecords.subjectId, humanOverride: decisionRecords.humanOverride, overriddenBy: decisionRecords.overriddenBy, createdAt: decisionRecords.createdAt })
      .from(decisionRecords)
      .where(and(eq(decisionRecords.capability, PRIORITY_CAPABILITY), eq(decisionRecords.subjectType, 'cause'), gte(decisionRecords.createdAt, new Date(now.getTime() - 8 * DAY_MS))))
      .orderBy(desc(decisionRecords.createdAt)).limit(500).catch(() => []),
    // §6.2: the newest operator-recovery answers per cause, and their 7-day model spend.
    db.select({
      capability: decisionRecords.capability, subjectId: decisionRecords.subjectId, id: decisionRecords.id, status: decisionRecords.status,
      appliedAnswer: decisionRecords.appliedAnswer, confidence: decisionRecords.confidence, reason: decisionRecords.reason, costUsd: decisionRecords.costUsd,
    }).from(decisionRecords)
      .where(and(inArray(decisionRecords.capability, [...OPERATOR_RECOVERY_DECISION_KINDS]), eq(decisionRecords.subjectType, 'cause'), gte(decisionRecords.createdAt, new Date(now.getTime() - 7 * DAY_MS))))
      .orderBy(desc(decisionRecords.createdAt)).limit(2000).catch(() => []),
  ]);
  const modelDecisions = buildCauseModelDecisions(modelDecisionRows);
  const overrides = new Map<string, PriorityOverride>();
  for (const o of overrideRows) {
    const h = o.humanOverride as { mode?: unknown; until?: unknown; reason?: unknown; by?: unknown } | null;
    if (!o.subjectId || overrides.has(o.subjectId) || !h || (h.mode !== 'pin_top' && h.mode !== 'demote' && h.mode !== 'snooze') || typeof h.until !== 'string') continue;
    overrides.set(o.subjectId, { mode: h.mode, until: h.until, by: typeof h.by === 'string' ? h.by : o.overriddenBy ?? 'owner', reason: typeof h.reason === 'string' ? h.reason : '' });
  }

  const teamIds = [...new Set(wsRows.map(w => w.teamId).filter((x): x is string => !!x))];
  const teamRows = teamIds.length ? await db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, teamIds)) : [];

  const missionMap = new Map<string, { id: string; title: string; workspaceId: string | null }>();
  for (const t of taskRows ?? []) if (t.missionId && t.missionTitle) missionMap.set(t.missionId, { id: t.missionId, title: t.missionTitle, workspaceId: t.missionWorkspaceId });
  const fixPrs = new Map<string, { number: number; url: string; state: string; workspaceId: string }>();
  for (const w of workerRows ?? []) {
    if (!w.taskId || !fixIds.has(w.taskId) || fixPrs.has(w.taskId) || w.prNumber === null || !w.prUrl) continue;
    fixPrs.set(w.taskId, { number: w.prNumber, url: w.prUrl, state: w.prState ?? 'unknown', workspaceId: w.workspaceId });
  }
  const personVerdicts = verdictRows === null ? null : new Set(verdictRows
    .filter(v => verdictFromCode(v.appliedAnswer)?.owner === 'person' && v.subjectId)
    .map(v => v.subjectId!.slice(INCIDENT_SUBJECT_TYPE.length + 1)));

  return {
    now: now.toISOString(),
    window: opts.window,
    platformWide: opts.platformWide,
    incidents,
    workspaces: new Map(wsRows.map(w => [w.id, w])),
    teams: new Map(teamRows.map(t => [t.id, t])),
    tasks: taskRows === null ? null : new Map(taskRows.map(t => [t.id, { id: t.id, title: t.title, status: t.status, workspaceId: t.workspaceId, missionId: t.missionId }])),
    missions: missionMap,
    workers: workerRows === null ? null : workerRows.filter(w => !!w.taskId).map(w => ({
      taskId: w.taskId!, createdAt: w.createdAt.toISOString(), status: w.status, costUsd: w.costUsd === null ? null : Number(w.costUsd), costBasis: w.costBasis ?? null,
    })),
    prTasks: new Map(prRows.filter(r => r.taskId && r.prNumber !== null).map(r => [`${r.workspaceId}:${r.prNumber}`, r.taskId!])),
    fixPrs,
    attempts: attemptRows === null ? null : attemptRows
      .filter(a => a.detail && typeof (a.detail as { actionKey?: unknown }).actionKey === 'string')
      .map(a => ({ occurredAt: a.occurredAt.toISOString(), outcome: a.outcome, detail: a.detail as unknown as RecoveryAttemptDetail })),
    lastRun: lastRunRow ? readSentinelLastRun(lastRunRow[0]?.value ?? null) : null,
    personVerdicts,
    automation: buildAutomationView({ rows: automationRows, model: modelRows?.[0] ?? null, now }),
    automationState: buildAutomationState(automationRows, now),
    overrides,
    modelDecisions,
  };
}

/** The newest answered advice and repair suggestion per cause, and each cause's model spend (a pair's spend counts for both). */
export function buildCauseModelDecisions(rows: ReadonlyArray<{
  capability: string; subjectId: string | null; id: string; status: string; appliedAnswer: string | null; confidence: number | null; reason: string | null; costUsd: number | string | null;
}>): Map<string, CauseModelDecisions> {
  const out = new Map<string, CauseModelDecisions>();
  const entry = (key: string) => { if (!out.has(key)) out.set(key, {}); return out.get(key)!; };
  for (const r of rows) {
    if (!r.subjectId) continue;
    for (const key of r.subjectId.split('+')) {
      const e = entry(key);
      e.modelUsd7d = (e.modelUsd7d ?? 0) + (r.costUsd === null ? 0 : Number(r.costUsd));
    }
    if (r.status === 'fallback' || !r.appliedAnswer) continue;
    const e = entry(r.subjectId);
    const receipt = readOperatorReceipt(r.reason);
    if (r.capability === 'buildd.operator_priority_advice' && e.advice === undefined && receipt && r.confidence !== null
      && (r.appliedAnswer === 'raise' || r.appliedAnswer === 'keep' || r.appliedAnswer === 'lower')) {
      e.advice = { answer: r.appliedAnswer, confidence: r.confidence, rationale: receipt.rationale, decisionId: r.id };
    }
    if (r.capability === 'buildd.operator_repair_suggestion' && e.suggestion === undefined && r.appliedAnswer !== 'none') {
      e.suggestion = { repair: r.appliedAnswer, confidence: r.confidence, rationale: receipt?.rationale ?? null, decisionId: r.id };
    }
  }
  return out;
}

/**
 * The `recovery` panel: one ranked row per cause across the scoped workspaces.
 * The route turns a throw into `recovery: null` (Can't confirm), like every
 * other panel.
 */
export async function loadRecoveryQueue(opts: RecoveryReadOpts & { includeRecovered?: boolean; filter?: RecoveryFilter }): Promise<RecoveryPanel> {
  const facts = await loadRecoveryFacts(opts);
  return buildRecoveryPanel(facts, { includeRecovered: opts.includeRecovered, filter: opts.filter });
}

/** The `recoveryCause` drill-down, or null when no scoped incident groups under the key. */
export async function loadRecoveryCause(opts: RecoveryReadOpts & { causeKey: string }): Promise<RecoveryCauseDetail | null> {
  const facts = await loadRecoveryFacts(opts);
  const probe = buildRecoveryCauseDetail(facts, opts.causeKey, { decisions: [], audit: [], notifications: { delivered: 0, suppressed: 0, lastDeliveredAt: null }, verdicts: new Map() });
  if (!probe) return null;
  const ids = probe.incidents.map(i => i.incidentId);
  const subjectKeys = ids.map(incidentSubjectKey);
  const [decisionRows, auditRows, deliveryRows] = await Promise.all([
    db.select({
      id: decisionRecords.id, capability: decisionRecords.capability, status: decisionRecords.status, appliedAnswer: decisionRecords.appliedAnswer,
      confidence: decisionRecords.confidence, reason: decisionRecords.reason, model: decisionRecords.model, promptVersion: decisionRecords.promptVersion,
      policyVersion: decisionRecords.policyVersion, costUsd: decisionRecords.costUsd, subjectId: decisionRecords.subjectId,
    }).from(decisionRecords)
      .where(or(
        and(eq(decisionRecords.subjectType, INCIDENT_SUBJECT_TYPE), inArray(decisionRecords.subjectId, subjectKeys)),
        and(eq(decisionRecords.subjectType, 'cause'), eq(decisionRecords.subjectId, opts.causeKey)),
      ))
      .orderBy(desc(decisionRecords.createdAt)).limit(100).catch(() => []),
    db.select().from(platformAdminAuditEvents)
      .where(or(
        and(sql`${platformAdminAuditEvents.targetType} = 'cause'`, eq(platformAdminAuditEvents.targetId, opts.causeKey)),
        and(sql`${platformAdminAuditEvents.targetType} = 'incident'`, inArray(platformAdminAuditEvents.targetId, ids)),
      ))
      .orderBy(desc(platformAdminAuditEvents.occurredAt)).limit(100).catch(() => []),
    db.select({ status: notificationDeliveries.status, deliveredAt: notificationDeliveries.deliveredAt }).from(notificationDeliveries)
      .where(or(...ids.map(id => like(notificationDeliveries.dedupeKey, `failure-incident:${id}:%`)), ...ids.map(id => like(notificationDeliveries.dedupeKey, `recovery:${id}:%`))))
      .limit(500).catch(() => []),
  ]);
  const verdicts = new Map<string, { owner: 'buildd' | 'person' }>();
  for (const d of decisionRows) {
    if (d.capability !== ESCALATION_GATE_CAPABILITY || !d.subjectId) continue;
    const id = d.subjectId.slice(INCIDENT_SUBJECT_TYPE.length + 1);
    const v = verdictFromCode(d.appliedAnswer);
    if (v && !verdicts.has(id)) verdicts.set(id, { owner: v.owner === 'person' ? 'person' : 'buildd' });
  }
  const alerted = facts.incidents.filter(i => ids.includes(i.id)).map(i => i.lastAlertedAt).filter((x): x is string => !!x);
  const delivered = deliveryRows.filter(r => r.status === 'delivered' || r.status === 'read');
  const lastDelivered = [...delivered.map(r => r.deliveredAt?.toISOString()).filter((x): x is string => !!x), ...alerted].sort().pop() ?? null;
  return buildRecoveryCauseDetail(facts, opts.causeKey, {
    verdicts,
    decisions: decisionRows.map(d => ({
      decisionId: d.id,
      kind: d.capability,
      // Every operator-recovery kind is live from its first deploy (owner decision 2026-10-11), like the escalation gate.
      mode: 'live' as const,
      answer: d.appliedAnswer ?? d.status,
      confidence: d.confidence,
      rationale: d.reason,
      model: d.model,
      promptVersion: d.promptVersion,
      policyVersion: d.policyVersion,
      outcome: null,
      costUsd: d.costUsd,
    })),
    audit: auditRows.map(a => ({
      at: a.occurredAt.toISOString(),
      actorAccountId: a.actorAccountId ?? '',
      operatorLabel: (() => { const l = (a.after as { operatorLabel?: unknown } | null)?.operatorLabel; return typeof l === 'string' ? l : null; })(),
      action: a.action,
      before: a.before,
      after: a.after,
    })),
    notifications: {
      // Pages go through notifyTeam, outside this ledger: a page with no row still counts once.
      delivered: Math.max(delivered.length, alerted.length),
      suppressed: deliveryRows.filter(r => r.status === 'coalesced' || r.status === 'held' || r.status === 'dropped').length,
      lastDeliveredAt: lastDelivered,
    },
  });
}

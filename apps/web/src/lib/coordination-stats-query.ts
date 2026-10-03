import type { CoordinationStats } from '@buildd/shared';
import { db } from '@buildd/core/db';
import { tasks, gateEvents, workspaces } from '@buildd/core/db/schema';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { GATE_SLUGS } from '@buildd/core/gate-slugs';
import { OPT_IN_CAPABILITIES } from '@buildd/core/inference-policy';
import { manifestCounts } from './coordination-stats';

/** Aggregates in Postgres: reports are never silently clipped by a row limit. */
export async function fetchCoordinationStats(input: {
  workspaceIds: string[]; missionId?: string; window: '24h' | '7d' | '30d';
}): Promise<CoordinationStats> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - ({ '24h': 1, '7d': 7, '30d': 30 }[input.window]) * 86400000);
  const filters = { window: input.window, windowStart: windowStart.toISOString(), workspaceIds: input.workspaceIds, missionId: input.missionId ?? null };
  const workspaceRows = input.workspaceIds.length ? await db.query.workspaces.findMany({
    where: inArray(workspaces.id, input.workspaceIds),
    columns: { id: true },
    with: { team: { columns: { enabledDecisionShadows: true } } },
  }) : [];
  const decisionCapabilities = workspaceRows.flatMap(workspace =>
    OPT_IN_CAPABILITIES.filter(capability => capability.startsWith('orchestration_')).map(capability => ({
      workspaceId: workspace.id,
      capability,
      status: workspace.team.enabledDecisionShadows?.includes(capability) ? 'enabled' as const : 'capability_disabled' as const,
    })),
  );
  const manifestRows = input.workspaceIds.length ? await db.select({
    workspaceId: tasks.workspaceId, missionId: tasks.missionId, kind: tasks.kind,
    total: sql<number>`count(*)::int`,
    concrete: sql<number>`count(*) filter (where jsonb_array_length(coalesce(${tasks.pathManifest}, '[]'::jsonb)) > 0 and not coalesce(${tasks.pathManifest}, '[]'::jsonb) @> '["**"]'::jsonb)::int`,
    advisory: sql<number>`count(*) filter (where coalesce(${tasks.pathManifest}, '[]'::jsonb) @> '["**"]'::jsonb)::int`,
    none: sql<number>`count(*) filter (where jsonb_array_length(coalesce(${tasks.pathManifest}, '[]'::jsonb)) = 0)::int`,
  }).from(tasks).where(and(
    inArray(tasks.workspaceId, input.workspaceIds), gte(tasks.createdAt, windowStart),
    input.missionId ? eq(tasks.missionId, input.missionId) : undefined,
  )).groupBy(tasks.workspaceId, tasks.missionId, tasks.kind) : [];

  const callRows = input.workspaceIds.length ? await db.select({
    surface: gateEvents.surface,
    claimed: sql<number>`count(*) filter (where ${gateEvents.detail}->>'claimResult' = 'claimed')::int`,
    blocked: sql<number>`count(*) filter (where ${gateEvents.outcome} = 'deferred' and coalesce(${gateEvents.detail}->>'deadlock', 'false') <> 'true')::int`,
    deadlock: sql<number>`count(*) filter (where ${gateEvents.outcome} = 'deferred' and ${gateEvents.detail}->>'deadlock' = 'true')::int`,
    rejected: sql<number>`count(*) filter (where ${gateEvents.outcome} = 'rejected')::int`,
    firstRecordedAt: sql<string | null>`min(${gateEvents.occurredAt})::text`,
  }).from(gateEvents).where(and(
    inArray(gateEvents.workspaceId, input.workspaceIds), eq(gateEvents.gate, GATE_SLUGS.PATH_CLAIM),
    gte(gateEvents.occurredAt, windowStart),
    input.missionId ? eq(gateEvents.missionId, input.missionId) : undefined,
  )).groupBy(gateEvents.surface) : [];
  const sums = callRows.reduce((sum, row) => ({
    claimed: sum.claimed + Number(row.claimed), blocked: sum.blocked + Number(row.blocked),
    deadlock: sum.deadlock + Number(row.deadlock), rejected: sum.rejected + Number(row.rejected),
  }), { claimed: 0, blocked: 0, deadlock: 0, rejected: 0 });
  return {
    manifestCoverage: { ...filters, decisionCapabilities, ...manifestCounts(manifestRows), groups: manifestRows.map(row => ({ ...row, ...manifestCounts([row]) })) },
    pathClaims: {
      ...filters, decisionCapabilities, ...sums, calls: sums.claimed + sums.blocked + sums.deadlock + sums.rejected,
      bySurface: callRows,
      coverage: { completeHistoricalCalls: false, note: 'Successful calls are recorded from instrumentation rollout; earlier ledger history contains refusals only. Invalid or unauthorized requests are excluded.' },
    },
  };
}

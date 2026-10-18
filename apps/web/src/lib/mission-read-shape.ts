import type { MissionSummary } from '@buildd/shared';

/** Named compatibility escape hatch for callers that need the mission editor's detail. */
export function missionReadOptions(params: URLSearchParams) {
  const raw = Number(params.get('limit'));
  return {
    details: (params.get('include') ?? '').split(',').includes('details'),
    limit: Number.isInteger(raw) && raw > 0 ? Math.min(raw, 100) : 50,
  };
}

export const MISSION_SUMMARY_COLUMNS = {
  id: true, teamId: true, workspaceId: true, title: true, status: true,
  priority: true, isHeld: true, executor: true, createdAt: true, updatedAt: true,
  completedAt: true, armedAt: true, lastTaskStartedAt: true,
} as const;

/** Explicit projection also protects callers using adapters that ignore Drizzle columns. */
export function missionSummaryResponse(row: Record<string, any>, summary: MissionSummary | null) {
  return {
    ...Object.fromEntries(Object.keys(MISSION_SUMMARY_COLUMNS).map(key => [key, row[key]])),
    summary,
    totalTasks: summary?.progress.total ?? 0,
    completedTasks: summary?.progress.done ?? 0,
    progress: summary?.progress.percent ?? 0,
    activeAgents: summary?.liveWorkers ?? 0,
    lastActivityAt: summary?.lastActivityAt ?? null,
  };
}

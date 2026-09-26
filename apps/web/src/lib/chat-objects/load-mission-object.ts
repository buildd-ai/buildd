/**
 * A mission as a live chat object: the same Board model the mission page draws
 * (`buildMissionBoard` over the same rows), so the inline card, the docked pane
 * and `/app/missions/[id]` never disagree.
 *
 * Read-only: the mission page's merge-state read-through repair
 * (`refreshWorkerMergeStateIfStale`) is deliberately not repeated here — a
 * chat pane refetches on every structural event and must not write.
 */
import { db } from '@buildd/core/db';
import { missions, workspaceSkills, missionNotes } from '@buildd/core/db/schema';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { deriveMissionProgressMetric, hasPendingDeliverableWork as computeHasPendingDeliverableWork } from '@buildd/core/mission-helpers';
import { getUserTeamIds, getUserWorkspaceIds } from '@/lib/team-access';
import { deriveMissionDisplayState, deriveTaskHealthSignal, getMissionStateChip } from '@/lib/mission-helpers';
import { LIVE_WORKER_STATUSES } from '@/lib/task-presentation';
import { buildMissionBoard, toBoardTaskInput } from '@/lib/mission-board';
import { loadRunnerHeartbeats } from '@/lib/runner-heartbeats';
import { loadFleetCapacity } from '@/lib/home-fleet';
import { MISSION_DETAIL_WITH } from '@/app/app/(protected)/missions/[id]/mission-page-query';
import type { MissionObjectView } from '@/components/chat/objects/object-views';

/** The description's first paragraph as plain text — the mission page's `goalLine`. */
export function missionGoalLine(description: string | null | undefined): string | null {
  return (description ?? '').split(/\n\s*\n/)[0].replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim() || null;
}

export async function loadMissionObject(missionId: string, userId: string): Promise<MissionObjectView | null> {
  const [teamIds, mission] = await Promise.all([
    getUserTeamIds(userId),
    db.query.missions.findFirst({ where: eq(missions.id, missionId), with: MISSION_DETAIL_WITH }),
  ]);
  if (!mission || !teamIds.includes(mission.teamId)) return null;

  const m = mission as typeof mission & Record<string, any>;
  const taskIds = (mission.tasks || []).map(t => t.id);
  const now = Date.now();

  const [roles, humanSteeringNotes, runnerHeartbeats, fleetCapacity] = await Promise.all([
    (async () => {
      const wsIds = await getUserWorkspaceIds(userId);
      if (wsIds.length === 0) return [] as { slug: string; name: string; color: string }[];
      return db.query.workspaceSkills.findMany({
        where: and(inArray(workspaceSkills.workspaceId, wsIds), eq(workspaceSkills.enabled, true)),
        columns: { slug: true, name: true, color: true },
        orderBy: [desc(workspaceSkills.createdAt)],
      });
    })(),
    // Human touches: mission-scoped notes and task-scoped ones (written with
    // missionId null), as the mission page reads them.
    db.query.missionNotes.findMany({
      where: and(
        taskIds.length > 0
          ? or(eq(missionNotes.missionId, missionId), inArray(missionNotes.taskId, taskIds))
          : eq(missionNotes.missionId, missionId),
        eq(missionNotes.authorType, 'user'),
      ),
      columns: { id: true, createdAt: true },
    }),
    loadRunnerHeartbeats((mission.tasks || []).flatMap(t => (t.workers ?? []) as Array<{ runner?: string | null; localUiUrl?: string | null; accountId?: string | null }>)),
    (async () => loadFleetCapacity({ teamId: mission.teamId ?? null, wsIds: await getUserWorkspaceIds(userId), now }))()
      .catch(() => null),
  ]);

  const allTasks = (mission.tasks || []).slice().sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  const allArtifacts = (mission.tasks ?? []).flatMap(t => (t.workers ?? []).flatMap(w => (w as any).artifacts ?? []));
  const goalCriteria = (m.goalCriteria as Array<{ type: string; label?: string; key?: string; artifactType?: string }> | null) ?? [];
  const goalCriteriaState = m.goalCriteriaState as { overall?: string; criteria?: Array<{ index: number; verdict: string }> } | null;

  const board = buildMissionBoard({
    runnerHeartbeats,
    fleetCapacity,
    tasks: allTasks.map(t => toBoardTaskInput(t as unknown as Parameters<typeof toBoardTaskInput>[0])),
    roles,
    now,
    missionCreatedAt: new Date(m.createdAt).getTime(),
    missionCompletedAt: m.completedAt ? new Date(m.completedAt).getTime() : null,
    missionStatus: mission.status,
    criteria: goalCriteria,
    criteriaState: goalCriteriaState?.criteria ?? [],
    artifacts: allArtifacts.map((a: any) => ({ key: a.key ?? null, type: a.type ?? null })),
    humanTouches: humanSteeringNotes.map(n => new Date(n.createdAt).getTime()),
  });

  // The page's fallback chain for the header chip (it prefers `explain`'s
  // answer when that read succeeds; a pane skips the extra accessor).
  const live = new Set<string>(LIVE_WORKER_STATUSES);
  const activeAgents = (mission.tasks ?? []).flatMap(t => t.workers || []).filter(w => live.has(w.status)).length;
  const progressMetric = deriveMissionProgressMetric(mission.tasks || []);
  const criteriaUnverified = goalCriteria.length > 0 && goalCriteriaState?.overall !== 'pass';
  const heartbeatWaitingUntil = (m.schedule as any)?.lastDeferralReason === 'heartbeat_waiting' ? (m.schedule as any)?.nextRunAt ?? null : null;
  const displayState = deriveMissionDisplayState({
    status: mission.status,
    isHeld: m.isHeld === true,
    orchestrationMode: (mission.orchestrationMode as string | null) ?? 'auto',
    activeAgents,
    health: deriveTaskHealthSignal({ ...mission, heartbeatWaitingUntil } as any, (mission.tasks || []) as any),
    progress: progressMetric.kind === 'value' ? progressMetric.value : undefined,
    criteriaUnverified,
    criteriaEscalatedAt: m.criteriaEscalatedAt ?? null,
    hasPendingDeliverableWork: computeHasPendingDeliverableWork(mission.tasks || []),
  });
  const stateLabel = getMissionStateChip(displayState)?.label ?? mission.status;

  return {
    kind: 'mission',
    id: mission.id,
    workspaceId: mission.workspaceId ?? '',
    title: mission.title,
    goal: missionGoalLine(mission.description),
    status: mission.status,
    stateLabel,
    workspaceName: (mission as any).workspace?.name ?? null,
    conversationId: (m.conversationId as string | null | undefined) ?? null,
    board,
    renderedAt: now,
  };
}

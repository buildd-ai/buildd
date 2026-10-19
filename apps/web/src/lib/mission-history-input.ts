/**
 * The mission page's rows as the Activity episode builder reads them, so
 * Mission History's Highlights are `buildActivityEpisodes` over this
 * mission's own tasks, with the same mission projection Home and Missions
 * use. Rows only change shape here; no state is derived.
 */
import { projectMissionDelivery, type MissionDelivery, type MissionTaskRules } from './delivery-projection';
import { reviewOf, type ActivityTaskInput } from './activity-delivery';

type Stamp = Date | string | null | undefined;
const iso = (d: Stamp): string | null => (d ? new Date(d).toISOString() : null);

export interface MissionHistoryWorkerRow {
  status: string;
  name?: string | null;
  runner?: string | null;
  waitingFor?: { prompt?: string | null } | null;
  startedAt?: Stamp;
  completedAt?: Stamp;
  updatedAt?: Stamp;
  prUrl?: string | null;
  prNumber?: number | null;
  mergedAt?: Stamp;
  prLifecycleStatus?: string | null;
  supersededByPrNumber?: number | null;
  abandonedAt?: Stamp;
  lastCommitSha?: string | null;
}

export interface MissionHistoryTaskRow {
  id: string;
  title: string;
  status: string;
  mode?: string | null;
  taskClass?: string | null;
  parentTaskId?: string | null;
  createdAt: Stamp;
  updatedAt: Stamp;
  workers?: readonly MissionHistoryWorkerRow[] | null;
}

export function missionHistoryInputs(input: {
  mission: { id: string; title: string; status: string; isHeld?: boolean | null; armedAt?: Stamp; integrationBranchEnabled?: boolean | null };
  /** The page's rows, delivery overlay already applied (so a kernel-owned PR reads as its delivery says). */
  tasks: readonly MissionHistoryTaskRow[];
  digestOf: (taskId: string) => { result: unknown; context: unknown };
  rules: MissionTaskRules;
}): { tasks: ActivityTaskInput[]; missions: MissionDelivery[] } {
  const { mission, rules } = input;
  const tasks: ActivityTaskInput[] = input.tasks.map(t => {
    const type = rules.deriveTaskType(t as never);
    const isReview = type === 'review' || type === 'review-retry';
    const ws = t.workers ?? [];
    const waiting = ws.find(w => w.status === 'waiting_input')?.waitingFor;
    const digest = input.digestOf(t.id);
    return {
      id: t.id, title: t.title, status: t.status, mode: t.mode ?? null, taskClass: t.taskClass ?? null,
      parentTaskId: t.parentTaskId ?? null, missionId: mission.id, missionTitle: mission.title,
      createdAt: iso(t.createdAt) ?? new Date(0).toISOString(), updatedAt: iso(t.updatedAt) ?? new Date(0).toISOString(),
      waitingPrompt: waiting ? waiting.prompt || 'Has a question' : null,
      review: isReview ? reviewOf(digest.result, digest.context) : null,
      workers: ws.map(w => ({
        status: w.status, name: w.name ?? w.runner ?? null,
        startedAt: iso(w.startedAt), completedAt: iso(w.completedAt), updatedAt: iso(w.updatedAt),
        prUrl: w.prUrl ?? null, prNumber: w.prNumber ?? null, mergedAt: iso(w.mergedAt),
        prLifecycleStatus: w.prLifecycleStatus ?? null, supersededByPrNumber: w.supersededByPrNumber ?? null,
        abandonedAt: iso(w.abandonedAt), lastCommitSha: w.lastCommitSha ?? null,
      })),
    };
  });
  const delivery = projectMissionDelivery({
    id: mission.id, title: mission.title, status: mission.status, href: `/app/missions/${mission.id}`,
    isHeld: mission.isHeld ?? false, armedAt: mission.armedAt ?? null, integrationBranch: mission.integrationBranchEnabled === true,
    tasks: input.tasks as never,
  }, rules);
  return { tasks, missions: [delivery] };
}

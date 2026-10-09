/**
 * Mission detail's per-task delivery: the rows the page already loads, through
 * the shared projection (lib/delivery-projection.ts) and Activity's evidence
 * model (lib/activity-delivery.ts). Pure, so the dev fixture and the page build
 * it the same way.
 *
 * The missions module's task rules arrive as `rules` (`@buildd/core/mission-helpers`),
 * as they do for every other caller of the projection.
 */
import { integrationRefreshOf } from '@/lib/integration-refresh';
import { projectMissionDelivery, type MissionTaskRules } from '@/lib/delivery-projection';
import { buildTaskDeliveryDetails, reviewOf, type ActivityTaskInput, type TaskDeliveryDetail } from '@/lib/activity-delivery';

type When = Date | string | number | null | undefined;

export interface MissionDeliveryWorkerRow {
  status: string;
  prUrl?: string | null;
  prNumber?: number | null;
  mergedAt?: When;
  prLifecycleStatus?: string | null;
  supersededByPrNumber?: number | null;
  abandonedAt?: When;
  lastCommitSha?: string | null;
  startedAt?: When;
  completedAt?: When;
  updatedAt?: When;
}

export interface MissionDeliveryTaskRow {
  id: string;
  title: string;
  status: string;
  mode?: string | null;
  taskClass?: string | null;
  parentTaskId?: string | null;
  kind?: string | null;
  category?: string | null;
  creationSource?: string | null;
  dependsOn?: readonly string[] | null;
  isIntegrationRefresh?: boolean | null;
  createdAt: When;
  updatedAt?: When;
  workers?: readonly MissionDeliveryWorkerRow[] | null;
}

const iso = (v: When): string | null => (v == null ? null : new Date(v).toISOString());
const time = (v: When) => (v == null ? 0 : new Date(v).getTime());

export function missionTaskDeliveries(input: {
  mission: { id: string; title: string; status: string; isHeld?: boolean | null; integrationBranch?: boolean | null };
  tasks: readonly MissionDeliveryTaskRow[];
  /** The page's result/context digest for a task (mission-page-query.ts). */
  digestOf: (taskId: string) => { result: unknown; context: unknown };
  rules: MissionTaskRules;
}): Record<string, TaskDeliveryDetail> {
  const { rules, mission: m } = input;
  // Newest worker first: the projection's "which PR is this about" reads that order.
  const workersOf = (t: MissionDeliveryTaskRow) => [...(t.workers ?? [])].sort((a, b) => time(b.startedAt) - time(a.startedAt));
  const mission = projectMissionDelivery({
    id: m.id, title: m.title, status: m.status, href: `/app/missions/${m.id}`,
    isHeld: m.isHeld ?? false, integrationBranch: m.integrationBranch === true,
    tasks: input.tasks.map(t => ({ ...t, isIntegrationRefresh: t.isIntegrationRefresh ?? integrationRefreshOf(input.digestOf(t.id).context) !== null, workers: workersOf(t).map(w => ({ ...w, mergedAt: iso(w.mergedAt), abandonedAt: iso(w.abandonedAt) })) })),
  }, rules);
  const tasks: ActivityTaskInput[] = input.tasks.map(t => {
    const type = rules.deriveTaskType(t);
    const digest = input.digestOf(t.id);
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      mode: t.mode ?? null,
      taskClass: t.taskClass ?? null,
      parentTaskId: t.parentTaskId ?? null,
      missionId: m.id,
      missionTitle: m.title,
      createdAt: iso(t.createdAt) ?? new Date(0).toISOString(),
      updatedAt: iso(t.updatedAt ?? t.createdAt) ?? new Date(0).toISOString(),
      review: type === 'review' || type === 'review-retry' ? reviewOf(digest.result, digest.context) : null,
      workers: workersOf(t).map(w => ({
        status: w.status,
        prUrl: w.prUrl ?? null,
        prNumber: w.prNumber ?? null,
        mergedAt: iso(w.mergedAt),
        prLifecycleStatus: w.prLifecycleStatus ?? null,
        supersededByPrNumber: w.supersededByPrNumber ?? null,
        abandonedAt: iso(w.abandonedAt),
        lastCommitSha: w.lastCommitSha ?? null,
        startedAt: iso(w.startedAt),
        completedAt: iso(w.completedAt),
        updatedAt: iso(w.updatedAt),
      })),
    };
  });
  return buildTaskDeliveryDetails({ tasks, mission, rules });
}

/**
 * The Insights band drill-down's rows: each task's state through the same
 * delivery projection Activity reads (`projectTaskDelivery` → `lifecycleState`),
 * so a task reads the same here as in Activity.
 */
import type { StateKey } from '@/components/ui/states';
import { lifecycleState } from '@/components/delivery/lifecycle-state';
import { projectTaskDelivery, type DeliveryWorker } from '@/lib/delivery-projection';

export interface BandTaskInput {
  id: string;
  title: string;
  status: string;
  missionTitle: string | null;
  updatedAt: string;
  workers: ReadonlyArray<DeliveryWorker & { prNumber?: number | null }>;
}

export interface BandRow {
  id: string;
  title: string;
  state: StateKey;
  missionTitle: string | null;
  prNumber: number | null;
  updatedAt: string;
}

export function bandRows(tasks: readonly BandTaskInput[]): BandRow[] {
  return tasks
    .map(t => ({
      id: t.id,
      title: t.title,
      state: lifecycleState(projectTaskDelivery({ status: t.status, workers: t.workers }).kind),
      missionTitle: t.missionTitle,
      prNumber: t.workers.find(w => w.prNumber != null)?.prNumber ?? null,
      updatedAt: t.updatedAt,
    }))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
}

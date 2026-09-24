/**
 * Pure helpers shared by the mission feed: phase grouping (the order the pulse
 * and the task list share, `lib/mission-pulse.ts`) and the Records selection.
 */
import { isReviewArtifact, type ArtifactProminenceInput } from '@/lib/artifact-prominence';

export interface PhaseGroupableTask {
  id: string;
  missionPhaseIndex?: number | null;
  missionPhaseLabel?: string | null;
}

export interface PhaseGroup<T> {
  index: number | null;
  label: string | null;
  tasks: T[];
}

/**
 * Groups tasks by their stored `missionPhaseIndex`/`missionPhaseLabel`, in
 * phase order. Rule X-3/X-4: a mission where NO task carries a stored phase
 * stays ungrouped — one flat group with `index: null`, unchanged from today.
 * A mission with a partial mix of phased/unphased tasks still groups (the
 * unphased ones collect into a trailing `null` group) because phase data is
 * present and meaningful for at least part of the mission.
 */
export function groupTasksByPhase<T extends PhaseGroupableTask>(tasks: readonly T[]): PhaseGroup<T>[] {
  const hasAnyPhase = tasks.some(t => t.missionPhaseIndex != null && t.missionPhaseLabel != null);
  if (!hasAnyPhase) {
    return [{ index: null, label: null, tasks: [...tasks] }];
  }

  const byIndex = new Map<number, PhaseGroup<T>>();
  const unphased: T[] = [];
  const order: number[] = [];
  for (const task of tasks) {
    if (task.missionPhaseIndex == null || task.missionPhaseLabel == null) {
      unphased.push(task);
      continue;
    }
    let group = byIndex.get(task.missionPhaseIndex);
    if (!group) {
      group = { index: task.missionPhaseIndex, label: task.missionPhaseLabel, tasks: [] };
      byIndex.set(task.missionPhaseIndex, group);
      order.push(task.missionPhaseIndex);
    }
    group.tasks.push(task);
  }
  order.sort((a, b) => a - b);
  const groups = order.map(i => byIndex.get(i)!);
  if (unphased.length > 0) groups.push({ index: null, label: null, tasks: unphased });
  return groups;
}

/** Mission-level Records row: review-worthy artifacts only (AC-15 — captures never included). */
export function selectMissionRecords<T extends ArtifactProminenceInput>(artifacts: readonly T[]): T[] {
  return artifacts.filter(isReviewArtifact);
}

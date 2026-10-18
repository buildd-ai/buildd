/**
 * Listed missions' stages, read from their stored summaries (spec 3ef37387
 * R-13): one indexed read for the whole list, no tasks or workers. A mission
 * with no stored summary of the current version (not yet backfilled, or
 * written by older code) is derived live by `loadMissionStages`, exactly as
 * before, and its summary is queued to be written after the response, so the
 * next read finds it.
 *
 * Scoped like the live loader: a mission outside the caller's workspaces, or
 * an unknown id, is absent.
 */
import type { MissionStage } from '@buildd/shared';
import { loadMissionStages } from './mission-stage-load';
import { readMissionSummaries, refreshMissionSummary } from './mission-summary-store';

export async function loadMissionStagesFromSummaries(missionIds: string[], workspaceIds: string[]): Promise<Map<string, MissionStage>> {
  const out = new Map<string, MissionStage>();
  if (missionIds.length === 0 || workspaceIds.length === 0) return out;
  const stored = await readMissionSummaries(missionIds, workspaceIds).catch((err) => {
    console.error('[mission-stage-read] stored summaries unreadable, deriving live:', err);
    return new Map<string, never>();
  });
  for (const [id, row] of stored) out.set(id, row.summary.stage);
  const missing = missionIds.filter(id => !out.has(id));
  if (missing.length === 0) return out;
  const live = await loadMissionStages(missing, workspaceIds);
  for (const [id, stage] of live) out.set(id, stage);
  refreshMissionSummary(...live.keys());
  return out;
}

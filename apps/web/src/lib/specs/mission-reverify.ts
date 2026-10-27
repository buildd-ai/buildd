import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { livingSpecCriteriaOf } from './selected-scope';
import { loadMission, missionVerdictCriterion, readMissionSpecStanding, resolveMissionCheckTarget } from './mission-outcome';
import { runFinalAcceptanceChecks } from './mission-acceptance-checks';

export type Reverify =
  | { ok: true; taskId: string; headSha: string; /** queued: filed now or waiting; running: a runner has it. */ state: 'queued' | 'running'; filed: boolean }
  | { ok: false; status: 404 | 409; error: string };

/**
 * Re-verify a mission in one action: file the batched criterion check run for
 * its current integrated target, or report the one already queued or running
 * (idempotent). The run belongs to the mission's final verification, filed
 * here when the mission has none yet.
 */
export async function reverifyMission(missionId: string, opts: { specId?: string } = {}): Promise<Reverify> {
  const mission = await loadMission(missionId);
  if (!mission?.workspaceId) return { ok: false, status: 404, error: 'Mission not found' };
  const picked = missionVerdictCriterion(livingSpecCriteriaOf(mission.goalCriteria), opts.specId);
  if (!picked.ok) return { ok: false, status: 409, error: picked.reason };
  const target = await resolveMissionCheckTarget(missionId);
  if (!target) return { ok: false, status: 409, error: 'No integrated target to verify against yet' };
  const { ensureFinalVerification } = await import('./mission-verification');
  const fv = await ensureFinalVerification(missionId, picked.criterion, await readMissionSpecStanding(mission, picked.criterion));
  if (fv.kind === 'unavailable') return { ok: false, status: 409, error: `Could not file the verification: ${fv.reason}` };
  const r = await runFinalAcceptanceChecks(fv.taskId, missionId, { rerun: true });
  if (!r?.taskId) return { ok: false, status: 409, error: r?.reason ?? 'No criterion of this mission names a check to run' };
  const [run] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, r.taskId)).limit(1);
  return { ok: true, taskId: r.taskId, headSha: target.headSha, state: run?.status === 'in_progress' ? 'running' : 'queued', filed: !r.inFlight };
}

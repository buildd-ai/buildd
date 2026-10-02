/**
 * Accepted patterns (docs/specs/mission-goal-criteria-quality.md §4): when a
 * mission completes cleanly and one of its final criteria had been warned weak
 * and then kept (`bypassed`), the author was right and the judge was wrong.
 * Save that as a workspace-scoped `pattern` memory carrying the criterion's
 * fingerprint, so the rubric suppresses it next time.
 *
 * Clean means: status `completed`, goal-criteria overall `pass`, never
 * escalated. The memory describes the criterion's shape, never its text or any
 * id. A sensitive workspace has no memory scope and gets nothing.
 *
 * Recall before save: an existing row for the same fingerprint in the scope is
 * updated (which also bumps it to the front of the rubric) rather than
 * duplicated. Never throws; called after completion has already happened.
 */
import type { GoalCriterion, GoalCriteriaState } from '@buildd/shared';
import { criterionFingerprint } from '@buildd/core/mission-helpers';
import { GATE_SLUGS } from '@buildd/core/gate-slugs';
import type { MemorySearchResult, SaveMemoryInput, UpdateMemoryInput } from '@buildd/core/memory-store';
import { ACCEPTED_FINGERPRINT_TAG_PREFIX, acceptedPatternMemory } from './goal-criteria-rubric';

export interface CompletedMissionFacts {
  id: string;
  teamId: string;
  workspaceId: string | null;
  status: string;
  goalCriteria: unknown;
  goalCriteriaState: GoalCriteriaState | null;
  criteriaEscalatedAt: Date | string | null;
}

/**
 * The criteria to save as accepted, deduped by fingerprint. Pure. Only a
 * clean completion qualifies, and only criteria still in the final goal.
 */
export function acceptedPatternCandidates(
  mission: CompletedMissionFacts,
  bypassedFingerprints: readonly string[],
): Array<{ criterion: GoalCriterion; fingerprint: string }> {
  if (mission.status !== 'completed') return [];
  if (mission.goalCriteriaState?.overall !== 'pass') return [];
  if (mission.criteriaEscalatedAt) return [];
  if (!Array.isArray(mission.goalCriteria)) return [];
  const bypassed = new Set(bypassedFingerprints);
  const seen = new Set<string>();
  const out: Array<{ criterion: GoalCriterion; fingerprint: string }> = [];
  for (const criterion of mission.goalCriteria as GoalCriterion[]) {
    const fingerprint = criterionFingerprint(criterion);
    if (!bypassed.has(fingerprint) || seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push({ criterion, fingerprint });
  }
  return out;
}

export interface AcceptedPatternStore {
  search(params: { type?: string; project?: string; tag?: string; limit?: number }): Promise<{ results: MemorySearchResult[] }>;
  save(input: SaveMemoryInput): Promise<unknown>;
  update(id: string, fields: UpdateMemoryInput): Promise<unknown>;
}

export interface AcceptedPatternDeps {
  loadMission?: (missionId: string) => Promise<CompletedMissionFacts | null>;
  /** Fingerprints with a `bypassed` row for the mission. */
  loadBypassed?: (missionId: string) => Promise<string[]>;
  resolveProject?: (workspaceId: string) => Promise<string | null>;
  store?: (teamId: string) => AcceptedPatternStore;
}

async function defaultLoadMission(missionId: string): Promise<CompletedMissionFacts | null> {
  const [{ db }, { missions }, { eq }] = await Promise.all([
    import('@buildd/core/db'),
    import('@buildd/core/db/schema'),
    import('drizzle-orm'),
  ]);
  const row = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { id: true, teamId: true, workspaceId: true, status: true, goalCriteria: true, goalCriteriaState: true, criteriaEscalatedAt: true },
  });
  return row ?? null;
}

async function defaultLoadBypassed(missionId: string): Promise<string[]> {
  const [{ db }, { gateEvents }, { and, eq }] = await Promise.all([
    import('@buildd/core/db'),
    import('@buildd/core/db/schema'),
    import('drizzle-orm'),
  ]);
  const rows = await db
    .select({ detail: gateEvents.detail })
    .from(gateEvents)
    .where(and(
      eq(gateEvents.gate, GATE_SLUGS.GOAL_CRITERIA_QUALITY),
      eq(gateEvents.missionId, missionId),
      eq(gateEvents.outcome, 'bypassed'),
    ))
    .limit(100);
  return rows.flatMap(r => (typeof r.detail?.fingerprint === 'string' ? [r.detail.fingerprint] : []));
}

/**
 * Save or refresh one accepted-pattern memory per qualifying criterion.
 * Returns how many were written; any failure is logged and returns what got
 * through. Never throws.
 */
export async function recordAcceptedGoalCriteriaPatterns(missionId: string, deps: AcceptedPatternDeps = {}): Promise<number> {
  let written = 0;
  try {
    const mission = await (deps.loadMission ?? defaultLoadMission)(missionId);
    if (!mission?.workspaceId) return 0;
    const bypassed = await (deps.loadBypassed ?? defaultLoadBypassed)(missionId);
    const candidates = acceptedPatternCandidates(mission, bypassed);
    if (candidates.length === 0) return 0;

    const resolveProject = deps.resolveProject ?? (await import('@buildd/core/memory-scope')).resolveMemoryProjectKey;
    const project = await resolveProject(mission.workspaceId);
    if (!project) return 0;
    const store = deps.store
      ? deps.store(mission.teamId)
      : new (await import('@buildd/core/memory-store')).MemoryStore(mission.teamId);

    for (const { criterion, fingerprint } of candidates) {
      const memory = acceptedPatternMemory(criterion, fingerprint, project);
      const existing = await store.search({ type: 'pattern', project, tag: `${ACCEPTED_FINGERPRINT_TAG_PREFIX}${fingerprint}`, limit: 1 });
      const prior = existing.results[0];
      if (prior) await store.update(prior.id, { title: memory.title, content: memory.content, tags: memory.tags });
      else await store.save({ ...memory, source: 'goal-criteria-quality', sourceKind: 'mission_completion', sourceId: missionId });
      written++;
    }
  } catch (err) {
    console.error(`[goal-criteria-accepted] ${missionId.slice(0, 8)} failed (non-fatal, completion unchanged):`, err);
  }
  return written;
}

import { db } from '@buildd/core/db';
import { missionNotes, missions } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { MAX_GOAL_CRITERIA } from '@buildd/core/mission-helpers';
import type { GoalCriterion, LivingSpecGoalCriterion } from '@buildd/shared';
import { checkCriteriaScope } from '@buildd/spec-contract/scope';
import { specCriteria } from '@buildd/spec-contract/requirements';
import { requestingPerson } from '@/lib/request-person';
import { isUuid } from '@/lib/uuid';
import { pinSpecSource, readPinnedSpecRevision } from './pin';
import { fail, reach, type SpecCaller, type SpecError } from './store';

/**
 * Selecting a mission's outcome spec (Living Specs Slice 12, D-19, R-49/R-50,
 * AC-37). The one write path, behind PATCH /api/missions/[id] `outcomeSpec`
 * and so behind MCP `manage_missions update outcomeSpec`.
 *
 * Selection idempotently adds one required `living_spec` goal criterion per
 * spec, pinned by the server (`pinSpecSource`: revision id, number and hash
 * from the database). Same spec, same revision, same scope is a no-op that
 * keeps every recorded verdict. The pin moves only when a revision is named:
 * a newer draft or a later approval never repins a mission by itself.
 *
 * Mentioning a spec as a reference, pinning tasks to it or citing it in
 * repoRefs never selects it. Existing missions are not migrated.
 *
 * Waiving a criterion and removing the selection are a person's acts, each
 * with a reason, and each leaves a decision note on the mission.
 */

export interface OutcomeSpecInput {
  specId: unknown;
  revision?: unknown;
  criteria?: unknown;
  narrowedReason?: unknown;
  waive?: unknown;
  unwaive?: unknown;
}

export type OutcomeSpecRemoval = { remove: true; specId?: unknown; reason: unknown };

const asSpecs = (raw: unknown): GoalCriterion[] => (Array.isArray(raw) ? (raw as GoalCriterion[]) : []);
const personOf = (caller: SpecCaller) => (caller.kind === 'user' ? caller.userId : requestingPerson(null, caller.account));

/**
 * Pure: merge a pinned selection into the mission's criteria. Returns the new
 * array and whether anything changed (a no-op keeps the fingerprint, so every
 * recorded verdict stays valid).
 */
export function mergeSelection(stored: readonly GoalCriterion[], next: LivingSpecGoalCriterion): { criteria: GoalCriterion[]; changed: boolean } {
  const i = stored.findIndex((c) => c.type === 'living_spec' && c.specId === next.specId);
  if (i === -1) return { criteria: [...stored, next], changed: true };
  const same = JSON.stringify(stored[i]) === JSON.stringify(next);
  if (same) return { criteria: [...stored], changed: false };
  const out = [...stored];
  out[i] = next;
  return { criteria: out, changed: true };
}

export async function selectMissionSpec(caller: SpecCaller, missionId: string, input: OutcomeSpecInput | OutcomeSpecRemoval, now = new Date()): Promise<
  { ok: true; criterion: LivingSpecGoalCriterion | null; changed: boolean; goalCriteria: GoalCriterion[] } | SpecError
> {
  if (!isUuid(missionId)) return fail(404, 'Mission not found');
  const mission = await db.query.missions.findFirst({ where: sqlWhere(eq(missions.id, missionId)), columns: { id: true, workspaceId: true, goalCriteria: true } });
  if (!mission?.workspaceId || !(await reach(caller, mission.workspaceId, true))) return fail(404, 'Mission not found');
  const stored = asSpecs(mission.goalCriteria);
  const person = personOf(caller);

  if ('remove' in input) {
    if (!person) return fail(403, 'Removing a mission\'s outcome spec is a person\'s decision: it lets the mission complete without the requirement audit');
    if (typeof input.reason !== 'string' || input.reason.trim().length < 10) return fail(400, 'reason (10+ characters: why the mission no longer answers to this spec) is required');
    const keep = stored.filter((c) => !(c.type === 'living_spec' && (input.specId === undefined || c.specId === input.specId)));
    if (keep.length === stored.length) return { ok: true, criterion: null, changed: false, goalCriteria: stored };
    await db.update(missions).set({ goalCriteria: keep, goalCriteriaState: null, updatedAt: now } as any).where(eq(missions.id, missionId));
    await note(missionId, caller, 'Outcome spec removed', input.reason.trim());
    return { ok: true, criterion: null, changed: true, goalCriteria: keep };
  }

  if (typeof input.specId !== 'string' || !isUuid(input.specId)) return fail(400, 'outcomeSpec.specId must be a spec id');
  const existing = stored.find((c): c is LivingSpecGoalCriterion => c.type === 'living_spec' && c.specId === input.specId);

  // Which revision: the one named; else the one already selected (never a
  // silent repin); else what pinning picks (the approved revision, or the
  // head, provisional, while none is approved).
  let pin: { specRevisionId: string; revision: number; contentHash: string; provisional?: true };
  if (input.revision === undefined && existing) {
    pin = { specRevisionId: existing.specRevisionId, revision: existing.revision, contentHash: existing.contentHash, ...(existing.provisional ? { provisional: true as const } : {}) };
  } else {
    const pinned = await pinSpecSource(mission.workspaceId, { specSource: { specId: input.specId, ...(input.revision !== undefined ? { revision: input.revision } : {}) } });
    if (!pinned.ok) return fail(pinned.status, pinned.error.replace(/context\.specSource\./g, 'outcomeSpec.'));
    const src = (pinned.context as { specSource: Record<string, unknown> }).specSource;
    pin = { specRevisionId: src.specRevisionId as string, revision: src.revision as number, contentHash: src.contentHash as string, ...(src.provisional ? { provisional: true as const } : {}) };
  }
  const read = await readPinnedSpecRevision({ specId: input.specId, ...pin });
  if (!read.ok) return fail(409, `The spec revision cannot be read: ${read.reason}`);
  const ids = specCriteria(read.body).map((c) => c.id);
  if (ids.length === 0) return fail(409, `Revision ${pin.revision} has no R-n or AC-n criteria, so there is nothing for the mission to verify`);

  // Scope: unchanged unless given. A narrowed scope needs a reason.
  let scope = existing && input.revision === undefined ? existing.criteria : undefined;
  let narrowedReason = existing && input.revision === undefined ? existing.narrowedReason : undefined;
  if (input.criteria !== undefined) {
    if (input.criteria === null) { scope = undefined; narrowedReason = undefined; }
    else {
      const checked = checkCriteriaScope(input.criteria, ids, pin.revision);
      if (!checked.ok) return fail(400, checked.error.replace(/context\.specSource\./g, 'outcomeSpec.'));
      if (typeof input.narrowedReason !== 'string' || input.narrowedReason.trim().length < 10) {
        return fail(400, 'outcomeSpec.narrowedReason (10+ characters: why the mission answers for only these criteria) is required with criteria');
      }
      scope = checked.criteria ?? undefined;
      narrowedReason = input.narrowedReason.trim();
    }
  }
  const inScope = new Set(scope ?? ids);

  // Waivers: a person's call, per criterion, with a reason. A repin drops them.
  let waived = existing && input.revision === undefined ? [...(existing.waived ?? [])] : [];
  if (input.waive !== undefined || input.unwaive !== undefined) {
    if (!person) return fail(403, 'Waiving a criterion is a person\'s decision');
  }
  if (input.waive !== undefined) {
    if (!Array.isArray(input.waive) || input.waive.length === 0) return fail(400, 'outcomeSpec.waive must list { criterionId, reason } entries');
    for (const w of input.waive as Array<Record<string, unknown>>) {
      if (typeof w?.criterionId !== 'string' || !inScope.has(w.criterionId)) return fail(400, `outcomeSpec.waive names ${String(w?.criterionId)}, not an in-scope criterion`);
      if (typeof w.reason !== 'string' || w.reason.trim().length < 10) return fail(400, `outcomeSpec.waive ${w.criterionId}: reason (10+ characters) is required`);
      waived = waived.filter((x) => x.criterionId !== w.criterionId);
      waived.push({ criterionId: w.criterionId, reason: (w.reason as string).trim(), by: `user:${person}`, at: now.toISOString() });
    }
  }
  if (input.unwaive !== undefined) {
    if (!Array.isArray(input.unwaive)) return fail(400, 'outcomeSpec.unwaive must list criterion ids');
    const drop = new Set(input.unwaive as string[]);
    waived = waived.filter((w) => !drop.has(w.criterionId));
  }
  waived = waived.filter((w) => inScope.has(w.criterionId)).sort((a, b) => a.criterionId.localeCompare(b.criterionId));

  const next: LivingSpecGoalCriterion = {
    type: 'living_spec',
    specId: input.specId,
    specRevisionId: pin.specRevisionId,
    revision: pin.revision,
    contentHash: pin.contentHash,
    ...(pin.provisional ? { provisional: true as const } : {}),
    ...(scope ? { criteria: scope, narrowedReason } : {}),
    ...(waived.length ? { waived } : {}),
    label: `Spec "${read.title}" revision ${pin.revision}`,
  };
  const merged = mergeSelection(stored, next);
  if (!merged.changed) return { ok: true, criterion: next, changed: false, goalCriteria: merged.criteria };
  if (merged.criteria.length > MAX_GOAL_CRITERIA) return fail(400, `A mission has at most ${MAX_GOAL_CRITERIA} goal criteria`);
  await db.update(missions).set({ goalCriteria: merged.criteria, updatedAt: now } as any).where(eq(missions.id, missionId));
  if (input.waive !== undefined || input.unwaive !== undefined) {
    await note(missionId, caller, 'Outcome spec criteria waived', waived.map((w) => `${w.criterionId}: ${w.reason}`).join('\n') || 'No criteria are waived now.');
  }
  return { ok: true, criterion: next, changed: true, goalCriteria: merged.criteria };
}

async function note(missionId: string, caller: SpecCaller, title: string, body: string) {
  await db.insert(missionNotes).values({
    missionId,
    authorType: caller.kind === 'user' ? 'user' : 'mcp',
    type: 'decision',
    title,
    body,
    actorLabel: caller.kind === 'user' ? `user:${caller.userId}` : `account:${caller.account.id}`,
  } as any);
}

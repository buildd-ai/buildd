import { db } from '@buildd/core/db';
import { artifactReads, githubRepos, missions, specOutcomeVerdicts, tasks, workspaces } from '@buildd/core/db/schema';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { missionIntegrationBase } from '@buildd/core/mission-integration';
import { isDeliverableTask } from '@buildd/core/mission-helpers';
import { VERIFICATION_VERDICTS, boundEvidenceRefs, type VerificationVerdict } from '@buildd/core/verification-check';
import type { LivingSpecGoalCriterion } from '@buildd/shared';
import type { RequirementRef } from '@buildd/spec-contract/requirements';
import { githubApi } from '@/lib/github';
import { encodeRef, isAncestor } from '@/lib/integration-refresh';
import { resolveMissionRepoWorkspaceId } from '@/lib/mission-repo-workspace';
import { requestingPerson } from '@/lib/request-person';
import { mergedDeliveryCommits } from '@/lib/workflow/delivery-view';
import { isUuid } from '@/lib/uuid';
import { livingSpecCriteriaOf, selectedScope } from './selected-scope';
import { foldMissionSpec, verdictIsCurrent, type MissionSpecFold, type MissionTarget, type MissionVerdictRow } from './mission-outcome-fold';
import { fail, reach, type SpecCaller, type SpecError } from './store';

/**
 * Mission-level verdicts on the mission's selected outcome spec (Living Specs
 * Slice 12, D-19/D-20, R-49..R-53). The governed outcome of one task (D-4,
 * ./outcome.ts) stays advisory; this is the one scoped exception: a mission
 * that explicitly selected an outcome spec completes only when every in-scope
 * criterion passes on its integrated target, through its `living_spec` goal
 * criterion and the existing completion gate (`canCompleteMission` refuses
 * unless every goal criterion passes).
 *
 * Who records a mission-level verdict: a person with write access to the
 * workspace, or the mission's final verification task (its own per-task
 * token, filed by the platform with a `finalVerification` marker). A builder,
 * fix, review-round or any other task token of the mission is refused: the
 * work never grades the integrated result it produced. Server-side recorders
 * (a criterion's `check:` line run at the target, the visual audit) write
 * through `recordMissionVerdictServer`, authored by the check.
 */

type Api = (installationId: number, path: string, options?: RequestInit) => Promise<any>;
const SHA = /^[0-9a-f]{7,40}$/i;
const MAX_READS = 20;

export type MissionRow = { id: string; workspaceId: string | null; workingBranch: string | null; integrationBranchEnabled: boolean | null; goalCriteria: unknown };

async function loadMission(missionId: string): Promise<MissionRow | null> {
  const m = await db.query.missions.findFirst({
    where: sqlWhere(eq(missions.id, missionId)),
    columns: { id: true, workspaceId: true, workingBranch: true, integrationBranchEnabled: true, goalCriteria: true },
  });
  return (m as MissionRow | undefined) ?? null;
}

export { livingSpecCriteriaOf, selectedScope };

async function missionRepo(mission: MissionRow): Promise<{ installationId: number; fullName: string } | { error: string }> {
  const resolved = await resolveMissionRepoWorkspaceId({ missionId: mission.id, missionWorkspaceId: mission.workspaceId });
  if (!resolved.workspaceId) return { error: resolved.detail ?? 'the mission has no workspace' };
  const ws = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, resolved.workspaceId)), columns: { githubRepoId: true } });
  if (!ws?.githubRepoId) return { error: 'the workspace is not linked to a GitHub repo' };
  const repo = await db.query.githubRepos.findFirst({
    where: sqlWhere(eq(githubRepos.id, ws.githubRepoId)),
    columns: { fullName: true },
    with: { installation: { columns: { installationId: true } } },
  });
  const installationId = (repo as { installation?: { installationId?: number } } | undefined)?.installation?.installationId;
  if (!repo?.fullName || !installationId) return { error: 'the GitHub repo row was not found' };
  return { installationId, fullName: repo.fullName };
}

/**
 * The mission's integrated target, as GitHub reports it now (never a runner's
 * word). mission-branch: the integration branch's head. direct: the merge
 * commits of every merged mission deliverable; a verdict's commit counts only
 * when it contains all of them (checked per candidate head in `candidateHeads`).
 * Unknown ancestry is never a pass.
 */
export async function resolveMissionTarget(mission: MissionRow, candidateHeads: readonly string[], api: Api = githubApi): Promise<MissionTarget> {
  const repo = await missionRepo(mission);
  if ('error' in repo) return { kind: 'unknown', reason: repo.error };
  const branch = missionIntegrationBase(mission);
  if (branch) {
    try {
      const ref = await api(repo.installationId, `/repos/${repo.fullName}/git/ref/heads/${encodeRef(branch)}`);
      const sha = typeof ref?.object?.sha === 'string' ? ref.object.sha : null;
      return sha ? { kind: 'integration', headSha: sha.toLowerCase(), branch } : { kind: 'unknown', reason: `the integration branch ${branch} could not be read` };
    } catch {
      return { kind: 'unknown', reason: `the integration branch ${branch} could not be read` };
    }
  }
  const missionTasks = await db.select({ id: tasks.id, taskClass: tasks.taskClass, kind: tasks.kind, title: tasks.title, mode: tasks.mode, creationSource: tasks.creationSource, category: tasks.category })
    .from(tasks).where(eq(tasks.missionId, mission.id));
  const deliverableIds = missionTasks.filter(isDeliverableTask).map((t) => t.id);
  let merged: Array<{ mergeCommitSha: string | null }>;
  try {
    merged = await mergedDeliveryCommits(deliverableIds);
  } catch {
    return { kind: 'unknown', reason: 'the mission\'s merged PRs could not be read' };
  }
  if (merged.some((m) => !m.mergeCommitSha)) return { kind: 'unknown', reason: 'a merged mission PR has no recorded merge commit' };
  const mergeShas = [...new Set(merged.map((m) => (m.mergeCommitSha as string).toLowerCase()))];
  if (mergeShas.length === 0) return { kind: 'unknown', reason: 'no mission PR has merged yet' };
  const validHeads = new Set<string>();
  for (const head of new Set(candidateHeads.map((h) => h.toLowerCase()))) {
    let all = true;
    for (const m of mergeShas) {
      if ((await isAncestor(repo.installationId, repo.fullName, m, head, api)) !== true) { all = false; break; }
    }
    if (all) validHeads.add(head);
  }
  return { kind: 'direct', mergeShas, validHeads };
}

async function missionRows(missionId: string, specRevisionId: string): Promise<MissionVerdictRow[]> {
  const rows = await db.select({ id: specOutcomeVerdicts.id, criterionId: specOutcomeVerdicts.criterionId, verdict: specOutcomeVerdicts.verdict, headSha: specOutcomeVerdicts.headSha, at: specOutcomeVerdicts.createdAt })
    .from(specOutcomeVerdicts)
    .where(and(eq(specOutcomeVerdicts.missionId, missionId), eq(specOutcomeVerdicts.specRevisionId, specRevisionId)))
    .orderBy(asc(specOutcomeVerdicts.createdAt));
  return rows as MissionVerdictRow[];
}

export type MissionSpecStanding = MissionSpecFold & { target: MissionTarget; scope: RequirementRef[]; title: string };

/** Fold one `living_spec` criterion against its mission-level verdicts and the target as it is now. */
export async function readMissionSpecStanding(mission: MissionRow, c: LivingSpecGoalCriterion, api: Api = githubApi): Promise<MissionSpecStanding> {
  const scope = await selectedScope(c);
  if (!scope.ok) {
    return { verdict: 'UNVERIFIED', evidence: `The selected spec revision is unavailable: ${scope.reason}`, targetSha: null, standings: [], target: { kind: 'unknown', reason: scope.reason }, scope: [], title: '' };
  }
  const rows = await missionRows(mission.id, c.specRevisionId);
  const target = await resolveMissionTarget(mission, rows.map((r) => r.headSha).filter((h): h is string => !!h), api);
  const folded = foldMissionSpec({ scope: scope.criteria.map((r) => r.id), waived: (c.waived ?? []).map((w) => w.criterionId), rows, target });
  return { ...folded, target, scope: scope.criteria, title: scope.title };
}

/**
 * Who may record a mission-level verdict (pure, so the rule is tested
 * without a database): a person, or the mission's own final verification task.
 */
export function missionVerdictAuthority(input: {
  personId: string | null;
  taskScoped: boolean;
  /** The calling token's own task, when it is a task token. */
  ownTask?: { missionId: string | null; context: unknown } | null;
  missionId: string;
}): { ok: true; recordedBy: string } | { ok: false; reason: string } {
  if (input.personId && !input.taskScoped) return { ok: true, recordedBy: `user:${input.personId}` };
  if (input.taskScoped && input.ownTask && input.ownTask.missionId === input.missionId) {
    const marker = (input.ownTask.context as Record<string, unknown> | null)?.finalVerification as { missionId?: unknown } | undefined;
    if (marker && marker.missionId === input.missionId) return { ok: true, recordedBy: 'final-verification' };
  }
  return { ok: false, reason: 'A mission-level verdict is recorded by a person or by the mission\'s final verification task. Builder, fix and review work never grades the integrated result it produced.' };
}

/**
 * Record one mission-level verdict on one in-scope criterion of the mission's
 * selected outcome spec, at the mission's current integrated target.
 */
export async function recordMissionSpecVerdict(caller: SpecCaller, missionId: unknown, input: {
  specId?: unknown; criterionId: unknown; verdict: unknown; headSha: unknown; evidenceRefs?: unknown; readIds?: unknown; observed?: unknown; reaffirms?: unknown;
}, api: Api = githubApi): Promise<{ ok: true; verdictId: string; standing: MissionSpecStanding } | SpecError> {
  if (typeof missionId !== 'string' || !isUuid(missionId)) return fail(404, 'Mission not found');
  const mission = await loadMission(missionId);
  if (!mission?.workspaceId || !(await reach(caller, mission.workspaceId, false))) return fail(404, 'Mission not found');
  const writable = await reach(caller, mission.workspaceId, true);

  const taskScope = caller.kind === 'account' ? (caller.account.taskScope as { taskId?: string } | undefined) : undefined;
  let ownTask: { missionId: string | null; context: unknown } | null = null;
  if (taskScope?.taskId && isUuid(taskScope.taskId)) {
    const [t] = await db.select({ missionId: tasks.missionId, context: tasks.context }).from(tasks).where(eq(tasks.id, taskScope.taskId)).limit(1);
    ownTask = t ?? null;
  }
  const personId = caller.kind === 'user' ? caller.userId : requestingPerson(null, caller.account);
  const who = missionVerdictAuthority({ personId: writable ? personId : null, taskScoped: !!taskScope, ownTask, missionId });
  if (!who.ok) return fail(403, who.reason);

  const selected = livingSpecCriteriaOf(mission.goalCriteria);
  const c = typeof input.specId === 'string' ? selected.find((s) => s.specId === input.specId) : selected.length === 1 ? selected[0] : undefined;
  if (!c) {
    return fail(409, selected.length === 0
      ? 'This mission has no selected outcome spec, so it has no mission-level verdicts to record'
      : 'This mission selected more than one outcome spec: pass specId to say which');
  }
  const scope = await selectedScope(c);
  if (!scope.ok) return fail(409, `The selected spec revision is unavailable: ${scope.reason}`);
  const { criterionId, verdict, headSha } = input;
  const ids = scope.criteria.map((r) => r.id);
  if (typeof criterionId !== 'string' || !ids.includes(criterionId)) {
    return fail(400, `criterionId must be an in-scope criterion of selected revision ${c.revision}: ${ids.length ? ids.join(', ') : 'it has none'}`);
  }
  if (typeof verdict !== 'string' || !(VERIFICATION_VERDICTS as readonly string[]).includes(verdict)) {
    return fail(400, `verdict must be one of: ${VERIFICATION_VERDICTS.join(', ')}`);
  }
  if (typeof headSha !== 'string' || !SHA.test(headSha)) return fail(400, 'headSha (the integrated commit the verdict judged) is required');
  const target = await resolveMissionTarget(mission, [headSha], api);
  if (target.kind === 'unknown') return fail(409, `No integrated target to verify against: ${target.reason}`);
  if (!verdictIsCurrent(target, headSha)) {
    return fail(409, target.kind === 'integration'
      ? `headSha is not the integration branch's current head (${target.headSha.slice(0, 7)}): verify the integrated result as it is now`
      : 'headSha does not contain every merged mission PR: verify a commit that holds all of them');
  }

  let readIds: string[] = [];
  if (input.readIds !== undefined) {
    if (!Array.isArray(input.readIds) || input.readIds.length > MAX_READS || !input.readIds.every((id) => typeof id === 'string' && isUuid(id))) {
      return fail(400, `readIds must be at most ${MAX_READS} artifact read ids`);
    }
    readIds = [...new Set(input.readIds as string[])];
    if (readIds.length > 0) {
      const found = await db.select({ id: artifactReads.id }).from(artifactReads)
        .where(and(inArray(artifactReads.id, readIds), eq(artifactReads.workspaceId, mission.workspaceId)));
      if (found.length !== readIds.length) return fail(400, 'readIds must name reads recorded in this workspace');
    }
  }
  const refs = boundEvidenceRefs(input.evidenceRefs);
  // A pass at a new target for a criterion the change did not touch must say
  // so explicitly, citing the earlier verdict it re-affirms: nothing carries silently.
  const reaffirms = typeof input.reaffirms === 'string' && isUuid(input.reaffirms) ? input.reaffirms : undefined;
  const observed = typeof input.observed === 'string' && input.observed.trim() ? input.observed.trim().slice(0, 500) : undefined;
  const recordedBy = who.recordedBy === 'final-verification' ? `final-verification:${taskScope!.taskId}` : who.recordedBy;
  const [row] = await db.insert(specOutcomeVerdicts).values({
    workspaceId: mission.workspaceId,
    missionId: mission.id,
    specRevisionId: c.specRevisionId,
    criterionId,
    verdict: verdict as VerificationVerdict,
    headSha: headSha.toLowerCase(),
    evidence: { refs, readIds, ...(observed ? { observed } : {}), ...(reaffirms ? { reaffirms } : {}), recordedBy },
  }).returning({ id: specOutcomeVerdicts.id });
  return { ok: true, verdictId: row.id, standing: await readMissionSpecStanding(mission, c, api) };
}

/**
 * Server-side mission-level verdict: a `check:` line run at the integrated
 * target, or the visual audit's binding. No caller; authored by the check.
 * Refused unless the criterion is in scope and the commit is current.
 */
export async function recordMissionVerdictServer(missionId: string, input: {
  specRevisionId: string; criterionId: string; verdict: VerificationVerdict; headSha: string; recordedBy: string; evidence: Record<string, unknown>;
}, api: Api = githubApi): Promise<{ ok: true; verdictId: string } | SpecError> {
  const mission = await loadMission(missionId);
  if (!mission?.workspaceId) return fail(404, 'Mission not found');
  const c = livingSpecCriteriaOf(mission.goalCriteria).find((s) => s.specRevisionId === input.specRevisionId);
  if (!c) return fail(409, 'The mission no longer selects this spec revision');
  const scope = await selectedScope(c);
  if (!scope.ok) return fail(409, scope.reason);
  if (!scope.criteria.some((r) => r.id === input.criterionId)) return fail(400, `${input.criterionId} is not in the selected scope`);
  if (!SHA.test(input.headSha)) return fail(400, 'headSha must be a commit SHA');
  const target = await resolveMissionTarget(mission, [input.headSha], api);
  if (!verdictIsCurrent(target, input.headSha)) return fail(409, 'The commit is not the mission\'s current integrated target');
  const [row] = await db.insert(specOutcomeVerdicts).values({
    workspaceId: mission.workspaceId,
    missionId: mission.id,
    specRevisionId: c.specRevisionId,
    criterionId: input.criterionId,
    verdict: input.verdict,
    headSha: input.headSha.toLowerCase(),
    evidence: { ...input.evidence, recordedBy: input.recordedBy },
  }).returning({ id: specOutcomeVerdicts.id });
  return { ok: true, verdictId: row.id };
}

/** Read every selected outcome spec's standing on a mission. `caller` null = server-side. */
export async function readMissionSpecOutcomes(caller: SpecCaller | null, missionId: unknown, api: Api = githubApi): Promise<{ ok: true; outcomes: Array<{ criterion: LivingSpecGoalCriterion; standing: MissionSpecStanding }> } | SpecError> {
  if (typeof missionId !== 'string' || !isUuid(missionId)) return fail(404, 'Mission not found');
  const mission = await loadMission(missionId);
  if (!mission?.workspaceId || (caller && !(await reach(caller, mission.workspaceId, false)))) return fail(404, 'Mission not found');
  const outcomes = [];
  for (const c of livingSpecCriteriaOf(mission.goalCriteria)) outcomes.push({ criterion: c, standing: await readMissionSpecStanding(mission, c, api) });
  return { ok: true, outcomes };
}


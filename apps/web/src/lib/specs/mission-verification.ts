import { db } from '@buildd/core/db';
import { missions, tasks, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { missionIntegrationBase } from '@buildd/core/mission-integration';
import { criterionFingerprint, isStandardCriterion } from '@buildd/core/mission-helpers';
import { TERMINAL_TASK_STATUSES, type LivingSpecGoalCriterion } from '@buildd/shared';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { pickEffectiveRole } from '@/lib/effective-roles';
import type { MissionSpecStanding } from './mission-outcome';
import { renderBuilderClaims } from './builder-claims';
import { loadBuilderClaims } from './builder-claims-store';
import { cleanUpSupersededFailures, describeCleanup } from './mission-cleanup';

/**
 * The mission's final requirement verification (Living Specs Slice 12,
 * R-51/R-52): one independent task that checks every in-scope criterion of
 * the selected outcome spec on the integrated target and records a
 * mission-level verdict per criterion.
 *
 * Bookkeeping (`taskClass: 'bookkeeping'`, `deliverableRole` verification):
 * outside every build count, and never a deliverable the mission waits on, so
 * it cannot block the completion it gates. It runs where the mission runs: a
 * local-executor mission's tasks are claimed only from a person's session, so
 * this spends no background runner budget there.
 *
 * Deduped by its marker (mission, criterion fingerprint, target commit): a new
 * integrated commit or a changed selection gets a new verification, the same
 * one never gets two.
 *
 * Before one is filed, failed tasks a completed replacement already did are
 * cancelled and their dependents re-pointed (./mission-cleanup.ts, R-4), so
 * repairs are not filed for work that landed. The verifier is given what the
 * builders claimed (./builder-claims.ts, R-2) to confirm or contradict, and
 * judges the tasks together against the spec, not only each criterion.
 */

export interface FinalVerificationContext {
  missionId: string;
  specId: string;
  specRevisionId: string;
  fingerprint: string;
  targetSha: string | null;
  /** `targetKey`: what makes two verifications about the same integrated result. */
  targetKey: string | null;
}

export const FINAL_VERIFICATION_PREFIX = '[final verification]';

/**
 * Which integrated target a verification is about, as a stable key. On a
 * mission-branch mission, the integration head. On a direct mission, the set
 * of merged mission PRs it must contain: a new merge is a new target, an
 * unrelated trunk commit is not.
 */
export function targetKey(target: MissionSpecStanding['target']): string | null {
  if (target.kind === 'integration') return `head:${target.headSha}`;
  if (target.kind === 'direct') return `merges:${[...target.mergeShas].sort().join(',')}`;
  return null;
}

/** Attempts per target before buildd stops re-filing a verification that keeps ending without a verdict. */
export const MAX_ATTEMPTS_PER_TARGET = 2;

type Prior = { id: string; status: string; targetKey: string | null };

/**
 * Pure: reuse an open or already-finished verification of this target, or file
 * one. A completed run at the same target is never repeated (an inconclusive
 * verdict waits for a person or a new commit); a run that failed or was
 * cancelled is retried once.
 *
 * `open` is a verification still running; `done` is one that finished at this
 * target (or the attempts at it are spent), reused so nothing is re-filed. The
 * two are not the same answer: a caller that reads `done` as "in flight" keeps
 * a criterion PENDING for good (df808193).
 */
export function decideFinalVerification(prior: readonly Prior[], key: string | null): { kind: 'open' | 'done'; taskId: string } | { kind: 'file' } {
  const live = prior.find((r) => !(TERMINAL_TASK_STATUSES as readonly string[]).includes(r.status));
  if (live) return { kind: 'open', taskId: live.id };
  if (key === null) return { kind: 'file' };
  const same = prior.filter((r) => r.targetKey === key);
  const done = same.find((r) => r.status === 'completed');
  if (done) return { kind: 'done', taskId: done.id };
  if (same.length >= MAX_ATTEMPTS_PER_TARGET) return { kind: 'done', taskId: same[0].id };
  return { kind: 'file' };
}

async function findPrior(missionId: string, fingerprint: string): Promise<Prior[]> {
  const rows = await db.query.tasks.findMany({
    where: sqlWhere(and(
      eq(tasks.missionId, missionId),
      sql`${tasks.context}->'finalVerification'->>'fingerprint' = ${fingerprint}`,
    )),
    columns: { id: true, status: true, context: true },
    orderBy: sqlOrderBy([desc(tasks.createdAt)]),
    limit: 10,
  });
  return rows.flatMap((r) => {
    const marker = (r.context as { finalVerification?: unknown } | null)?.finalVerification as Partial<FinalVerificationContext> | undefined;
    if (!marker || marker.missionId !== missionId) return [];
    return [{ id: r.id, status: r.status, targetKey: typeof marker.targetKey === 'string' ? marker.targetKey : null }];
  });
}

export type FinalVerification =
  | {
    /** `open`: running now. `dispatched`: filed now. `done`: finished at this target, nothing in flight. */
    kind: 'open' | 'dispatched' | 'done';
    taskId: string;
    /** Check runs that had finished without a recorded verdict and were settled now: the fold has moved, read it again. */
    settled?: number;
  }
  | { kind: 'unavailable'; reason: string };

export async function ensureFinalVerification(missionId: string, criterion: LivingSpecGoalCriterion, standing: MissionSpecStanding): Promise<FinalVerification> {
  const fingerprint = criterionFingerprint(criterion);
  const targetSha = standing.target.kind === 'integration' ? standing.target.headSha : null;
  const key = targetKey(standing.target);
  const decision = decideFinalVerification(await findPrior(missionId, fingerprint), key);
  if (decision.kind === 'open' || decision.kind === 'done') {
    const checks = await (await import('./mission-acceptance-checks')).runFinalAcceptanceChecks(decision.taskId, missionId);
    return { ...decision, settled: checks?.settled ?? 0 };
  }

  const mission = await db.query.missions.findFirst({
    where: sqlWhere(eq(missions.id, missionId)),
    columns: { id: true, title: true, workspaceId: true, workingBranch: true, integrationBranchEnabled: true },
  });
  if (!mission?.workspaceId) return { kind: 'unavailable', reason: 'the mission has no workspace to verify in' };
  const workspace = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, mission.workspaceId)) });
  if (!workspace) return { kind: 'unavailable', reason: 'workspace not found' };

  // Cleanup first: the claims below then read the cancelled tasks as superseded.
  const cleanup = await cleanUpSupersededFailures(missionId, mission.workspaceId, 'system:final-verification')
    .catch((err) => { console.error(`[final-verification] cleanup for mission ${missionId} failed:`, err instanceof Error ? err.message : err); return null; });
  const cleanedUp = cleanup ? describeCleanup(cleanup) : [];
  const claims = renderBuilderClaims(await loadBuilderClaims(missionId));

  const marker: FinalVerificationContext = { missionId, specId: criterion.specId, specRevisionId: criterion.specRevisionId, fingerprint, targetSha, targetKey: key };
  const roleSlug = await pickEffectiveRole(mission.workspaceId, ['reviewer', 'researcher']);
  const base = missionIntegrationBase(mission);
  const open = standing.standings.filter((s) => s.standing !== 'pass' && s.standing !== 'waived');
  const standard = isStandardCriterion(criterion);
  const title = `${FINAL_VERIFICATION_PREFIX} ${standard ? 'standard ' : ''}${standing.title || (standard ? 'spec' : 'outcome spec')} revision ${criterion.revision}`;
  const description = [
    `## Final requirement verification`,
    ``,
    `Mission: **${mission.title}**. Check the integrated result against spec revision ${criterion.revision}${criterion.provisional ? ' (provisional: not approved yet)' : ''}, not any one PR.`,
    ...(standard ? [`This spec is a standard of the workspace: its criteria apply to every change, so judge the whole of the mission's change against each.`] : []),
    targetSha ? `Integrated target: \`${base}\` at \`${targetSha}\`. Check out exactly that commit.` : `Integrated target: a commit on trunk that contains every merged mission PR. Use the newest trunk commit and record its full SHA.`,
    ``,
    `In scope (${standing.scope.length}):`,
    ...standing.scope.map((c) => `- **${c.id}**: ${c.text}`),
    ...(criterion.waived?.length ? [``, `Waived by a person (do not record): ${criterion.waived.map((w) => w.criterionId).join(', ')}.`] : []),
    ``,
    `Still open: ${open.length ? open.map((s) => `${s.criterionId} (${s.standing})`).join(', ') : 'none'}.`,
    ``,
    ...(cleanedUp.length ? [``, `Before this verification, failed tasks a completed replacement already did were cleaned up:`, ...cleanedUp] : []),
    ...(claims.length ? [``, ...claims] : []),
    ``,
    `## Recording verdicts`,
    ``,
    `One runner-owned check run, with no agent, runs every acceptance command at the integrated commit and records each test verdict from its exit code. For each in-scope criterion, read the code, inspect its \`check:\` line where it has one, and record one verdict at the target:`,
    `\`manage_specs action=verdict { missionId: "${missionId}", specId: "${criterion.specId}", criterionId, verdict: pass|fail|inconclusive|unsupported, headSha: <target>, evidenceRefs, observed }\`.`,
    `For a criterion whose acceptance test you ran at the target, pass the run instead of a verdict: \`acceptanceTest: { exitCode, testName, stdout, stderr }\`. The exit code decides the result (0 pass, any other code fail, a run that never started inconclusive) and the row is recorded as a test, which outranks any reviewer on the same commit.`,
    `A criterion that passed on an earlier target and that the new commits did not touch is re-affirmed explicitly: record a new verdict at the target with \`reaffirms: <earlier verdict id>\` and say which diff you read. Nothing carries over on its own.`,
    `On a fail, file one \`[spec repair] <criterion>: <what is wrong>\` task in this mission with \`context.specRepair: { missionId: "${missionId}", specId: "${criterion.specId}", criterionId }\`. Do not fix it yourself: this task only verifies.`,
    `A repair with the same root cause as another open repair, or that needs another task to merge first, is filed with \`dependsOn\` on that task. A repair that finds this out mid-run waits on it with \`complete_task { blockedOnTaskId, summary }\`; it does not fail.`,
    `Finish with a report artifact mapping each criterion to its verdict and evidence. PR reviews and visual evidence may inform a verdict; they never replace it.`,
  ].join('\n');

  const context = { finalVerification: marker, ...(base ? { baseBranch: base } : {}), retryCount: 1 };
  // decideFinalVerification re-checked in the insert itself, under a lock per
  // mission: two evaluations racing on one target used to both
  // read "no prior" and each file a verification (and so each a check set).
  // The loser inserts nothing and reuses the winner's task below.
  // A verification of the same revision that is still open covers this one too, whatever its fingerprint.
  const same = sql`t_fv.mission_id = ${missionId}::uuid AND (t_fv.context->'finalVerification'->>'fingerprint' = ${fingerprint} OR t_fv.context->'finalVerification'->>'specRevisionId' = ${criterion.specRevisionId})`;
  const terminal = sql.join(TERMINAL_TASK_STATUSES.map((s) => sql`${s}`), sql`, `);
  const [, inserted] = await db.batch([
    db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('final_verification'), hashtext(${missionId}))`),
    db.execute(sql`
      INSERT INTO ${tasks} (workspace_id, title, description, priority, status, mode, kind, task_class, creation_source, mission_id, role_slug, output_requirement, context)
      SELECT ${mission.workspaceId}::uuid, ${title}, ${description}, 3, 'pending', 'execution', 'analysis', 'bookkeeping', 'orchestrator', ${missionId}::uuid, ${roleSlug ?? null}, 'artifact_required', ${JSON.stringify(context)}::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM ${tasks} t_fv WHERE ${same} AND t_fv.status NOT IN (${terminal}))
      AND (${key}::text IS NULL OR (
        NOT EXISTS (SELECT 1 FROM ${tasks} t_fv WHERE ${same} AND t_fv.context->'finalVerification'->>'targetKey' = ${key} AND t_fv.status = 'completed')
        AND (SELECT count(*) FROM ${tasks} t_fv WHERE ${same} AND t_fv.context->'finalVerification'->>'targetKey' = ${key}) < ${MAX_ATTEMPTS_PER_TARGET}
      ))
      RETURNING id
    `),
  ]);
  const task = (inserted as { rows?: Array<Record<string, unknown>> })?.rows?.[0] as { id: string } | undefined;
  if (!task) {
    const reuse = decideFinalVerification(await findPrior(missionId, fingerprint), key);
    if (reuse.kind === 'file') return { kind: 'unavailable', reason: 'the verification task could not be filed' };
    const checks = await (await import('./mission-acceptance-checks')).runFinalAcceptanceChecks(reuse.taskId, missionId);
    return { ...reuse, settled: checks?.settled ?? 0 };
  }
  const checks = await (await import('./mission-acceptance-checks')).runFinalAcceptanceChecks(task.id, missionId);
  await announceTaskCreated(
    { id: task.id, title, description: null, workspaceId: mission.workspaceId, mode: 'execution', priority: 3, missionId },
    workspace as any,
  ).catch((e) => console.error(`[final-verification] dispatch failed for task ${task.id}:`, e));
  await wakeTask(task.id, 'task.created');
  return { kind: 'dispatched', taskId: task.id, settled: checks?.settled ?? 0 };
}

import { db } from '@buildd/core/db';
import { missions, tasks, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { missionIntegrationBase } from '@buildd/core/mission-integration';
import { criterionFingerprint } from '@buildd/core/mission-helpers';
import { TERMINAL_TASK_STATUSES, type LivingSpecGoalCriterion } from '@buildd/shared';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { pickEffectiveRole } from '@/lib/effective-roles';
import type { MissionSpecStanding } from './mission-outcome';

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
 */
export function decideFinalVerification(prior: readonly Prior[], key: string | null): { kind: 'open'; taskId: string } | { kind: 'file' } {
  const live = prior.find((r) => !(TERMINAL_TASK_STATUSES as readonly string[]).includes(r.status));
  if (live) return { kind: 'open', taskId: live.id };
  if (key === null) return { kind: 'file' };
  const same = prior.filter((r) => r.targetKey === key);
  const done = same.find((r) => r.status === 'completed');
  if (done) return { kind: 'open', taskId: done.id };
  if (same.length >= MAX_ATTEMPTS_PER_TARGET) return { kind: 'open', taskId: same[0].id };
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

export type FinalVerification = { kind: 'open' | 'dispatched'; taskId: string } | { kind: 'unavailable'; reason: string };

export async function ensureFinalVerification(missionId: string, criterion: LivingSpecGoalCriterion, standing: MissionSpecStanding): Promise<FinalVerification> {
  const fingerprint = criterionFingerprint(criterion);
  const targetSha = standing.target.kind === 'integration' ? standing.target.headSha : null;
  const key = targetKey(standing.target);
  const decision = decideFinalVerification(await findPrior(missionId, fingerprint), key);
  if (decision.kind === 'open') return decision;

  const mission = await db.query.missions.findFirst({
    where: sqlWhere(eq(missions.id, missionId)),
    columns: { id: true, title: true, workspaceId: true, workingBranch: true, integrationBranchEnabled: true },
  });
  if (!mission?.workspaceId) return { kind: 'unavailable', reason: 'the mission has no workspace to verify in' };
  const workspace = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, mission.workspaceId)) });
  if (!workspace) return { kind: 'unavailable', reason: 'workspace not found' };

  const marker: FinalVerificationContext = { missionId, specId: criterion.specId, specRevisionId: criterion.specRevisionId, fingerprint, targetSha, targetKey: key };
  const roleSlug = await pickEffectiveRole(mission.workspaceId, ['reviewer', 'researcher']);
  const base = missionIntegrationBase(mission);
  const open = standing.standings.filter((s) => s.standing !== 'pass' && s.standing !== 'waived');
  const title = `${FINAL_VERIFICATION_PREFIX} ${standing.title || 'outcome spec'} revision ${criterion.revision}`;
  const description = [
    `## Final requirement verification`,
    ``,
    `Mission: **${mission.title}**. Check the integrated result against spec revision ${criterion.revision}${criterion.provisional ? ' (provisional: not approved yet)' : ''}, not any one PR.`,
    targetSha ? `Integrated target: \`${base}\` at \`${targetSha}\`. Check out exactly that commit.` : `Integrated target: a commit on trunk that contains every merged mission PR. Use the newest trunk commit and record its full SHA.`,
    ``,
    `In scope (${standing.scope.length}):`,
    ...standing.scope.map((c) => `- **${c.id}**: ${c.text}`),
    ...(criterion.waived?.length ? [``, `Waived by a person (do not record): ${criterion.waived.map((w) => w.criterionId).join(', ')}.`] : []),
    ``,
    `Still open: ${open.length ? open.map((s) => `${s.criterionId} (${s.standing})`).join(', ') : 'none'}.`,
    ``,
    `For each in-scope criterion, read the code, run its \`check:\` line where it has one, and record one verdict at the target:`,
    `\`manage_specs action=verdict { missionId: "${missionId}", criterionId, verdict: pass|fail|inconclusive|unsupported, headSha: <target>, evidenceRefs, observed }\`.`,
    `A criterion that passed on an earlier target and that the new commits did not touch is re-affirmed explicitly: record a new verdict at the target with \`reaffirms: <earlier verdict id>\` and say which diff you read. Nothing carries over on its own.`,
    `On a fail, file one \`[spec repair] <criterion>: <what is wrong>\` task in this mission with \`context.specRepair: { missionId, criterionId }\`. Do not fix it yourself: this task only verifies.`,
    `Finish with a report artifact mapping each criterion to its verdict and evidence. PR reviews and visual evidence may inform a verdict; they never replace it.`,
  ].join('\n');

  const [task] = await db.insert(tasks).values({
    workspaceId: mission.workspaceId,
    title,
    description,
    priority: 3,
    status: 'pending',
    mode: 'execution',
    kind: 'analysis',
    taskClass: 'bookkeeping',
    creationSource: 'orchestrator',
    missionId,
    roleSlug,
    outputRequirement: 'artifact_required',
    context: {
      finalVerification: marker,
      ...(base ? { baseBranch: base } : {}),
      retryCount: 1,
    },
  } as any).returning({ id: tasks.id });
  if (!task) return { kind: 'unavailable', reason: 'the verification task could not be filed' };
  await announceTaskCreated(
    { id: task.id, title, description: null, workspaceId: mission.workspaceId, mode: 'execution', priority: 3, missionId },
    workspace as any,
  ).catch((e) => console.error(`[final-verification] dispatch failed for task ${task.id}:`, e));
  await wakeTask(task.id, 'task.created');
  return { kind: 'dispatched', taskId: task.id };
}

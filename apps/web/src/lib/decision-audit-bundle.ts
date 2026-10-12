/**
 * What an auditor needs to judge one decision (GET /api/decisions/[id], MCP
 * get_decision): the question, the answers on offer, the rule's answer, the
 * model's answer, the answer in effect, and the subject's later evidence (the
 * task's role and status now, its PR and where that PR ended, its mission).
 *
 * The ledger keeps a fingerprint of the inputs, not the inputs, so the exact
 * candidate set the model saw is not stored. `options` gives what can be read
 * instead: the answers this feature has given on the team recently and, for
 * role routing, the roles the workspace offers now with their "when to use".
 */
import { and, desc, eq, gte, inArray, isNotNull, or } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { decisionOutcomes, decisionRecords, missions, tasks, workers, workspaceSkills, type DecisionRecord } from '@buildd/core/db/schema';
import { INFERENCE_CAPABILITIES, type InferenceCapability } from '@buildd/core/inference-policy';
import { fallbackReasonKey, fallbackSentence } from '@buildd/core/decision-feature-health';

const ANSWERS_SEEN_DAYS = 30;
const ANSWERS_SEEN_MAX = 25;
const ROLES_MAX = 20;

export function decisionQuestion(capability: string): { feature: string; asks: string | null } {
  const def = (INFERENCE_CAPABILITIES as Record<string, { label: string; description: string } | undefined>)[capability as InferenceCapability];
  return def ? { feature: def.label, asks: def.description } : { feature: capability, asks: null };
}

export function decisionAnswers(r: Pick<DecisionRecord, 'status' | 'applied' | 'reason' | 'ruleAnswer' | 'verdict' | 'confidence' | 'minConfidence' | 'appliedAnswer'>) {
  const reasonKey = r.reason ? fallbackReasonKey(r.reason) : null;
  return {
    rule: r.ruleAnswer,
    model: r.verdict,
    confidence: r.confidence,
    threshold: r.minConfidence,
    inEffect: r.appliedAnswer,
    acted: r.applied,
    status: r.status,
    reason: r.reason,
    // Plain words only for a fallback; a suggested row's reason is a gate code, not a failure.
    reasonSentence: r.status === 'fallback' && reasonKey ? fallbackSentence(reasonKey) : null,
    /** What label_decision's `label` grades: the model's answer, or the answer in effect when it gave none. */
    graded: r.verdict !== null ? 'model' as const : 'in_effect' as const,
  };
}

async function answersSeen(r: DecisionRecord): Promise<string[]> {
  const since = new Date(Date.now() - ANSWERS_SEEN_DAYS * 86_400_000);
  const rows = await db.select({ rule: decisionRecords.ruleAnswer, model: decisionRecords.verdict, inEffect: decisionRecords.appliedAnswer })
    .from(decisionRecords)
    .where(and(
      eq(decisionRecords.teamId, r.teamId),
      eq(decisionRecords.capability, r.capability),
      gte(decisionRecords.createdAt, since),
      or(isNotNull(decisionRecords.verdict), isNotNull(decisionRecords.ruleAnswer), isNotNull(decisionRecords.appliedAnswer)),
    ))
    .orderBy(desc(decisionRecords.createdAt))
    .limit(500);
  const seen = new Set<string>();
  for (const x of rows) for (const v of [x.rule, x.model, x.inEffect]) if (v && seen.size < ANSWERS_SEEN_MAX) seen.add(v);
  return [...seen].sort();
}

async function workspaceRoles(workspaceId: string) {
  const rows = await db.select({ slug: workspaceSkills.slug, name: workspaceSkills.name, metadata: workspaceSkills.metadata })
    .from(workspaceSkills)
    .where(and(eq(workspaceSkills.workspaceId, workspaceId), eq(workspaceSkills.isRole, true), eq(workspaceSkills.enabled, true)))
    .limit(ROLES_MAX);
  return rows.map(r => {
    const routing = (r.metadata as { routing?: { whenToUse?: unknown } } | null)?.routing;
    return { slug: r.slug, name: r.name, whenToUse: typeof routing?.whenToUse === 'string' ? routing.whenToUse : null };
  });
}

async function taskEvidence(taskId: string, teamWorkspaceId: string | null) {
  const [task] = await db.select({
    id: tasks.id, title: tasks.title, status: tasks.status, kind: tasks.kind, roleSlug: tasks.roleSlug,
    missionId: tasks.missionId, workspaceId: tasks.workspaceId, context: tasks.context,
  }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  // The task must sit in the decision's own workspace when the decision names one.
  if (!task || (teamWorkspaceId && task.workspaceId !== teamWorkspaceId)) return null;
  const prs = await db.select({ prUrl: workers.prUrl, prNumber: workers.prNumber, prStatus: workers.prLifecycleStatus, workerStatus: workers.status })
    .from(workers).where(and(eq(workers.taskId, taskId), isNotNull(workers.prNumber))).limit(5);
  const roleInferred = (task.context as Record<string, unknown> | null)?.roleInferred ?? null;
  return {
    id: task.id, title: task.title, status: task.status, kind: task.kind, roleNow: task.roleSlug, roleInferred,
    missionId: task.missionId, workspaceId: task.workspaceId, href: `/app/tasks/${task.id}`,
    prs: prs.map(p => ({ url: p.prUrl, number: p.prNumber, status: p.prStatus })),
  };
}

async function missionEvidence(missionId: string, workspaceId: string | null) {
  const [m] = await db.select({ id: missions.id, title: missions.title, status: missions.status, workspaceId: missions.workspaceId })
    .from(missions).where(eq(missions.id, missionId)).limit(1);
  if (!m || (workspaceId && m.workspaceId !== workspaceId)) return null;
  return { id: m.id, title: m.title, status: m.status, href: `/app/missions/${m.id}` };
}

export async function loadDecisionAuditBundle(r: DecisionRecord) {
  const subjectTaskId = r.subjectType === 'task' && r.subjectId ? r.subjectId : r.taskId;
  const subjectMissionId = r.subjectType === 'mission' && r.subjectId ? r.subjectId : r.missionId;
  const [seen, roles, task, mission, outcomes] = await Promise.all([
    answersSeen(r),
    r.capability.startsWith('task_role') && r.workspaceId ? workspaceRoles(r.workspaceId) : Promise.resolve(null),
    subjectTaskId ? taskEvidence(subjectTaskId, r.workspaceId) : Promise.resolve(null),
    subjectMissionId ? missionEvidence(subjectMissionId, r.workspaceId) : Promise.resolve(null),
    db.select({ source: decisionOutcomes.source, label: decisionOutcomes.label, value: decisionOutcomes.value, metadata: decisionOutcomes.metadata, observedAt: decisionOutcomes.observedAt })
      .from(decisionOutcomes)
      .where(and(eq(decisionOutcomes.teamId, r.teamId), inArray(decisionOutcomes.decisionRecordId, [r.id]))),
  ]);
  return {
    decision: {
      id: r.id, capability: r.capability, createdAt: r.createdAt, workspaceId: r.workspaceId,
      model: r.model, provider: r.provider, promptVersion: r.promptVersion, latencyMs: r.latencyMs, costUsd: r.costUsd,
      humanOverride: r.humanOverride, overriddenAt: r.overriddenAt,
    },
    question: decisionQuestion(r.capability),
    answers: decisionAnswers(r),
    options: {
      note: 'The exact candidates the model saw are not stored; these are what can be read now.',
      answersSeen: seen,
      ...(roles ? { roles } : {}),
    },
    subject: {
      type: r.subjectType ?? (subjectTaskId ? 'task' : subjectMissionId ? 'mission' : null),
      id: r.subjectId ?? subjectTaskId ?? subjectMissionId ?? null,
      task,
      mission,
    },
    outcomes,
  };
}

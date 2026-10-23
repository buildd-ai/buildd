/**
 * The task a decision is about (Navigation spec R-16, AC-10). An organizer
 * asks about a build task from its own task, so the asking task is not the
 * subject; `subjectTaskId` names it and the decision card shows that task.
 *
 * Validated on write: the subject is in the asker's mission, or, for a
 * question with no mission, in the asker's workspace. Optional: without it
 * the card falls back to the mission.
 */
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { isUuid } from '@/lib/uuid';
import { normalizeDecisionOptions, type DecisionOption } from '@buildd/core/question-brief';

export type SubjectTaskCheck =
  | { ok: true; subjectTaskId: string | null }
  | { ok: false; error: string };

export async function checkSubjectTask(
  raw: unknown,
  scope: { missionId?: string | null; workspaceId?: string | null },
): Promise<SubjectTaskCheck> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, subjectTaskId: null };
  if (typeof raw !== 'string' || !isUuid(raw)) {
    return { ok: false, error: 'subjectTaskId must be the full UUID of the task the decision is about.' };
  }
  const task = await db.query.tasks.findFirst({
    where: sqlWhere(eq(tasks.id, raw)),
    columns: { id: true, missionId: true, workspaceId: true },
  });
  const inScope = !!task && (scope.missionId
    ? task.missionId === scope.missionId
    : !!scope.workspaceId && task.workspaceId === scope.workspaceId);
  if (!inScope) {
    return {
      ok: false,
      error: scope.missionId
        ? 'subjectTaskId must name a task in the same mission. Leave it out to tie the decision to the mission.'
        : 'subjectTaskId must name a task in the same workspace. Leave it out to tie the decision to this task.',
    };
  }
  return { ok: true, subjectTaskId: task.id };
}

/**
 * The decision fields of a note body: `subjectTaskId` (checked against the
 * scope) and, on a question, structured `options` (question-brief.ts
 * `normalizeDecisionOptions`). With options and no `defaultChoice`, the
 * recommended option is the default. Both notes routes (mission and task-scoped) read it.
 */
export async function questionDecisionFields(
  body: { type?: unknown; subjectTaskId?: unknown; options?: unknown; defaultChoice?: unknown },
  scope: { missionId?: string | null; workspaceId?: string | null },
): Promise<{ error: string } | { subjectTaskId: string | null; options: DecisionOption[] | null; defaultChoice: string | null }> {
  const subject = await checkSubjectTask(body.subjectTaskId, scope);
  if (!subject.ok) return { error: subject.error };
  let options: DecisionOption[] | null = null;
  if (body.options !== undefined && body.options !== null) {
    if (body.type !== 'question') return { error: 'options apply only to a question note.' };
    const normalized = normalizeDecisionOptions(body.options);
    if ('error' in normalized) return { error: normalized.error };
    options = normalized.options.length ? normalized.options : null;
  }
  const given = typeof body.defaultChoice === 'string' && body.defaultChoice.trim() ? body.defaultChoice : null;
  return {
    subjectTaskId: subject.subjectTaskId,
    options,
    defaultChoice: given ?? options?.find(o => o.recommended)?.label ?? null,
  };
}

/** Sensitive workspace, agent author: labels only, like `defaultChoice`; consequences are prose. */
export function sensitiveDecisionOptions(options: DecisionOption[] | null): DecisionOption[] | null {
  return options?.map(o => ({ label: o.label, ...(o.recommended ? { recommended: true } : {}) })) ?? null;
}

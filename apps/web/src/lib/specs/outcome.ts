import { db } from '@buildd/core/db';
import { artifactReads, specDiscrepancies, specOutcomeVerdicts, specRevisions, specs, tasks } from '@buildd/core/db/schema';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  VERIFICATION_VERDICTS, boundEvidenceRefs, foldGovernedOutcome,
  type GovernedOutcomeReadout, type VerificationVerdict,
} from '@buildd/core/verification-check';
import { isUuid } from '@/lib/uuid';
import { getDeliveryViewsForTasks } from '@/lib/workflow/delivery-view';
import { readPinnedSpecRevision } from './pin';
import { specCriteria, type RequirementRef } from './requirements';
import { fail, reach, type SpecCaller, type SpecError } from './store';

/**
 * Governed outcomes (Living Specs V1, decision D-5): whether a task's outcome
 * satisfies the approved spec revision it is pinned to (G2), kept apart from
 * whether the task completed or its PR merged.
 *
 * The criteria are the requirements (`R-n`) and acceptance criteria (`AC-n`)
 * of the pinned revision's body, parsed by ./requirements.ts. Decisions and
 * invariants are context, not criteria. A verdict on one criterion is a row in
 * `spec_outcome_verdicts`, bound to the PR head it judged and the references it
 * read (F4 read-ledger ids); the newest row per criterion stands. The outcome
 * is folded by `foldGovernedOutcome` (packages/core/verification-check.ts):
 * verified only when every criterion passes on the current PR head, fail when
 * any criterion's newest verdict is fail, unverified otherwise.
 *
 * Advisory (D-5): nothing here blocks a completion or a merge. A failed
 * outcome is reported as failed; the task stays completed and the PR merged.
 *
 * Who records: a person or an account with write access to the workspace, or
 * the per-task token of a task whose parent is the subject (the reviewer or a
 * verification task filed under it). A task never grades its own outcome, so
 * the subject's own token may read the outcome but not record a verdict.
 */

export const MAX_VERDICT_READS = 20;
const SHA = /^[0-9a-f]{7,40}$/i;

export { specCriteria };

type TaskRow = { id: string; workspaceId: string; context: unknown; parentTaskId: string | null };
type Mode = 'read' | 'record';

async function loadTask(taskId: string): Promise<TaskRow | null> {
  const [t] = await db.select({ id: tasks.id, workspaceId: tasks.workspaceId, context: tasks.context, parentTaskId: tasks.parentTaskId })
    .from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return (t as TaskRow | undefined) ?? null;
}

/** The workspace of a task, for a route's task-token confinement; null when there is no such task. */
export async function governedTaskWorkspace(taskId: string): Promise<string | null> {
  if (!isUuid(taskId)) return null;
  return (await loadTask(taskId))?.workspaceId ?? null;
}

async function mayAct(caller: SpecCaller, task: TaskRow, mode: Mode): Promise<boolean> {
  if (!(await reach(caller, task.workspaceId, mode === 'record'))) return false;
  const scope = caller.kind === 'account' ? (caller.account.taskScope as { taskId?: string } | undefined) : undefined;
  if (!scope) return true;
  if (mode === 'read' && scope.taskId === task.id) return true;
  // A child of the subject (its reviewer, a verification task) may record; the subject itself may not.
  if (!scope.taskId || !isUuid(scope.taskId)) return false;
  const [own] = await db.select({ parentTaskId: tasks.parentTaskId }).from(tasks).where(eq(tasks.id, scope.taskId)).limit(1);
  return own?.parentTaskId === task.id;
}

const pinOf = (context: unknown): Record<string, unknown> | null => {
  const c = context && typeof context === 'object' ? (context as Record<string, unknown>).specSource : null;
  return c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : null;
};

/**
 * The GitHub head the task's PR delivery acts on, as the workflow kernel
 * observed it (its delivery view); never a runner-reported SHA. Null when the
 * task has no kernel delivery, so nothing can be verified against a head.
 */
export async function currentPrHeadSha(taskId: string): Promise<string | null> {
  const view = (await getDeliveryViewsForTasks([taskId])).get(taskId);
  return view?.headSha ?? null;
}

export type OutcomeView = GovernedOutcomeReadout & {
  specId: string;
  specRevisionId: string;
  revision: number;
  criteria: Array<GovernedOutcomeReadout['criteria'][number] & { text: string }>;
};

type Loaded = { task: TaskRow; pin: Record<string, unknown>; revision: number; specRevisionId: string; specId: string; criteria: RequirementRef[] };

async function loadGoverned(caller: SpecCaller | null, taskId: unknown, mode: Mode): Promise<Loaded | SpecError> {
  if (typeof taskId !== 'string' || !isUuid(taskId)) return fail(404, 'Task not found');
  const task = await loadTask(taskId);
  if (!task || (caller && !(await mayAct(caller, task, mode)))) {
    return task && caller && mode === 'record' && (await reach(caller, task.workspaceId, false))
      ? fail(403, 'You may read this outcome but not record a verdict: that takes write access, and a task never grades its own outcome (a person, or a review or verification task filed under it, records verdicts)')
      : fail(404, 'Task not found');
  }
  const pin = pinOf(task.context);
  if (!pin || typeof pin.specId !== 'string') return fail(409, 'This task is not pinned to a Living Spec, so it has no governed outcome');
  const read = await readPinnedSpecRevision(pin);
  if (!read.ok) return fail(409, `The pinned spec revision is unavailable: ${read.reason}`);
  return { task, pin, revision: read.revision, specRevisionId: pin.specRevisionId as string, specId: read.specId, criteria: specCriteria(read.body) };
}

async function fold(l: Loaded): Promise<OutcomeView> {
  const rows = await db.select({ criterionId: specOutcomeVerdicts.criterionId, verdict: specOutcomeVerdicts.verdict, headSha: specOutcomeVerdicts.headSha, at: specOutcomeVerdicts.createdAt })
    .from(specOutcomeVerdicts)
    .where(and(eq(specOutcomeVerdicts.taskId, l.task.id), eq(specOutcomeVerdicts.specRevisionId, l.specRevisionId)))
    .orderBy(asc(specOutcomeVerdicts.createdAt));
  const head = await currentPrHeadSha(l.task.id);
  const r = foldGovernedOutcome(l.criteria.map((c) => c.id), rows, head);
  const text = new Map(l.criteria.map((c) => [c.id, c.text]));
  return { ...r, specId: l.specId, specRevisionId: l.specRevisionId, revision: l.revision, criteria: r.criteria.map((c) => ({ ...c, text: text.get(c.criterionId) ?? '' })) };
}

/** The governed outcome of a task. `caller` null = a server-side read (no access check). */
export async function readGovernedOutcome(caller: SpecCaller | null, taskId: unknown): Promise<{ ok: true; outcome: OutcomeView } | SpecError> {
  const l = await loadGoverned(caller, taskId, 'read');
  if ('ok' in l) return l;
  return { ok: true, outcome: await fold(l) };
}

/**
 * Record one verdict on one criterion of the task's pinned revision, bound to
 * `headSha` (the PR head judged) and the reads behind it. Append-only.
 */
export async function recordSpecVerdict(caller: SpecCaller, taskId: unknown, input: {
  criterionId: unknown; verdict: unknown; headSha: unknown; evidenceRefs?: unknown; readIds?: unknown; observed?: unknown;
}): Promise<{ ok: true; verdictId: string; outcome: OutcomeView } | SpecError> {
  const l = await loadGoverned(caller, taskId, 'record');
  if ('ok' in l) return l;
  const { criterionId, verdict, headSha } = input;
  if (typeof criterionId !== 'string' || !l.criteria.some((c) => c.id === criterionId)) {
    const ids = l.criteria.map((c) => c.id);
    return fail(400, `criterionId must be a criterion of the pinned revision ${l.revision}: ${ids.length ? ids.join(', ') : 'it has none (no R-n or AC-n lines)'}`);
  }
  if (typeof verdict !== 'string' || !(VERIFICATION_VERDICTS as readonly string[]).includes(verdict)) {
    return fail(400, `verdict must be one of: ${VERIFICATION_VERDICTS.join(', ')}`);
  }
  if (typeof headSha !== 'string' || !SHA.test(headSha)) return fail(400, 'headSha (the PR head commit the verdict judged) is required');
  let readIds: string[] = [];
  if (input.readIds !== undefined) {
    if (!Array.isArray(input.readIds) || input.readIds.length > MAX_VERDICT_READS || !input.readIds.every((id) => typeof id === 'string' && isUuid(id))) {
      return fail(400, `readIds must be at most ${MAX_VERDICT_READS} artifact read ids`);
    }
    readIds = [...new Set(input.readIds as string[])];
    if (readIds.length > 0) {
      const found = await db.select({ id: artifactReads.id }).from(artifactReads)
        .where(and(inArray(artifactReads.id, readIds), eq(artifactReads.workspaceId, l.task.workspaceId)));
      if (found.length !== readIds.length) return fail(400, 'readIds must name reads recorded in this workspace');
    }
  }
  const refs = boundEvidenceRefs(input.evidenceRefs);
  const observed = typeof input.observed === 'string' && input.observed.trim() ? input.observed.trim().slice(0, 500) : undefined;
  const recordedBy = caller.kind === 'user' ? `user:${caller.userId}` : `account:${caller.account.id}`;
  const [row] = await db.insert(specOutcomeVerdicts).values({
    workspaceId: l.task.workspaceId,
    taskId: l.task.id,
    specRevisionId: l.specRevisionId,
    criterionId,
    verdict: verdict as VerificationVerdict,
    headSha: headSha.toLowerCase(),
    evidence: { refs, readIds, ...(observed ? { observed } : {}), recordedBy },
  }).returning({ id: specOutcomeVerdicts.id });
  return { ok: true, verdictId: row.id, outcome: await fold(l) };
}

/**
 * Record that two criteria of an approved revision conflict. Advisory (D-5):
 * a `conflict` discrepancy is shown for a person to accept; it is never
 * promoted, flipped or used to block anything. Identity is the spec and the
 * pair, so a repeat updates one row and names the newest revision it was seen in.
 */
export async function recordSpecConflict(caller: SpecCaller, specId: unknown, input: {
  revision: unknown; criterionIds: unknown; note?: unknown;
}): Promise<{ ok: true; discrepancyId: string } | SpecError> {
  if (typeof specId !== 'string' || !isUuid(specId)) return fail(404, 'Spec not found');
  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || !(await reach(caller, spec.workspaceId, true))) return fail(404, 'Spec not found');
  if (!Number.isInteger(input.revision)) return fail(400, 'revision (the approved revision whose criteria conflict) is required');
  const [rev] = await db.select().from(specRevisions)
    .where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, input.revision as number), isNotNull(specRevisions.approvedAt))).limit(1);
  if (!rev) return fail(409, `Revision ${input.revision as number} is not an approved revision of this spec`);
  const read = await readPinnedSpecRevision({ specId, specRevisionId: rev.id, contentHash: rev.contentHash });
  if (!read.ok) return fail(409, `Revision ${rev.revision} is unavailable: ${read.reason}`);
  const ids = input.criterionIds;
  const known = new Set(specCriteria(read.body).map((c) => c.id));
  if (!Array.isArray(ids) || ids.length !== 2 || ids[0] === ids[1] || !ids.every((id) => typeof id === 'string' && known.has(id))) {
    return fail(400, `criterionIds must name two different criteria of revision ${rev.revision}`);
  }
  const pair = [...(ids as string[])].sort();
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 500) : '';
  const evidence = { kind: 'living_spec_conflict', specId, revision: rev.revision, criterionIds: pair, ...(note ? { note } : {}) };
  const [row] = await db.insert(specDiscrepancies).values({
    workspaceId: spec.workspaceId,
    specPath: `living-spec:${specId}`,
    assertionId: `conflict:${pair.join('+')}`,
    direction: 'conflict',
    specRevisionId: rev.id,
    evidence,
  }).onConflictDoUpdate({
    target: [specDiscrepancies.workspaceId, specDiscrepancies.specPath, specDiscrepancies.assertionId],
    set: { specRevisionId: rev.id, evidence, lastCheckedAt: sql`now()` },
  }).returning({ id: specDiscrepancies.id });
  return { ok: true, discrepancyId: row.id };
}

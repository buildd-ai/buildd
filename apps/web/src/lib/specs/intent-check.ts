import { db } from '@buildd/core/db';
import { specIntentChecks, specRevisions, specs, tasks, type SpecIntentQuestion } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { approverWorkspaces } from './approval-inbox';
import { fail, reach, type SpecCaller, type SpecError } from './store';

/**
 * The independent intent check (Living Spec 65ed7fa3 R-360 to R-364). A
 * revision that carries a conversation provenance link is compared with that
 * conversation, not with code, by a reviewer that is not its drafter and not a
 * builder of the spec. What the reviewer finds becomes questions for the
 * owner: one sentence each with a recommended answer. A clean check records
 * none, so nothing reaches the owner's inbox.
 *
 * Independence is by identity, decided here from the server's own records: the
 * caller's account and task are compared with the revision's author, the task
 * that wrote it and every task pinned to the spec. Nothing in the request says
 * who the checker is.
 */

export interface IntentFacts {
  workspaceId: string;
  revision: number;
  contentHash: string;
  provenance: { conversationId: string; messageId: string; messageAt: string } | null;
  /** The revision's author id (an account or a person). */
  drafterId: string;
  /** The task that wrote the revision, when one did. */
  drafterTaskId: string | null;
  /** Tasks whose context pins this spec: its builders. */
  pinnedTaskIds: string[];
}

export interface IntentRow {
  specId: string; revision: number; contentHash: string; conversationId: string; messageIds: string[];
  checkerAccountId: string; checkerTaskId: string | null; questions: SpecIntentQuestion[];
}

export interface IntentDeps {
  load: (specId: string, revision: number) => Promise<IntentFacts | null>;
  /** Inserts the one result for (spec, revision); false when one is already there. */
  save: (row: IntentRow) => Promise<boolean>;
  reachable: (caller: SpecCaller, workspaceId: string) => Promise<boolean>;
}

/** 403 unless the caller can be shown independent of the drafter and every builder. */
export function independenceRefusal(caller: SpecCaller, f: IntentFacts): SpecError | null {
  const refused = (why: string) => fail(403, `The intent check must come from a reviewer that is not ${why}.`, { code: 'checker_not_independent' });
  // A person answers the owner's questions; they never stand in as the checker.
  if (caller.kind !== 'account') return refused('a person: the owner answers its questions, an independent task runs it');
  if (caller.account.id === f.drafterId) return refused('the drafter');
  const taskId = (caller.account.taskScope as { taskId?: string } | undefined)?.taskId;
  if (!taskId) return refused('unscoped: it must run as its own task, so it can be shown independent of the drafter and the builders');
  if (taskId === f.drafterTaskId) return refused('the task that wrote the draft');
  if (f.pinnedTaskIds.includes(taskId)) return refused('a builder of this spec');
  return null;
}

const MAX_FINDINGS = 20;
const MAX_TEXT = 300;
const oneSentence = (s: string) => !/[.!?]\s+\S/.test(s.trim());

/** Findings as the reviewer sends them: each a mismatch or a gap, one sentence, with a recommended answer. */
export function parseFindings(v: unknown): { ok: true; questions: SpecIntentQuestion[] } | SpecError {
  if (v === undefined || v === null) return { ok: true, questions: [] };
  if (!Array.isArray(v)) return fail(400, 'findings must be a list');
  if (v.length > MAX_FINDINGS) return fail(400, `findings holds at most ${MAX_FINDINGS}: batch the rest into fewer, plainer questions`);
  const out: SpecIntentQuestion[] = [];
  for (const [i, raw] of v.entries()) {
    const f = (raw ?? {}) as Record<string, unknown>;
    const text = typeof f.text === 'string' ? f.text.trim() : '';
    const recommended = typeof f.recommended === 'string' ? f.recommended.trim() : '';
    if (f.kind !== 'mismatch' && f.kind !== 'gap') return fail(400, `findings[${i}].kind must be "mismatch" or "gap"`);
    if (!text || text.length > MAX_TEXT || !oneSentence(text)) return fail(400, `findings[${i}].text must be one sentence of at most ${MAX_TEXT} characters`);
    if (!recommended || recommended.length > MAX_TEXT) return fail(400, `findings[${i}].recommended (the answer you suggest) is required, at most ${MAX_TEXT} characters`);
    const criterionId = typeof f.criterionId === 'string' && /^(R|AC|D|I)-\d+$/.test(f.criterionId) ? f.criterionId : undefined;
    out.push({ id: `q${i + 1}`, kind: f.kind, text, recommended, ...(criterionId ? { criterionId } : {}) });
  }
  return { ok: true, questions: out };
}

const defaultDeps: IntentDeps = {
  reachable: (caller, workspaceId) => reach(caller, workspaceId, true),
  load: async (specId, revision) => {
    const [r] = await db.select({
      workspaceId: specs.workspaceId, revision: specRevisions.revision, contentHash: specRevisions.contentHash,
      provenance: specRevisions.provenance, authorId: specRevisions.authorId,
    }).from(specRevisions).innerJoin(specs, eq(specs.id, specRevisions.specId))
      .where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, revision))).limit(1);
    if (!r) return null;
    const pinned = await db.select({ id: tasks.id }).from(tasks)
      .where(sql`${tasks.context}->'specSource'->>'specId' = ${specId} OR ${tasks.context}->'specAuthored'->>'specId' = ${specId}`);
    const authoring = await db.select({ id: tasks.id }).from(tasks)
      .where(sql`${tasks.context}->'specAuthored'->>'specId' = ${specId} AND (${tasks.context}->'specAuthored'->>'revision')::int = ${revision}`);
    const drafterTaskId = authoring[0]?.id ?? null;
    return { workspaceId: r.workspaceId, revision: r.revision, contentHash: r.contentHash, provenance: r.provenance, drafterId: r.authorId,
      drafterTaskId, pinnedTaskIds: pinned.map((p) => p.id).filter((id) => id !== drafterTaskId) };
  },
  save: async (row) => {
    const ins = await db.insert(specIntentChecks).values(row).onConflictDoNothing().returning({ id: specIntentChecks.id });
    return ins.length > 0;
  },
};

/**
 * Record the independent check of one revision. Refused with 403 when the
 * caller is the drafter, the drafting task, a task pinned to the spec or a
 * person; the check then stays open (nothing is written).
 */
export async function recordIntentCheck(
  caller: SpecCaller,
  specId: string,
  input: { revision?: unknown; contentHash?: unknown; conversationId?: unknown; messageIds?: unknown; findings?: unknown },
  deps: IntentDeps = defaultDeps,
): Promise<{ ok: true; questions: SpecIntentQuestion[] } | SpecError> {
  if (!isUuid(specId)) return fail(404, 'Spec not found');
  if (!Number.isInteger(input.revision)) return fail(400, 'revision (the revision you checked) is required');
  const f = await deps.load(specId, input.revision as number);
  if (!f || !(await deps.reachable(caller, f.workspaceId))) return fail(404, 'Spec not found');
  const refusal = independenceRefusal(caller, f);
  if (refusal) return refusal;
  if (!f.provenance) return fail(409, 'This revision cites no conversation, so there is nothing to check it against. It keeps the ordinary approval.', { code: 'no_provenance' });
  if (input.contentHash !== f.contentHash) return fail(409, 'The revision changed since you read it. Check the current text.', { code: 'stale' });
  if (input.conversationId !== f.provenance.conversationId) return fail(400, 'conversationId must be the conversation the revision cites');
  const ids = Array.isArray(input.messageIds) ? input.messageIds : [];
  if (!ids.length || ids.length > 500 || !ids.every((m) => typeof m === 'string' && isUuid(m))) return fail(400, 'messageIds (the messages you read, as ids) are required');
  const parsed = parseFindings(input.findings);
  if (!parsed.ok) return parsed;
  const taskId = (caller.kind === 'account' ? (caller.account.taskScope as { taskId?: string } | undefined)?.taskId : undefined) ?? null;
  const saved = await deps.save({
    specId, revision: f.revision, contentHash: f.contentHash, conversationId: f.provenance.conversationId, messageIds: ids as string[],
    checkerAccountId: caller.kind === 'account' ? caller.account.id : '', checkerTaskId: taskId, questions: parsed.questions,
  });
  if (!saved) return fail(409, 'This revision already has its check.', { code: 'already_checked' });
  return { ok: true, questions: parsed.questions };
}

/** One open question in the owner's batched list. */
export interface InboxQuestion extends SpecIntentQuestion { specId: string; specTitle: string; revision: number; workspaceName: string }

/**
 * The owner's open questions across every spec they may approve, one list
 * (R-363): from the head revision's check only, answered ones left out.
 */
export async function listOpenIntentQuestions(userId: string): Promise<InboxQuestion[]> {
  const ws = await approverWorkspaces(userId);
  if (!ws.length) return [];
  const names = new Map(ws.map((w) => [w.id, w.name]));
  const rows = await db.select({
    specId: specs.id, title: specs.title, workspaceId: specs.workspaceId, revision: specIntentChecks.revision, questions: specIntentChecks.questions,
  }).from(specIntentChecks)
    .innerJoin(specs, and(eq(specs.id, specIntentChecks.specId), eq(specs.headRevision, specIntentChecks.revision)))
    .where(sql`${specs.workspaceId} IN (${sql.join(ws.map((w) => sql`${w.id}::uuid`), sql`, `)}) AND ${specs.status} NOT IN ('retired', 'superseded')`)
    .orderBy(sql`${specIntentChecks.createdAt} DESC`);
  return rows.flatMap((r) => r.questions.filter((q) => !q.answeredAt)
    .map((q) => ({ ...q, specId: r.specId, specTitle: r.title, revision: r.revision, workspaceName: names.get(r.workspaceId) ?? '' })));
}

/**
 * The owner answers one question (R-364): only a person's own session sets
 * answeredAt, answeredBy and answer, never an agent or task. `answer` is the
 * suggested one when omitted (the one-action accept). Atomic on the question's
 * still being open, so a double click answers once.
 */
export async function answerIntentQuestion(
  caller: SpecCaller,
  specId: string,
  input: { revision?: unknown; questionId?: unknown; answer?: unknown },
): Promise<{ ok: true; question: SpecIntentQuestion } | SpecError> {
  if (caller.kind !== 'user') return fail(403, 'Only the owner answers these questions, from their own signed-in session.', { code: 'not_a_person' });
  if (!isUuid(specId)) return fail(404, 'Spec not found');
  if (!Number.isInteger(input.revision) || typeof input.questionId !== 'string') return fail(400, 'revision and questionId are required');
  if (input.answer !== undefined && (typeof input.answer !== 'string' || !input.answer.trim() || input.answer.length > MAX_TEXT)) {
    return fail(400, `answer is at most ${MAX_TEXT} characters`);
  }
  const [spec] = await db.select({ workspaceId: specs.workspaceId }).from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || !(await approverWorkspaces(caller.userId)).some((w) => w.id === spec.workspaceId)) return fail(404, 'Spec not found');
  const [row] = await db.select({ id: specIntentChecks.id, questions: specIntentChecks.questions }).from(specIntentChecks)
    .where(and(eq(specIntentChecks.specId, specId), eq(specIntentChecks.revision, input.revision as number))).limit(1);
  const q = row?.questions.find((x) => x.id === input.questionId);
  if (!row || !q) return fail(404, 'Question not found');
  if (q.answeredAt) return fail(409, 'That question is already answered.', { code: 'already_answered' });
  const answered: SpecIntentQuestion = {
    ...q, answeredAt: new Date().toISOString(), answeredBy: caller.userId,
    answer: typeof input.answer === 'string' ? input.answer.trim() : q.recommended,
  };
  const next = row.questions.map((x) => (x.id === q.id ? answered : x));
  const upd = await db.update(specIntentChecks).set({ questions: next })
    .where(and(eq(specIntentChecks.id, row.id), sql`NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${specIntentChecks.questions}) e WHERE e->>'id' = ${q.id} AND e->>'answeredAt' IS NOT NULL)`))
    .returning({ id: specIntentChecks.id });
  if (!upd.length) return fail(409, 'That question is already answered.', { code: 'already_answered' });
  return { ok: true, question: answered };
}

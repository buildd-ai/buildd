import { db } from '@buildd/core/db';
import { specOwnerQuestions, specRevisions, specs } from '@buildd/core/db/schema';
import type { SpecApprovalRecord } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { criterionChecks } from '@buildd/spec-contract/check-lines';
import { getArtifactRevisions } from '@/lib/artifact-revisions';
import { isUuid } from '@/lib/uuid';
import { approvedAttachmentsSql } from './attachment-pins';
import { specApprover } from './approval';
import { retireSpec } from './retire';
import { fail, reach, type SpecCaller, type SpecError } from './store';
import {
  answerRetirementBatch, decideImportCheck, importMismatchQuestion, parseRetirementProposal, retirementBatchQuestion,
  type ImportCheckResult, type RetirementItem,
} from './import-check';

/**
 * Import auto-confirm (R-370, R-371) and the batch retirement proposal (R-372).
 *
 * `applyImportCheck` is a server-side path with no caller: it takes a spec id
 * and what the check run reported at the repo head, never a person's or an
 * agent's word that the spec was approved. Whoever feeds it results must be
 * the check run's own (the runner's report); there is no route that takes
 * results from a request.
 */

export const IMPORT_CHECK_APPROVER = 'check:import-check';
const rowsOf = <T,>(r: unknown) => ((r as { rows?: T[] }).rows ?? []);

export type ImportCheckOutcome =
  | { state: 'confirmed'; revision: number }
  | { state: 'question'; questionId: string; created: boolean }
  | { state: 'none'; reason: string };

/**
 * `headSha`: the repo head the checks ran at. `fileBlobSha`: the spec file's
 * blob at that head; a file that moved since the import is a re-import's
 * business, never confirmed here (R-19).
 */
export async function applyImportCheck(specId: string, input: { headSha: string; fileBlobSha: string; results: readonly ImportCheckResult[] }): Promise<ImportCheckOutcome> {
  const none = (reason: string): ImportCheckOutcome => ({ state: 'none', reason });
  if (!/^[0-9a-f]{40}$/.test(input.headSha)) return none('headSha must be a full commit SHA');
  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec) return none('spec not found');
  if (spec.status === 'retired' || spec.status === 'superseded') return none(`the spec is ${spec.status}`);
  const src = spec.repoSource;
  if (!src || src.state !== 'imported' || src.revision !== spec.headRevision) return none('no imported revision is waiting');
  if (src.blobSha !== input.fileBlobSha) return none('the file changed since it was imported: import again first');
  const n = spec.headRevision;
  const [rev] = await db.select().from(specRevisions).where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, n))).limit(1);
  if (!rev || rev.approvedAt) return none('the head is already approved');
  const read = (await getArtifactRevisions(spec.bodyArtifactId, [rev.artifactRevision])).get(rev.artifactRevision);
  if (!read || typeof read.content !== 'string' || read.contentHash !== rev.contentHash) return none('the body is missing or does not match its hash');

  const decision = decideImportCheck(criterionChecks(read.content), input.results);
  if (decision.kind === 'none') return none(decision.reason);
  if (decision.kind === 'mismatch') {
    const q = importMismatchQuestion(spec.title, decision.failed);
    const inserted = await db.insert(specOwnerQuestions).values({
      workspaceId: spec.workspaceId, kind: 'import_mismatch', specId, text: q.text, recommended: q.recommended,
      payload: { revision: n, headSha: input.headSha, failed: decision.failed }, createdBy: IMPORT_CHECK_APPROVER,
    }).onConflictDoNothing().returning({ id: specOwnerQuestions.id });
    if (inserted[0]) return { state: 'question', questionId: inserted[0].id, created: true };
    const [open] = await db.select({ id: specOwnerQuestions.id }).from(specOwnerQuestions)
      .where(and(eq(specOwnerQuestions.specId, specId), eq(specOwnerQuestions.kind, 'import_mismatch'), eq(specOwnerQuestions.status, 'open'))).limit(1);
    return { state: 'question', questionId: open?.id ?? '', created: false };
  }

  const record: SpecApprovalRecord = { via: 'import-check', gate: null, importCheck: { headSha: input.headSha, results: input.results.map((r) => ({ criterionId: r.criterionId, outcome: r.outcome })) } };
  const confirm = JSON.stringify({ state: 'confirmed', confirmedBy: IMPORT_CHECK_APPROVER, note: `checks passed at ${input.headSha.slice(0, 7)}` });
  const rows = await db.execute(sql`
    WITH stamp AS (
      UPDATE spec_revisions SET approved_by = ${IMPORT_CHECK_APPROVER}, approved_at = now(), approval = ${JSON.stringify(record)}::jsonb,
        approved_attachments = ${approvedAttachmentsSql(specId, n)}
      WHERE spec_id = ${specId}::uuid AND revision = ${n} AND approved_at IS NULL AND content_hash = ${rev.contentHash}
        AND EXISTS (SELECT 1 FROM specs WHERE id = ${specId}::uuid AND version = ${spec.version} AND head_revision = ${n} AND repo_source->>'state' = 'imported' AND repo_source->>'blobSha' = ${input.fileBlobSha})
      RETURNING revision
    )
    UPDATE specs SET approved_revision = ${n}, status = 'approved', version = version + 1, updated_at = now(),
      repo_source = repo_source || ${confirm}::jsonb || jsonb_build_object('confirmedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE id = ${specId}::uuid AND version = ${spec.version} AND head_revision = ${n} AND repo_source->>'state' = 'imported' AND EXISTS (SELECT 1 FROM stamp)
    RETURNING id`);
  if (rowsOf(rows).length === 0) return none('the spec changed while it was checked');
  // A mismatch raised before the code was fixed is moot now.
  await db.update(specOwnerQuestions).set({ status: 'answered', answeredBy: IMPORT_CHECK_APPROVER, answeredAt: new Date(), answer: { via: 'import-check', headSha: input.headSha } })
    .where(and(eq(specOwnerQuestions.specId, specId), eq(specOwnerQuestions.kind, 'import_mismatch'), eq(specOwnerQuestions.status, 'open')));
  const [after] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  const { followApproval } = await import('./approval');
  if (after) followApproval(after, n);
  return { state: 'confirmed', revision: n };
}

// ── The batch retirement proposal (R-372) ───────────────────────────────────

/** An agent proposes; nothing is retired. One open proposal per call, listing every spec with its reason. */
export async function proposeRetirementBatch(caller: SpecCaller, input: { workspaceId?: unknown; items?: unknown }): Promise<{ ok: true; questionId: string; items: RetirementItem[] } | SpecError> {
  const workspaceId = input.workspaceId;
  if (typeof workspaceId !== 'string' || !isUuid(workspaceId)) return fail(400, 'workspaceId must be a UUID');
  if (!(await reach(caller, workspaceId, true))) return fail(404, 'Workspace not found');
  const live = await db.select({ specId: specs.id, title: specs.title }).from(specs)
    .where(and(eq(specs.workspaceId, workspaceId), sql`${specs.status} NOT IN ('retired', 'superseded')`));
  const parsed = parseRetirementProposal(input.items, live);
  if (!parsed.ok) return fail(400, parsed.error);
  const q = retirementBatchQuestion(parsed.items.length);
  const [row] = await db.insert(specOwnerQuestions).values({
    workspaceId, kind: 'retire_batch', text: q.text, recommended: q.recommended, payload: { items: parsed.items },
    createdBy: caller.kind === 'user' ? `user:${caller.userId}` : `account:${caller.account.id}`,
  }).returning({ id: specOwnerQuestions.id });
  return { ok: true, questionId: row!.id, items: parsed.items };
}

export interface OwnerQuestionView { id: string; kind: 'import_mismatch' | 'retire_batch'; specId: string | null; text: string; recommended: string; items?: RetirementItem[] }

export async function openOwnerQuestions(caller: SpecCaller, workspaceId: string): Promise<{ ok: true; questions: OwnerQuestionView[] } | SpecError> {
  if (!isUuid(workspaceId) || !(await reach(caller, workspaceId, false))) return fail(404, 'Workspace not found');
  const rows = await db.select().from(specOwnerQuestions).where(and(eq(specOwnerQuestions.workspaceId, workspaceId), eq(specOwnerQuestions.status, 'open')));
  return { ok: true, questions: rows.map((r) => ({ id: r.id, kind: r.kind, specId: r.specId, text: r.text, recommended: r.recommended, ...(r.kind === 'retire_batch' ? { items: (r.payload.items ?? []) as RetirementItem[] } : {}) })) };
}

/**
 * The owner's one answer. Only a person's own session with approval rights: an
 * agent token or API key is a 403 and the question stays open. A retire batch
 * retires through `retireSpec` (R-51, R-78), one recorded confirm per spec;
 * `keep` limits it to the listed specs the owner left in.
 */
export async function answerOwnerQuestion(caller: SpecCaller, questionId: string, input: { keep?: unknown; presence?: unknown }): Promise<
  { ok: true; retired: Array<{ specId: string; title: string }>; skipped: Array<{ specId: string; title: string; error: string }> } | SpecError
> {
  if (caller.kind !== 'user') return fail(403, 'Only the owner, from their own signed-in session, answers this. An agent run or API key cannot.', { code: 'not_a_person' });
  if (!isUuid(questionId)) return fail(404, 'Question not found');
  const [q] = await db.select().from(specOwnerQuestions).where(eq(specOwnerQuestions.id, questionId)).limit(1);
  if (!q || !(await reach(caller, q.workspaceId, false))) return fail(404, 'Question not found');
  if (!(await specApprover(caller, q.workspaceId))) return fail(403, 'Only an owner or admin of this team, or a delegated approver, answers this.', { code: 'not_a_person' });
  if (q.status !== 'open') return fail(409, 'Already answered');
  const keep = input.keep === undefined ? undefined : Array.isArray(input.keep) && input.keep.every((k) => typeof k === 'string') ? (input.keep as string[]) : null;
  if (keep === null) return fail(400, 'keep is a list of spec ids from the proposal');

  const retired: Array<{ specId: string; title: string }> = [];
  const skipped: Array<{ specId: string; title: string; error: string }> = [];
  if (q.kind === 'retire_batch') {
    for (const item of answerRetirementBatch((q.payload.items ?? []) as RetirementItem[], keep)) {
      const r = await retireSpec(caller, item.specId, { reason: item.reason, presence: input.presence });
      if (r.ok && !('pending' in r)) retired.push({ specId: item.specId, title: item.title });
      else skipped.push({ specId: item.specId, title: item.title, error: r.ok ? 'not retired' : r.error });
    }
  }
  const claimed = await db.update(specOwnerQuestions).set({ status: 'answered', answeredBy: `user:${caller.userId}`, answeredAt: new Date(), answer: { retired: retired.map((r) => r.specId), skipped: skipped.map((s) => s.specId) } })
    .where(and(eq(specOwnerQuestions.id, questionId), eq(specOwnerQuestions.status, 'open'))).returning({ id: specOwnerQuestions.id });
  if (!claimed.length) return fail(409, 'Already answered');
  return { ok: true, retired, skipped };
}


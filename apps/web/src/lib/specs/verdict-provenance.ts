import { db } from '@buildd/core/db';
import { specOutcomeVerdicts, specRevisions, specs, verdictEvidence, workers } from '@buildd/core/db/schema';
import { and, desc, eq, isNotNull } from 'drizzle-orm';

export type EvidenceKind = 'test' | 'task' | 'pr' | 'commit';
export interface EvidenceItem { kind: EvidenceKind; ref: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REF = 500;

/**
 * The evidence items a verdict's evidence blob names, in a fixed order: the
 * check command (test), the task that ran the check or audit (task), the head it
 * judged (commit) and the PR that delivered it (pr). Pure; empty and repeated
 * items are dropped.
 */
export function evidenceItemsOf(evidence: unknown, ctx: { headSha?: string | null; prNumber?: number | null }): EvidenceItem[] {
  const e = evidence && typeof evidence === 'object' ? (evidence as Record<string, unknown>) : {};
  const out: EvidenceItem[] = [];
  const add = (kind: EvidenceKind, ref: string) => {
    if (ref && !out.some((i) => i.kind === kind && i.ref === ref)) out.push({ kind, ref });
  };
  if (typeof e.command === 'string') add('test', e.command.trim().slice(0, MAX_REF));
  for (const key of ['verificationTaskId', 'auditTaskId']) {
    const v = e[key];
    if (typeof v === 'string' && UUID_RE.test(v)) add('task', v);
  }
  if (ctx.headSha) add('commit', ctx.headSha.toLowerCase());
  if (typeof ctx.prNumber === 'number' && Number.isInteger(ctx.prNumber) && ctx.prNumber > 0) add('pr', String(ctx.prNumber));
  return out;
}

export function groupByCriterion<T extends { criterionId: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const list = out.get(r.criterionId);
    if (list) list.push(r); else out.set(r.criterionId, [r]);
  }
  return out;
}

/**
 * Record the evidence behind one verdict (verdict_evidence). Idempotent per
 * (verdict, kind, ref). Best-effort bookkeeping like settleVerdictSource: the
 * verdict log stays the source of truth, so a failure is logged and never fails
 * the verdict that was just recorded.
 */
export async function trackVerdictEvidence(verdictId: string): Promise<void> {
  try {
    const [v] = await db.select({
      taskId: specOutcomeVerdicts.taskId, specRevisionId: specOutcomeVerdicts.specRevisionId, criterionId: specOutcomeVerdicts.criterionId,
      headSha: specOutcomeVerdicts.headSha, evidence: specOutcomeVerdicts.evidence,
    }).from(specOutcomeVerdicts).where(eq(specOutcomeVerdicts.id, verdictId)).limit(1);
    if (!v) return;
    let prNumber: number | null = null;
    if (v.taskId) {
      const [w] = await db.select({ prNumber: workers.prNumber }).from(workers)
        .where(and(eq(workers.taskId, v.taskId), isNotNull(workers.prNumber))).orderBy(desc(workers.createdAt)).limit(1);
      prNumber = w?.prNumber ?? null;
    }
    const items = evidenceItemsOf(v.evidence, { headSha: v.headSha, prNumber });
    if (!items.length) return;
    await db.insert(verdictEvidence).values(items.map((i) => ({
      verdictId, specRevisionId: v.specRevisionId, criterionId: v.criterionId, kind: i.kind, ref: i.ref,
    }))).onConflictDoNothing();
  } catch (err) {
    console.error('[verdict-provenance] could not record verdict evidence', err instanceof Error ? err.message : err);
  }
}

/** Forward: the evidence behind a criterion of a revision, newest first. Only a revision of a spec in `workspaceId`. */
export async function evidenceForCriterion(workspaceId: string, specRevisionId: string, criterionId: string) {
  return db.select({ verdictId: verdictEvidence.verdictId, kind: verdictEvidence.kind, ref: verdictEvidence.ref, at: verdictEvidence.createdAt })
    .from(verdictEvidence)
    .innerJoin(specRevisions, eq(specRevisions.id, verdictEvidence.specRevisionId))
    .innerJoin(specs, eq(specs.id, specRevisions.specId))
    .where(and(eq(specs.workspaceId, workspaceId), eq(verdictEvidence.specRevisionId, specRevisionId), eq(verdictEvidence.criterionId, criterionId)))
    .orderBy(desc(verdictEvidence.createdAt));
}

/** Backward: the criteria a test, task, PR or commit speaks for (regression provenance), within `workspaceId` only. */
export async function criteriaForEvidence(workspaceId: string, kind: EvidenceKind, ref: string) {
  return db.select({ specRevisionId: verdictEvidence.specRevisionId, criterionId: verdictEvidence.criterionId, verdictId: verdictEvidence.verdictId })
    .from(verdictEvidence)
    .innerJoin(specRevisions, eq(specRevisions.id, verdictEvidence.specRevisionId))
    .innerJoin(specs, eq(specs.id, specRevisions.specId))
    .where(and(eq(specs.workspaceId, workspaceId), eq(verdictEvidence.kind, kind), eq(verdictEvidence.ref, kind === 'commit' ? ref.toLowerCase() : ref)));
}

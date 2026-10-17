import { db } from '@buildd/core/db';
import { specRevisionReviews, specRevisions, specs } from '@buildd/core/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { otherTextBySection } from '@buildd/spec-contract/criterion-records';
import {
  changeLines, criterionChanges, otherTextChanges, summaryMismatch, summaryMismatchLine,
  type ChangeLine, type ReviewRecord, type SectionTextChange,
} from '@buildd/spec-contract/criterion-review';
import { getArtifactRevisions } from '@/lib/artifact-revisions';
import { readCriterionHistory, recordsByRevision, type CriterionHistory, type StoredCriterion } from './criteria';
import { fail, reach, type SpecCaller, type SpecError } from './store';
import { isUuid } from '@/lib/uuid';
import { diffSpecBodiesWithHunks, type DiffHunk } from './diff';

/**
 * What a revision changes, for Review ("Reviewing a spec revision" R-1 to
 * R-6, R-8, R-16): the author's change summary, the per-criterion change list
 * computed from the criterion records, the other text by section heading, the
 * one-line summary check, and the line diff behind "Show full diff". Nothing
 * here asks a model.
 *
 * Computed once per pair of revisions and kept in spec_revision_reviews: when
 * the later revision is written (against the one before it and against the
 * approved one, or the empty text while nothing is approved), or on the first
 * read of a pair that is not kept. Review reads it.
 */

/** Bump when the stored shape or its computation changes: older rows are computed again. */
export const REVIEW_ALGO = 1;

export interface RevisionReview {
  from: number;
  to: number;
  /** The later revision's change summary, as its author wrote it. */
  summary: string | null;
  lines: ChangeLine[];
  otherText: SectionTextChange[];
  /** "The summary does not mention R-25, which changed."; null when the summary and the list agree. */
  mismatch: string | null;
  hunks: DiffHunk[];
  omittedLines: number;
  linesAdded: number;
  linesRemoved: number;
}

type SpecKey = { id: string; bodyArtifactId: string };

const asReview = (r: StoredCriterion): ReviewRecord => ({ id: r.criterionId, text: r.text, textHash: r.textHash, section: r.section, replaces: r.replaces });

/**
 * Compute the review of `from` → `to` (`from` 0: the empty text) from the two
 * bodies and their records. Bodies the caller already holds are passed in.
 */
async function compute(spec: SpecKey, from: number, to: number, given: ReadonlyMap<number, string>): Promise<RevisionReview | null> {
  const nums = from === 0 ? [to] : [from, to];
  const revs = await db.select().from(specRevisions).where(and(eq(specRevisions.specId, spec.id), inArray(specRevisions.revision, nums)));
  const byN = new Map(revs.map((r) => [r.revision, r]));
  if (nums.some((n) => !byN.has(n))) return null;
  const unread = nums.filter((n) => !given.has(n));
  const read = unread.length ? await getArtifactRevisions(spec.bodyArtifactId, unread.map((n) => byN.get(n)!.artifactRevision)) : new Map();
  const bodies = new Map<number, string>([[0, '']]);
  for (const n of nums) {
    const g = given.get(n);
    const a = read.get(byN.get(n)!.artifactRevision);
    const body = g ?? (a && typeof a.content === 'string' && a.contentHash === byN.get(n)!.contentHash ? a.content : null);
    if (body === null) return null;
    bodies.set(n, body);
  }
  const records = await recordsByRevision(spec, { revisions: nums, bodies });
  const changes = criterionChanges((records.get(from) ?? []).map(asReview), (records.get(to) ?? []).map(asReview));
  const summary = byN.get(to)!.changeSummary ?? null;
  const d = diffSpecBodiesWithHunks(bodies.get(from)!, bodies.get(to)!);
  return {
    from, to, summary,
    lines: changeLines(changes),
    otherText: otherTextChanges(otherTextBySection(bodies.get(from)!), otherTextBySection(bodies.get(to)!)),
    mismatch: summaryMismatchLine(summaryMismatch(summary, changes)),
    hunks: d.hunks, omittedLines: d.omittedLines,
    linesAdded: d.hunks.reduce((n, h) => n + h.linesAdded, 0),
    linesRemoved: d.hunks.reduce((n, h) => n + h.linesRemoved, 0),
  };
}

async function store(spec: SpecKey, r: RevisionReview): Promise<void> {
  await db.insert(specRevisionReviews).values({
    specId: spec.id, fromRevision: r.from, toRevision: r.to, algo: REVIEW_ALGO, review: r as unknown as Record<string, unknown>,
  }).onConflictDoNothing();
}

/** The kept review of a pair, or null when it is not kept. */
export async function storedReview(specId: string, from: number, to: number): Promise<RevisionReview | null> {
  const [row] = await db.select({ review: specRevisionReviews.review }).from(specRevisionReviews)
    .where(and(eq(specRevisionReviews.specId, specId), eq(specRevisionReviews.fromRevision, from), eq(specRevisionReviews.toRevision, to), eq(specRevisionReviews.algo, REVIEW_ALGO)))
    .limit(1);
  return row ? (row.review as unknown as RevisionReview) : null;
}

/** The review of `from` → `to`: kept, else computed now and kept (R-8). Null when a body cannot be read. */
export async function revisionReview(spec: SpecKey, from: number, to: number, bodies: ReadonlyMap<number, string> = new Map()): Promise<RevisionReview | null> {
  const kept = await storedReview(spec.id, from, to);
  if (kept) return kept;
  const r = await compute(spec, from, to, bodies);
  if (r) await store(spec, r);
  return r;
}

/**
 * On writing revision `to` (with `body`): keep its records, and its review
 * against the revision before it and against the approved one (the empty
 * text while nothing is approved). Fail-open: a failure here never undoes the
 * write; the first read derives what is missing.
 */
export async function keepRevisionReviews(spec: SpecKey & { approvedRevision: number | null }, to: number, body: string): Promise<void> {
  const pairs = new Set<number>([to - 1, spec.approvedRevision ?? 0].filter((n) => n >= 0 && n < to));
  if (to === 1) pairs.add(0);
  const bodies = new Map([[to, body]]);
  for (const from of pairs) {
    try {
      await revisionReview(spec, from, to, bodies);
    } catch (err) {
      console.error(`[spec-review] keeping the review of ${spec.id} ${from}→${to} failed:`, err);
    }
  }
}

/**
 * The criterion change list of a pair, for the diff API and MCP (R-2, R-3,
 * R-5): kept, else computed and kept. The caller has already read the spec
 * and checked reach (the diff it answers did). Null when it cannot be read.
 */
export async function pairChanges(specId: string, from: number, to: number): Promise<Pick<RevisionReview, 'summary' | 'lines' | 'otherText' | 'mismatch'> | null> {
  const [spec] = await db.select({ id: specs.id, bodyArtifactId: specs.bodyArtifactId }).from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec) return null;
  const r = await revisionReview(spec, from, to);
  return r ? { summary: r.summary, lines: r.lines, otherText: r.otherText, mismatch: r.mismatch } : null;
}

/** One criterion's history (R-12), for a reader who may read the spec; 404 when the spec never had the id. */
export async function specCriterionHistory(caller: SpecCaller, specId: string, criterionId: unknown): Promise<{ ok: true; history: CriterionHistory } | SpecError> {
  if (!isUuid(specId)) return fail(404, 'Spec not found');
  if (typeof criterionId !== 'string' || !/^(R|AC)-\d+$/.test(criterionId)) return fail(400, 'criterionId must be a criterion id such as R-3 or AC-2');
  const [spec] = await db.select({ id: specs.id, workspaceId: specs.workspaceId, bodyArtifactId: specs.bodyArtifactId }).from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || !(await reach(caller, spec.workspaceId, false))) return fail(404, 'Spec not found');
  const history = await readCriterionHistory(spec, criterionId);
  return history ? { ok: true, history } : fail(404, `This spec has never had ${criterionId}`);
}

/**
 * Backfill (R-8, R-11): derive the criterion records of every revision
 * written before they were kept, and keep the reviews Review reads: each
 * revision against the one before it, and a waiting head against the
 * approved revision. Idempotent: what is kept already is left alone, so a
 * second run writes nothing. `dryRun` only counts the revisions it would
 * derive. Run it deliberately (scripts/backfill-spec-criteria.ts).
 */
export async function backfillSpecCriteria(opts: { dryRun?: boolean; specIds?: readonly string[] } = {}): Promise<{ specs: number; revisions: number; reviews: number; failed: string[] }> {
  const rows = await db.select({ id: specs.id, bodyArtifactId: specs.bodyArtifactId, headRevision: specs.headRevision, approvedRevision: specs.approvedRevision })
    .from(specs).where(opts.specIds ? inArray(specs.id, [...opts.specIds]) : undefined);
  const out = { specs: 0, revisions: 0, reviews: 0, failed: [] as string[] };
  for (const spec of rows) {
    try {
      const missing = await db.select({ revision: specRevisions.revision }).from(specRevisions)
        .where(and(eq(specRevisions.specId, spec.id), isNull(specRevisions.criteriaCount)));
      const kept = new Set((await db.select({ from: specRevisionReviews.fromRevision, to: specRevisionReviews.toRevision }).from(specRevisionReviews)
        .where(and(eq(specRevisionReviews.specId, spec.id), eq(specRevisionReviews.algo, REVIEW_ALGO)))).map((k) => `${k.from}:${k.to}`));
      const pairs: Array<[number, number]> = [];
      for (let n = 1; n <= spec.headRevision; n++) pairs.push([n - 1, n]);
      if (spec.approvedRevision != null && spec.headRevision > spec.approvedRevision + 1) pairs.push([spec.approvedRevision, spec.headRevision]);
      const todo = pairs.filter(([a, b]) => !kept.has(`${a}:${b}`));
      if (!missing.length && !todo.length) continue;
      out.specs++;
      out.revisions += missing.length;
      if (opts.dryRun) { out.reviews += todo.length; continue; }
      await recordsByRevision(spec);
      for (const [a, b] of todo) if (await revisionReview(spec, a, b)) out.reviews++;
    } catch (err) {
      console.error(`[spec-criteria-backfill] ${spec.id} failed:`, err);
      out.failed.push(spec.id);
    }
  }
  return out;
}

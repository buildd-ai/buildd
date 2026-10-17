import { createHash } from 'node:crypto';
import { db } from '@buildd/core/db';
import { specCriterionRecords, specRevisions, specs } from '@buildd/core/db/schema';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { criterionRecords, type CriterionRecord } from '@buildd/spec-contract/criterion-records';
import { getArtifactRevisions } from '@/lib/artifact-revisions';
import { isUuid } from '@/lib/uuid';

/**
 * Criteria as records ("Reviewing a spec revision" R-11 to R-15): every R-n
 * and AC-n of a revision, derived from its body when the revision is written
 * and kept in spec_criteria, so a criterion has a history, a verdict names
 * the wording it judged, and an id is never reused.
 *
 * The body is the source. A record is never edited; a revision whose records
 * are missing (written before they existed, or a write that failed) is
 * derived again from its body on first need, and marked by
 * spec_revisions.criteria_count so a revision with no criteria is not
 * derived over and over.
 */

/** sha256 of a criterion's words, lowercase hex: the same hash as the spec-contract's contentHash. */
export const criterionHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export type HashedRecord = CriterionRecord & { textHash: string };
export type StoredCriterion = typeof specCriterionRecords.$inferSelect;

export function hashedRecords(body: string): HashedRecord[] {
  return criterionRecords(body).map((r) => ({ ...r, textHash: criterionHash(r.text) }));
}

/** Each criterion's text hash in `body`, by id. */
export function criterionHashes(body: string): Map<string, string> {
  return new Map(hashedRecords(body).map((r) => [r.id, r.textHash]));
}

type RevisionKey = { id: string; revision: number };

/**
 * Store the records of one revision. Idempotent: a row already there is kept
 * (a revision's body never changes), and the count is set once.
 */
export async function writeCriterionRecords(specId: string, rev: RevisionKey, body: string): Promise<HashedRecord[]> {
  const recs = hashedRecords(body);
  if (recs.length) {
    await db.insert(specCriterionRecords).values(recs.map((r) => ({
      specId, specRevisionId: rev.id, revision: rev.revision, criterionId: r.id, position: r.position,
      text: r.text, textHash: r.textHash, section: r.section, checks: r.checks, screens: r.screens, replaces: r.replaces,
    }))).onConflictDoNothing();
  }
  await db.update(specRevisions).set({ criteriaCount: recs.length })
    .where(and(eq(specRevisions.id, rev.id), isNull(specRevisions.criteriaCount)));
  return recs;
}

type SpecKey = { id: string; bodyArtifactId: string };

/**
 * The records of a spec's revisions, by revision number (default: all of
 * them), deriving any revision not derived yet from its body. `bodies` are
 * texts the caller already read, by revision number, so they are not read again.
 */
export async function recordsByRevision(spec: SpecKey, opts: { revisions?: readonly number[]; bodies?: ReadonlyMap<number, string> } = {}): Promise<Map<number, StoredCriterion[]>> {
  const want = opts.revisions?.filter((n) => n >= 1);
  if (want && want.length === 0) return new Map();
  const revs = await db.select({ id: specRevisions.id, revision: specRevisions.revision, artifactRevision: specRevisions.artifactRevision, contentHash: specRevisions.contentHash, criteriaCount: specRevisions.criteriaCount })
    .from(specRevisions)
    .where(and(eq(specRevisions.specId, spec.id), ...(want ? [inArray(specRevisions.revision, [...want])] : [])));
  const missing = revs.filter((r) => r.criteriaCount === null);
  if (missing.length) {
    const unread = missing.filter((r) => !opts.bodies?.has(r.revision));
    const read = unread.length ? await getArtifactRevisions(spec.bodyArtifactId, [...new Set(unread.map((r) => r.artifactRevision))]) : new Map();
    for (const r of missing) {
      const given = opts.bodies?.get(r.revision);
      const art = read.get(r.artifactRevision);
      const body = given ?? (art && typeof art.content === 'string' && art.contentHash === r.contentHash ? art.content : null);
      // A body that cannot be read or fails its hash is left underived, never guessed.
      if (body !== null) await writeCriterionRecords(spec.id, r, body);
    }
  }
  const rows = await db.select().from(specCriterionRecords)
    .where(and(eq(specCriterionRecords.specId, spec.id), ...(want ? [inArray(specCriterionRecords.revision, [...want])] : [])))
    .orderBy(asc(specCriterionRecords.revision), asc(specCriterionRecords.position));
  const out = new Map<number, StoredCriterion[]>(revs.map((r) => [r.revision, []]));
  for (const row of rows) out.get(row.revision)?.push(row);
  return out;
}

/** The text hashes of one revision's criteria, by id; derived from its body when not stored yet. */
export async function revisionCriterionHashes(specId: string, revision: number): Promise<Map<string, string>> {
  if (!isUuid(specId)) return new Map();
  const [spec] = await db.select({ id: specs.id, bodyArtifactId: specs.bodyArtifactId }).from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec) return new Map();
  const recs = (await recordsByRevision(spec, { revisions: [revision] })).get(revision) ?? [];
  return new Map(recs.map((r) => [r.criterionId, r.textHash]));
}

/**
 * The ids `next` reuses after they were retired (R-14): an id absent from the
 * head that an earlier revision had, now with different words. Each with the
 * revision that retired it (the first one without it). Same words is a
 * restore, not a reuse.
 */
export function reusedIds(history: ReadonlyMap<number, ReadonlyArray<Pick<StoredCriterion, 'criterionId' | 'textHash'>>>, head: number, next: ReadonlyArray<Pick<HashedRecord, 'id' | 'textHash'>>): Array<{ id: string; retiredIn: number }> {
  const inHead = new Set((history.get(head) ?? []).map((r) => r.criterionId));
  const last = new Map<string, { revision: number; textHash: string }>();
  for (const [n, recs] of [...history].sort((a, b) => a[0] - b[0])) {
    if (n > head) continue;
    for (const r of recs) last.set(r.criterionId, { revision: n, textHash: r.textHash });
  }
  const out: Array<{ id: string; retiredIn: number }> = [];
  for (const r of next) {
    const seen = last.get(r.id);
    if (!seen || inHead.has(r.id) || seen.textHash === r.textHash) continue;
    out.push({ id: r.id, retiredIn: seen.revision + 1 });
  }
  return out;
}

/** The next unused number per kind, given every id a spec has had and the ones about to be written. */
function nextFree(kind: string, ids: Iterable<string>): string {
  let max = 0;
  for (const id of ids) {
    const m = /^([A-Z]+)-(\d+)$/.exec(id);
    if (m && m[1] === kind) max = Math.max(max, Number(m[2]));
  }
  return `${kind}-${max + 1}`;
}

/** R-14's refusal in one line, naming the revision that retired each reused id; null when nothing is reused. */
export function reuseRefusalText(reused: ReadonlyArray<{ id: string; retiredIn: number }>, allIds: Iterable<string>): string | null {
  if (!reused.length) return null;
  const ids = [...allIds];
  const what = reused.map((r) => `${r.id} was retired in revision ${r.retiredIn}`).join(', ');
  const free = [...new Set(reused.map((r) => r.id.split('-')[0]!))].map((k) => nextFree(k, ids)).join(', ');
  return `${what}, and an id is never reused: give ${reused.length === 1 ? 'that criterion a new id' : 'those criteria new ids'} (the next free: ${free}), or restore the old text unchanged. Nothing was written.`;
}

/** The refusal for a revise of `spec` (head `head`) to `body`, or null when it reuses no retired id. */
export async function retiredIdRefusal(spec: SpecKey, head: number, body: string): Promise<string | null> {
  const next = hashedRecords(body);
  if (!next.length) return null;
  const history = await recordsByRevision(spec);
  const reused = reusedIds(history, head, next);
  return reuseRefusalText(reused, [...[...history.values()].flat().map((r) => r.criterionId), ...next.map((r) => r.id)]);
}

export interface CriterionHistoryEntry {
  /** The id this wording was under: the criterion itself, or one it replaces. */
  criterionId: string;
  revision: number;
  kind: 'added' | 'changed' | 'restored';
  text: string;
  textHash: string;
  section: string;
  changeSummary: string | null;
  author: 'person' | 'agent';
  /** Some approved revision carried exactly this wording. */
  approved: boolean;
}

export interface CriterionHistory {
  criterionId: string;
  /** Every revision in which its words (or those of a criterion it replaces) changed, oldest first. */
  entries: CriterionHistoryEntry[];
  /** The ids it replaces, its own `replaces:` and theirs. */
  replaces: string[];
  /** The first revision without it, when the head no longer has it. */
  retiredIn: number | null;
  /** A later criterion that replaces it. */
  replacedBy: string | null;
  head: number;
}

type RevisionMeta = { revision: number; changeSummary: string | null; authorKind: 'user' | 'agent'; approvedAt: Date | null };

/**
 * A criterion's history (R-12, R-15) from the records: each revision where
 * its words changed, and, through `replaces:`, the history of the criteria it
 * replaced. Null when the spec never had the id.
 */
export function criterionHistoryOf(criterionId: string, history: ReadonlyMap<number, ReadonlyArray<StoredCriterion>>, revisions: ReadonlyArray<RevisionMeta>): CriterionHistory | null {
  const ordered = [...history].sort((a, b) => a[0] - b[0]);
  const head = Math.max(0, ...revisions.map((r) => r.revision));
  const byId = (id: string) => ordered.map(([n, recs]) => ({ n, rec: recs.find((r) => r.criterionId === id) ?? null }));
  if (!ordered.some(([, recs]) => recs.some((r) => r.criterionId === criterionId))) return null;

  // The lineage: this id, then every id its records replace, transitively.
  const lineage: string[] = [criterionId];
  for (let i = 0; i < lineage.length; i++) {
    for (const [, recs] of ordered) for (const r of recs) if (r.criterionId === lineage[i]) for (const x of r.replaces) if (!lineage.includes(x)) lineage.push(x);
  }
  const meta = new Map(revisions.map((r) => [r.revision, r]));
  const approvedWordings = new Set<string>();
  for (const [n, recs] of ordered) if (meta.get(n)?.approvedAt) for (const r of recs) approvedWordings.add(`${r.criterionId}:${r.textHash}`);

  const entries: CriterionHistoryEntry[] = [];
  for (const id of lineage) {
    let prev: StoredCriterion | null = null;
    let ever = false;
    for (const { n, rec } of byId(id)) {
      if (rec && (!prev || prev.textHash !== rec.textHash)) {
        const m = meta.get(n);
        entries.push({
          criterionId: id, revision: n, kind: !ever ? 'added' : prev ? 'changed' : 'restored',
          text: rec.text, textHash: rec.textHash, section: rec.section,
          changeSummary: m?.changeSummary ?? null, author: m?.authorKind === 'user' ? 'person' : 'agent',
          approved: approvedWordings.has(`${id}:${rec.textHash}`),
        });
        ever = true;
      }
      prev = rec;
    }
  }
  entries.sort((a, b) => a.revision - b.revision || lineage.indexOf(b.criterionId) - lineage.indexOf(a.criterionId));

  const own = byId(criterionId);
  const lastSeen = [...own].reverse().find((x) => x.rec)!;
  const retiredIn = (history.get(head) ?? []).some((r) => r.criterionId === criterionId) ? null : lastSeen.n + 1;
  let replacedBy: string | null = null;
  for (const [, recs] of ordered) for (const r of recs) if (r.criterionId !== criterionId && r.replaces.includes(criterionId)) replacedBy ??= r.criterionId;
  return { criterionId, entries, replaces: lineage.slice(1), retiredIn, replacedBy, head };
}

/** One spec's criterion history, for a reader who already reached the spec. */
export async function readCriterionHistory(spec: SpecKey, criterionId: string): Promise<CriterionHistory | null> {
  const [history, revisions] = await Promise.all([
    recordsByRevision(spec),
    db.select({ revision: specRevisions.revision, changeSummary: specRevisions.changeSummary, authorKind: specRevisions.authorKind, approvedAt: specRevisions.approvedAt })
      .from(specRevisions).where(eq(specRevisions.specId, spec.id)),
  ]);
  return criterionHistoryOf(criterionId, history, revisions);
}

/**
 * What a task pin records about the wording it answers for (R-13): each
 * in-scope criterion's text hash on the pinned revision. Fail-open: a pin is
 * never refused because the hashes could not be read; it then carries none.
 */
export async function pinCriterionHashes(specId: string, revision: number, scope?: unknown): Promise<Record<string, string> | undefined> {
  try {
    const all = await revisionCriterionHashes(specId, revision);
    const ids = Array.isArray(scope) && scope.length ? new Set(scope.filter((x): x is string => typeof x === 'string')) : null;
    const out = Object.fromEntries([...all].filter(([id]) => !ids || ids.has(id)));
    return Object.keys(out).length ? out : undefined;
  } catch (err) {
    console.warn(`[specs] criterion hashes for the pin on ${specId} revision ${revision} could not be read:`, err);
    return undefined;
  }
}

import { db } from '@buildd/core/db';
import { knowledgeIngestJobs, specNeighbors, specs, tasks, workers } from '@buildd/core/db/schema';
import { and, desc, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';

/**
 * A Living Spec's neighbours (living-specs.md §14, decisions D-11/D-12): the
 * specs near it, by meaning (`similar`), by the files their work changed
 * (`shares_files`), or by criteria judged to mean the same (`overlaps`, which
 * the duplicate check writes through `replaceSpecNeighbours`).
 *
 * Derived, never authoritative: each (spec, kind) is replaced whole on every
 * recompute, every row says where it came from, and nothing that approves,
 * pins or grades work reads this table. Computed after an approval (fail-open,
 * off the response) and refreshed daily, so a spec approved later shows up as
 * a neighbour of older ones without anyone re-approving them.
 */

export const NEIGHBOUR_KINDS = ['similar', 'shares_files', 'overlaps'] as const;
export type NeighbourKind = (typeof NEIGHBOUR_KINDS)[number];

export const MAX_SIMILAR = 5;
/** Cosine floor for `similar` when an embedder answered; below it, two specs are only in the same product. */
export const SIMILAR_FLOOR = 0.55;
export const MAX_SHARES_FILES = 5;
/** A path manifest entry that names a pattern, not a file, says nothing about overlap. */
const isPattern = (p: string) => /[*?[\]{}]/.test(p) || p.endsWith('/');

export interface NeighbourRow {
  neighborSpecId: string;
  score: number;
  source: string;
  detail?: Record<string, unknown> | null;
}

/** Replace one kind of a spec's neighbours with `rows`. The only writer, for every kind. */
export async function replaceSpecNeighbours(workspaceId: string, specId: string, kind: NeighbourKind, rows: readonly NeighbourRow[]): Promise<void> {
  const keep = rows.filter((r) => r.neighborSpecId !== specId);
  await db.delete(specNeighbors).where(and(eq(specNeighbors.specId, specId), eq(specNeighbors.kind, kind)));
  if (keep.length === 0) return;
  await db.insert(specNeighbors).values(keep.map((r) => ({
    workspaceId, specId, neighborSpecId: r.neighborSpecId, kind,
    score: Math.max(0, Math.min(1, r.score)), source: r.source, detail: r.detail ?? null,
  }))).onConflictDoNothing();
}

/**
 * The files a spec's work changed: the merged PRs of tasks pinned to it, as
 * the knowledge ingest recorded them, else those tasks' declared path
 * manifests (patterns dropped). No GitHub call.
 */
export async function specFiles(workspaceId: string, specId: string): Promise<{ files: string[]; source: 'pr_files' | 'path_manifest' }> {
  const pinned = await db.select({ id: tasks.id, pathManifest: tasks.pathManifest }).from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), sql`${tasks.context}->'specSource'->>'specId' = ${specId}`));
  if (pinned.length === 0) return { files: [], source: 'path_manifest' };
  const merged = await db.select({ prNumber: workers.prNumber }).from(workers)
    .where(and(inArray(workers.taskId, pinned.map((t) => t.id)), isNotNull(workers.prNumber), isNotNull(workers.mergedAt)));
  const prs = [...new Set(merged.map((m) => m.prNumber!).filter((n) => Number.isInteger(n)))];
  if (prs.length > 0) {
    const jobs = await db.select({ changedFiles: knowledgeIngestJobs.changedFiles }).from(knowledgeIngestJobs)
      .where(and(eq(knowledgeIngestJobs.workspaceId, workspaceId), eq(knowledgeIngestJobs.trigger, 'pr_merged'),
        eq(knowledgeIngestJobs.status, 'done'), inArray(knowledgeIngestJobs.prNumber, prs)));
    const files = [...new Set(jobs.flatMap((j) => (Array.isArray(j.changedFiles) ? j.changedFiles : [])))].sort();
    if (files.length > 0) return { files, source: 'pr_files' };
  }
  const files = [...new Set(pinned.flatMap((t) => (Array.isArray(t.pathManifest) ? t.pathManifest : [])).filter((p) => typeof p === 'string' && !isPattern(p)))].sort();
  return { files, source: 'path_manifest' };
}

/** Specs whose files overlap, scored by the shared share of the smaller set. Pure. */
export function sharedFileNeighbours(
  mine: { files: readonly string[]; source: string },
  others: ReadonlyArray<{ specId: string; files: readonly string[]; source: string }>,
): NeighbourRow[] {
  const set = new Set(mine.files);
  if (set.size === 0) return [];
  return others
    .map((o) => {
      const shared = o.files.filter((f) => set.has(f));
      const source = mine.source === 'pr_files' && o.source === 'pr_files' ? 'pr_files' : 'path_manifest';
      return { neighborSpecId: o.specId, score: shared.length / Math.min(set.size, o.files.length || 1), source, detail: { files: shared.length, sample: shared.slice(0, 3) } };
    })
    .filter((r) => (r.detail.files as number) > 0)
    .sort((a, b) => b.score - a.score || (b.detail.files as number) - (a.detail.files as number))
    .slice(0, MAX_SHARES_FILES);
}

export type SimilarFn = (input: { workspaceId: string; specId: string; text: string }) => Promise<Array<{ specId: string; score: number; source: 'vector' | 'lexical' }>>;

/** Pick `similar` neighbours from raw hits: not itself, not its own parent or children, above the floor when scored by vector. Pure. */
export function pickSimilar(
  hits: ReadonlyArray<{ specId: string; score: number; source: 'vector' | 'lexical' }>,
  exclude: ReadonlySet<string>,
): NeighbourRow[] {
  return hits
    .filter((h) => !exclude.has(h.specId) && (h.source === 'lexical' || h.score >= SIMILAR_FLOOR))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SIMILAR)
    .map((h) => ({ neighborSpecId: h.specId, score: h.score, source: h.source }));
}

/**
 * How `similar` is answered. The knowledge module installs the spec-corpus
 * query (lib/specs/knowledge.ts, `installSpecSimilarity`, registered at boot
 * through modules.ts): core never imports the store. Until it is installed a
 * `similar` recompute fails and keeps its previous rows.
 */
export interface NeighbourDeps { similar: SimilarFn }
export const neighbourDeps: NeighbourDeps = {
  similar: async () => { throw new Error('no spec similarity provider is installed'); },
};

/**
 * Recompute a spec's `similar` and `shares_files` neighbours. Fail-open per
 * kind: a kind that cannot be computed keeps its previous rows and is named
 * in `errors`. `overlaps` is never touched here.
 */
export async function computeSpecNeighbours(specId: string, body: string | null): Promise<{ similar: number; sharesFiles: number; errors: string[] }> {
  const out = { similar: 0, sharesFiles: 0, errors: [] as string[] };
  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || spec.approvedRevision === null) return out;
  const relatives = await db.select({ id: specs.id }).from(specs)
    .where(and(eq(specs.workspaceId, spec.workspaceId), or(eq(specs.parentSpecId, specId), spec.parentSpecId ? eq(specs.id, spec.parentSpecId) : sql`false`)));
  const exclude = new Set([specId, ...relatives.map((r) => r.id)]);
  const approved = await db.select({ id: specs.id }).from(specs)
    .where(and(eq(specs.workspaceId, spec.workspaceId), isNotNull(specs.approvedRevision), ne(specs.id, specId)));
  const approvedIds = new Set(approved.map((a) => a.id));

  try {
    const hits = await neighbourDeps.similar({ workspaceId: spec.workspaceId, specId, text: `${spec.title}\n\n${body ?? ''}` });
    const rows = pickSimilar(hits.filter((h) => approvedIds.has(h.specId)), exclude);
    await replaceSpecNeighbours(spec.workspaceId, specId, 'similar', rows);
    out.similar = rows.length;
  } catch (err) {
    out.errors.push(`similar: ${(err as Error).message}`);
  }

  try {
    const mine = await specFiles(spec.workspaceId, specId);
    const others = await Promise.all([...approvedIds].map(async (id) => ({ specId: id, ...(await specFiles(spec.workspaceId, id)) })));
    const rows = sharedFileNeighbours(mine, others.filter((o) => !exclude.has(o.specId)));
    await replaceSpecNeighbours(spec.workspaceId, specId, 'shares_files', rows);
    out.sharesFiles = rows.length;
  } catch (err) {
    out.errors.push(`shares_files: ${(err as Error).message}`);
  }
  if (out.errors.length) console.error(`[living-specs] neighbours for spec ${specId} incomplete: ${out.errors.join('; ')}`);
  return out;
}

export interface NearbySpec {
  specId: string;
  title: string;
  kind: NeighbourKind;
  score: number;
  reason: string;
}

/** What a neighbour row says, in words. Pure. */
export function neighbourReason(kind: NeighbourKind, detail: Record<string, unknown> | null | undefined): string {
  if (kind === 'shares_files') {
    const n = typeof detail?.files === 'number' ? detail.files : 0;
    return n === 1 ? 'Changes a file this spec\'s work changed' : `Changes ${n} files this spec's work changed`;
  }
  if (kind === 'overlaps') {
    const pairs = Array.isArray(detail?.pairs) ? (detail!.pairs as Array<{ here?: string; there?: string }>) : [];
    const first = pairs.find((p) => typeof p.here === 'string' && typeof p.there === 'string');
    if (!first) return 'Has a criterion that means the same';
    return pairs.length > 1 ? `${first.here} here matches ${first.there} there, and ${pairs.length - 1} more` : `${first.here} here matches ${first.there} there`;
  }
  return 'Similar in what it asks for';
}

const KIND_ORDER: Record<NeighbourKind, number> = { overlaps: 0, shares_files: 1, similar: 2 };

/**
 * A spec's neighbours in both directions (a row written for either side
 * counts), one line per other spec at its strongest kind, at most `limit`.
 * Only specs in the same workspace.
 */
export async function readSpecNeighbours(specId: string, limit = 8): Promise<NearbySpec[]> {
  const rows = await db.select({
    specId: specNeighbors.specId, neighborSpecId: specNeighbors.neighborSpecId, kind: specNeighbors.kind,
    score: specNeighbors.score, detail: specNeighbors.detail, workspaceId: specNeighbors.workspaceId,
  }).from(specNeighbors)
    .where(or(eq(specNeighbors.specId, specId), eq(specNeighbors.neighborSpecId, specId)))
    .orderBy(desc(specNeighbors.score));
  if (rows.length === 0) return [];
  const best = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const other = r.specId === specId ? r.neighborSpecId : r.specId;
    if (other === specId) continue;
    const cur = best.get(other);
    if (!cur || KIND_ORDER[r.kind] < KIND_ORDER[cur.kind] || (r.kind === cur.kind && r.score > cur.score)) best.set(other, r);
  }
  const ids = [...best.keys()];
  const [self] = await db.select({ workspaceId: specs.workspaceId }).from(specs).where(eq(specs.id, specId)).limit(1);
  const titled = await db.select({ id: specs.id, title: specs.title, workspaceId: specs.workspaceId }).from(specs).where(inArray(specs.id, ids));
  const titles = new Map(titled.filter((t) => t.workspaceId === self?.workspaceId).map((t) => [t.id, t.title]));
  return ids
    .filter((id) => titles.has(id))
    .map((id) => {
      const r = best.get(id)!;
      // An `overlaps` row written from the other side names its criteria the other way round.
      const detail = r.kind === 'overlaps' && r.specId !== specId && Array.isArray(r.detail?.pairs)
        ? { ...r.detail, pairs: (r.detail!.pairs as Array<{ here?: string; there?: string }>).map((p) => ({ here: p.there, there: p.here })) }
        : r.detail;
      return { specId: id, title: titles.get(id)!, kind: r.kind, score: r.score, reason: neighbourReason(r.kind, detail) };
    })
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.score - a.score)
    .slice(0, limit);
}

/**
 * The parent a new or unfiled spec most likely belongs under (R-18): the
 * closest product or area spec by meaning, else the parent of the closest
 * approved spec that has one. Null when nothing is close. Never applied, only
 * offered.
 */
export async function suggestParent(workspaceId: string, specId: string, text: string): Promise<{ specId: string; title: string; reason: string } | null> {
  const hits = await neighbourDeps.similar({ workspaceId, specId, text });
  const ranked = hits.filter((h) => h.specId !== specId && (h.source === 'lexical' || h.score >= SIMILAR_FLOOR)).sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return null;
  const rows = await db.select({ id: specs.id, title: specs.title, scope: specs.scope, parentSpecId: specs.parentSpecId, workspaceId: specs.workspaceId })
    .from(specs).where(inArray(specs.id, ranked.map((h) => h.specId)));
  const byId = new Map(rows.filter((r) => r.workspaceId === workspaceId).map((r) => [r.id, r]));
  const area = ranked.map((h) => byId.get(h.specId)).find((r) => r && (r.scope === 'product' || r.scope === 'domain'));
  if (area) return { specId: area.id, title: area.title, reason: `Closest ${area.scope === 'product' ? 'product' : 'area'} by what it asks for` };
  const sibling = ranked.map((h) => byId.get(h.specId)).find((r) => r?.parentSpecId && r.parentSpecId !== specId);
  if (!sibling) return null;
  const [parent] = await db.select({ id: specs.id, title: specs.title, workspaceId: specs.workspaceId }).from(specs).where(eq(specs.id, sibling.parentSpecId!)).limit(1);
  if (!parent || parent.workspaceId !== workspaceId) return null;
  return { specId: parent.id, title: parent.title, reason: `Where "${sibling.title}", the closest spec, sits` };
}

import { db } from '@buildd/core/db';
import { specOutcomeVerdicts, specRevisions, specs, tasks } from '@buildd/core/db/schema';
import { and, asc, desc, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { after } from 'next/server';
import { specCriteria } from '@buildd/spec-contract/requirements';
import { scopeOf } from '@buildd/spec-contract/scope';
import { computeSpecNeighbours, neighbourDeps, readSpecNeighbours, replaceSpecNeighbours, specFiles, type SimilarFn } from './neighbours';
import type { KnowledgeStore, LivingSpecGraph, QueryParams, SpecMatch } from '@buildd/core/knowledge-store';
import { getArtifactRevision } from '@/lib/artifact-revisions';
import { appBaseUrl } from '@/lib/app-url';
import type { DuplicateCheck, DuplicateCheckInput } from './duplicates';

/**
 * Living Specs in the knowledge store's spec corpus (`{workspaceId}:spec`,
 * packages/core/knowledge-store/living-spec.ts): the approved revision as its
 * whole text, sections and criteria (R-102), the draft head marked draft
 * (R-106), and the graph of explicit references, edges derived from data buildd
 * holds and neighbours (§14, D-12). The approved text is indexed after a
 * person's approval commits; a draft after each revision is written; the
 * knowledge cron re-indexes what is missing or in the old shape and refreshes
 * neighbours and the graph without re-embedding.
 *
 * This corpus is the one source of spec similarity (R-101): `similar` and the
 * duplicate shortlist query it with the hybrid ranking recall uses, through
 * the store, and hold no embedder of their own.
 *
 * Fail-open: an approval or a revision has already happened when this runs,
 * so nothing here may throw. A failure is logged and reported in the result;
 * the spec stands, and the cron (or the backfill script) repairs it.
 */

type Store = Pick<KnowledgeStore, 'upsert' | 'query'> & Partial<Pick<KnowledgeStore, 'deleteBySource' | 'embedQueries'>>;

/** Overridable for tests: where chunks and graph go, and how after-response work is scheduled. */
export const specKnowledgeDeps: {
  /** The duplicate decision (§13), for `overlaps` neighbours. Default: the decisions module's slot. */
  duplicates?: (input: DuplicateCheckInput) => Promise<DuplicateCheck>;
  store: () => Promise<Store>;
  writeGraph: (input: { workspaceId: string; specId: string; namespace: string; graph: LivingSpecGraph; chunkIds: readonly string[] }) => Promise<unknown>;
  afterResponse: (task: () => Promise<unknown>) => void;
} = {
  async store() {
    const { PgVectorStore, getVoyageEmbedder } = await import('@buildd/core/knowledge-store');
    // The store recall reads: it picks the corpus's model itself, and is lexical-only when it has none.
    return new PgVectorStore(getVoyageEmbedder());
  },
  async writeGraph(input) {
    const { replaceLivingSpecGraph } = await import('@buildd/core/knowledge-store');
    return replaceLivingSpecGraph(input);
  },
  afterResponse: (task) => {
    const run = () => task().catch(() => {});
    // Outside a request (a script, a test) there is no response to wait for.
    try { after(run); } catch { void run(); }
  },
};

export interface SpecKnowledgeResult {
  indexed: boolean;
  chunks: number;
  graph: boolean;
  neighbours?: { similar: number; sharesFiles: number };
  /** Approved specs Jev judged a duplicate or an overlap of this one, at approval only (§13, §14). */
  overlaps?: number;
  skipped?: 'not_found' | 'not_approved';
  errors: string[];
}

export function specDashboardUrl(specId: string): string {
  return `${appBaseUrl()}/app/specs/${encodeURIComponent(specId)}`;
}

/**
 * `overlaps: false` (the cron's re-index): only the corpus, neighbours and
 * graph. The overlap decision is an approval's, so a re-index spends no model call.
 */
export async function indexApprovedSpec(specId: string, opts: { overlaps?: boolean } = {}): Promise<SpecKnowledgeResult> {
  const out: SpecKnowledgeResult = { indexed: false, chunks: 0, graph: false, errors: [] };
  try {
    const ks = await import('@buildd/core/knowledge-store');
    const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
    if (!spec) return { ...out, skipped: 'not_found' };
    if (spec.approvedRevision === null) return { ...out, skipped: 'not_approved' };
    const n = spec.approvedRevision;
    const [rev] = await db.select().from(specRevisions)
      .where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, n))).limit(1);
    if (!rev || !rev.approvedAt) return { ...out, skipped: 'not_approved' };
    const body = await getArtifactRevision(spec.bodyArtifactId, rev.artifactRevision);
    if (!body || typeof body.content !== 'string') throw new Error(`approved body (artifact revision ${rev.artifactRevision}) not readable`);

    const namespace = ks.buildNamespace(spec.workspaceId, 'spec');
    const chunks = await ks.buildLivingSpecChunks({
      specId, workspaceId: spec.workspaceId, title: spec.title, body: body.content, revision: n,
      contentHash: rev.contentHash, parentSpecId: spec.parentSpecId, scope: spec.scope,
      approvedAt: rev.approvedAt, sourceUrl: specDashboardUrl(specId),
    });

    try {
      const store = await specKnowledgeDeps.store();
      // Clear every approved chunk first (the earlier shape, `#<line>`, included): one approved text per spec.
      await store.deleteBySource?.(namespace, { sourceIdPrefix: ks.livingSpecChunkPrefix(specId) });
      if (chunks.length) await store.upsert(namespace, chunks);
      out.indexed = true;
      out.chunks = chunks.length;
    } catch (err) {
      out.errors.push(`chunks: ${(err as Error).message}`);
    }
    // The head is now approved text: its draft chunks go.
    const d = await indexSpecDraft(specId);
    for (const e of d.errors) out.errors.push(`draft: ${e}`);

    if (opts.overlaps !== false) await writeOverlaps(spec, body.content, out);
    await deriveAndWriteGraph(spec, rev, body.content, namespace, out.indexed ? chunks.map(c => c.id) : [], out);
  } catch (err) {
    out.errors.push((err as Error).message);
  }
  if (out.errors.length) console.error(`[living-specs] knowledge index for spec ${specId} incomplete: ${out.errors.join('; ')}`);
  return out;
}

type SpecRow = typeof specs.$inferSelect;

/**
 * `overlaps` neighbours (§14), from the duplicate decision (§13): the approved
 * spec against every other approved one in its workspace. At approval only, so
 * the daily refresh never spends a model call. A check that did not run keeps
 * the rows it had.
 */
async function writeOverlaps(spec: SpecRow, body: string, out: SpecKnowledgeResult): Promise<void> {
  try {
    const run = specKnowledgeDeps.duplicates ?? (await import('@/modules')).SPEC_DUPLICATE_CHECK;
    // Approved against approved: a draft is not yet something to overlap.
    const check = await run({ workspaceId: spec.workspaceId, title: spec.title, body, excludeSpecId: spec.id, drafts: false });
    if (!check.ran) return;
    const found = [...check.blocking, ...check.warnings];
    await replaceSpecNeighbours(spec.workspaceId, spec.id, 'overlaps', found.map((c) => ({
      neighborSpecId: c.specId, score: c.p, source: 'jev',
      detail: { relation: c.relation, ...(c.pairs?.length ? { pairs: c.pairs.map((x) => ({ here: x.here, there: x.there })) } : {}) },
    })));
    out.overlaps = found.length;
  } catch (err) {
    out.errors.push(`overlaps: ${(err as Error).message}`);
  }
}
type RevisionRow = typeof specRevisions.$inferSelect;

/** What the approved revision's work derived: pinned tasks, their criteria and passes, the files changed. */
async function derivedInputs(spec: SpecRow, rev: RevisionRow, body: string) {
  const criteria = specCriteria(body).map((c) => ({ id: c.id, text: c.text }));
  const pinned = await db.select({ id: tasks.id, title: tasks.title, context: tasks.context }).from(tasks)
    .where(and(eq(tasks.workspaceId, spec.workspaceId), sql`${tasks.context}->'specSource'->>'specRevisionId' = ${rev.id}`));
  const verdicts = pinned.length
    ? await db.select({ taskId: specOutcomeVerdicts.taskId, criterionId: specOutcomeVerdicts.criterionId, verdict: specOutcomeVerdicts.verdict, headSha: specOutcomeVerdicts.headSha })
      // Task outcomes only: a mission-level verdict (Slice 12) is not a task's.
      .from(specOutcomeVerdicts).where(and(eq(specOutcomeVerdicts.specRevisionId, rev.id), isNotNull(specOutcomeVerdicts.taskId))).orderBy(asc(specOutcomeVerdicts.createdAt))
    : [];
  const newest = new Map<string, (typeof verdicts)[number]>();
  for (const v of verdicts) newest.set(`${v.taskId}|${v.criterionId}`, v);
  const all = criteria.map((c) => c.id);
  const taskInputs = pinned.map((t) => {
    const src = (t.context as Record<string, unknown> | null)?.specSource as Record<string, unknown> | undefined;
    const scope = scopeOf(src ?? null);
    const answers = scope ?? all;
    const verified = answers.flatMap((id) => {
      const v = newest.get(`${t.id}|${id}`);
      return v && v.verdict === 'pass' && v.headSha ? [{ criterionId: id, headSha: v.headSha }] : [];
    });
    return { taskId: t.id, title: t.title, criteria: answers, verified };
  });
  const design = rev.design ? { kind: rev.design.kind, ref: rev.design.ref, version: rev.design.version } : null;
  const implementedIn = await specFiles(spec.workspaceId, spec.id);
  return { criteria, tasks: taskInputs, design, implementedIn };
}

async function deriveAndWriteGraph(spec: SpecRow, rev: RevisionRow, body: string, namespace: string, chunkIds: readonly string[], out: SpecKnowledgeResult): Promise<void> {
  // Neighbours first, so the graph's neighbour edges read this approval's set.
  try {
    const nb = await computeSpecNeighbours(spec.id, body);
    out.neighbours = { similar: nb.similar, sharesFiles: nb.sharesFiles };
    for (const e of nb.errors) out.errors.push(`neighbours: ${e}`);
  } catch (err) {
    out.errors.push(`neighbours: ${(err as Error).message}`);
  }
  try {
    const ks = await import('@buildd/core/knowledge-store');
    const n = rev.revision;
    const [parent] = spec.parentSpecId
      ? await db.select({ id: specs.id, title: specs.title }).from(specs)
        .where(and(eq(specs.id, spec.parentSpecId), eq(specs.workspaceId, spec.workspaceId))).limit(1)
      : [];
    const [prev] = await db.select({ revision: specRevisions.revision }).from(specRevisions)
      .where(and(eq(specRevisions.specId, spec.id), lt(specRevisions.revision, n), isNotNull(specRevisions.approvedAt)))
      .orderBy(desc(specRevisions.revision)).limit(1);
    let derived: Awaited<ReturnType<typeof derivedInputs>> & { neighbours?: Array<{ specId: string; title: string; score: number }> } | undefined;
    try {
      derived = await derivedInputs(spec, rev, body);
      derived.neighbours = (await readSpecNeighbours(spec.id, 20)).map((x) => ({ specId: x.specId, title: x.title, score: x.score }));
    } catch (err) {
      // The stored graph is still written without them.
      out.errors.push(`derived edges: ${(err as Error).message}`);
    }
    const graph = ks.buildLivingSpecGraph({
      workspaceId: spec.workspaceId, specId: spec.id, title: spec.title, revision: n,
      parent: parent ? { specId: parent.id, title: parent.title } : null,
      repoRefs: rev.repoRefs ?? [],
      previousApprovedRevision: prev?.revision ?? null,
      ...(derived ? { derived } : {}),
    });
    await specKnowledgeDeps.writeGraph({ workspaceId: spec.workspaceId, specId: spec.id, namespace, graph, chunkIds });
    out.graph = true;
  } catch (err) {
    out.errors.push(`graph: ${(err as Error).message}`);
  }
}

/**
 * The daily refresh of one approved spec: neighbours and the graph, without
 * re-chunking or re-embedding (the chunk ids are rebuilt from the same text to
 * keep their links). Fail-open like the index.
 */
export async function refreshSpecDerived(specId: string): Promise<SpecKnowledgeResult> {
  const out: SpecKnowledgeResult = { indexed: false, chunks: 0, graph: false, errors: [] };
  try {
    const ks = await import('@buildd/core/knowledge-store');
    const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
    if (!spec) return { ...out, skipped: 'not_found' };
    if (spec.approvedRevision === null) return { ...out, skipped: 'not_approved' };
    const [rev] = await db.select().from(specRevisions)
      .where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, spec.approvedRevision))).limit(1);
    if (!rev || !rev.approvedAt) return { ...out, skipped: 'not_approved' };
    const body = await getArtifactRevision(spec.bodyArtifactId, rev.artifactRevision);
    if (!body || typeof body.content !== 'string') throw new Error('approved body not readable');
    const chunks = await ks.buildLivingSpecChunks({
      specId, workspaceId: spec.workspaceId, title: spec.title, body: body.content, revision: rev.revision,
      contentHash: rev.contentHash, parentSpecId: spec.parentSpecId, scope: spec.scope,
      approvedAt: rev.approvedAt, sourceUrl: specDashboardUrl(specId),
    });
    await deriveAndWriteGraph(spec, rev, body.content, ks.buildNamespace(spec.workspaceId, 'spec'), chunks.map((c) => c.id), out);
  } catch (err) {
    out.errors.push((err as Error).message);
  }
  if (out.errors.length) console.error(`[living-specs] derived refresh for spec ${specId} incomplete: ${out.errors.join('; ')}`);
  return out;
}

/**
 * Index a spec's draft head (R-106): the head revision's text under the draft
 * prefix, marked draft, so a new draft is compared with other drafts. Recall
 * and `similar` never read it (the store leaves drafts out unless asked).
 * Clears the draft chunks when the head is approved or the spec is retired.
 * Fail-open.
 */
export async function indexSpecDraft(specId: string): Promise<{ indexed: boolean; chunks: number; errors: string[] }> {
  const out = { indexed: false, chunks: 0, errors: [] as string[] };
  try {
    const ks = await import('@buildd/core/knowledge-store');
    const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
    if (!spec) return out;
    const namespace = ks.buildNamespace(spec.workspaceId, 'spec');
    const store = await specKnowledgeDeps.store();
    await store.deleteBySource?.(namespace, { sourceIdPrefix: ks.livingSpecDraftChunkPrefix(specId) });
    if (spec.status === 'retired' || spec.status === 'superseded') return out;
    const [head] = await db.select().from(specRevisions)
      .where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, spec.headRevision))).limit(1);
    if (!head || head.approvedAt) return out;
    const body = await getArtifactRevision(spec.bodyArtifactId, head.artifactRevision);
    if (!body || typeof body.content !== 'string') throw new Error(`draft body (artifact revision ${head.artifactRevision}) not readable`);
    const chunks = await ks.buildLivingSpecChunks({
      specId, workspaceId: spec.workspaceId, title: spec.title, body: body.content, revision: head.revision,
      contentHash: head.contentHash, parentSpecId: spec.parentSpecId, scope: spec.scope,
      approvedAt: null, writtenAt: head.createdAt, draft: true, sourceUrl: specDashboardUrl(specId),
    });
    if (chunks.length) await store.upsert(namespace, chunks);
    out.indexed = true;
    out.chunks = chunks.length;
  } catch (err) {
    out.errors.push((err as Error).message);
    console.error(`[living-specs] draft index for spec ${specId} failed: ${(err as Error).message}`);
  }
  return out;
}

/** After a revision is written: index the draft head once the response is out. */
export function scheduleSpecDraftIndex(specId: string): void {
  specKnowledgeDeps.afterResponse(() => indexSpecDraft(specId));
}

const REINDEX_BATCH = 25;

/**
 * Bring the spec corpus to its current shape, once per spec: an approved spec
 * with no whole-text chunk for its approved revision (indexed before R-102, or
 * a failed index) is indexed again, and a draft head with no draft chunks is
 * indexed. Idempotent (a spec in shape is not selected again) and bounded by
 * `budgetMs` and a batch per run. On the knowledge cron, not a migration.
 */
export async function reindexSpecCorpus(budgetMs: number, opts: { workspaceId?: string; now?: () => number } = {}): Promise<{ reindexed: number; failed: number }> {
  const now = opts.now ?? Date.now;
  const started = now();
  const inWorkspace = opts.workspaceId ? sql`AND s.workspace_id = ${opts.workspaceId}::uuid` : sql``;
  // Random order: a spec that cannot be indexed (an unreadable body) never holds the batch for the rest.
  const approved = await db.execute(sql`
    SELECT s.id FROM specs s
    WHERE s.approved_revision IS NOT NULL ${inWorkspace}
      AND NOT EXISTS (SELECT 1 FROM knowledge_chunks kc
        WHERE kc.namespace = s.workspace_id::text || ':spec'
          AND kc.source_id = 'living-spec:' || s.id::text || '@' || s.approved_revision::text || '#text')
    ORDER BY random() LIMIT ${REINDEX_BATCH}`);
  const drafts = await db.execute(sql`
    SELECT s.id FROM specs s
    WHERE s.status NOT IN ('retired', 'superseded') ${inWorkspace}
      AND s.head_revision IS DISTINCT FROM s.approved_revision
      AND NOT EXISTS (SELECT 1 FROM knowledge_chunks kc
        WHERE kc.namespace = s.workspace_id::text || ':spec'
          AND kc.source_id = 'living-spec-draft:' || s.id::text || '@' || s.head_revision::text || '#text')
    ORDER BY random() LIMIT ${REINDEX_BATCH}`);
  const ids = (r: unknown) => ((r as { rows?: Array<{ id: string }> }).rows ?? []).map((x) => x.id);
  let reindexed = 0; let failed = 0;
  for (const id of ids(approved)) {
    if (now() - started > budgetMs) return { reindexed, failed };
    const r = await indexApprovedSpec(id, { overlaps: false });
    if (r.indexed && !r.errors.length) reindexed++; else failed++;
  }
  for (const id of ids(drafts)) {
    if (now() - started > budgetMs) break;
    const r = await indexSpecDraft(id);
    if (r.indexed) reindexed++; else failed++;
  }
  return { reindexed, failed };
}

/**
 * For the daily cron: first the corpus re-index (a third of the budget), then
 * every approved spec's neighbours and graph, oldest refresh first, within the rest.
 */
export async function refreshAllSpecDerived(budgetMs: number, now = Date.now): Promise<{ refreshed: number; failed: number; reindexed: number }> {
  const started = now();
  let reindexed = 0; let failed = 0;
  try {
    const r = await reindexSpecCorpus(Math.floor(budgetMs / 3), { now });
    reindexed = r.reindexed; failed += r.failed;
  } catch (err) {
    failed++;
    console.error(`[living-specs] spec corpus re-index failed: ${(err as Error).message}`);
  }
  const rows = await db.select({ id: specs.id }).from(specs).where(isNotNull(specs.approvedRevision)).orderBy(asc(specs.updatedAt)).limit(500);
  let refreshed = 0;
  for (const r of rows) {
    if (now() - started > budgetMs) break;
    const res = await refreshSpecDerived(r.id);
    if (res.errors.length) failed++; else refreshed++;
  }
  return { refreshed, failed, reindexed };
}

// ── Matching against the spec corpus (R-101, R-102, R-104) ───────────────────

/** Most probes one match sends, and how many hits each reads. */
const MAX_PROBES = 40;
const PROBE_TOP_K = 20;
const PROBE_CONCURRENCY = 6;
const PROBE_TEXT_CHARS = 4000;
export const SHORTLIST_SIZE = 5;

/** One piece of the asking spec. `chunkId`: its own stored chunk, so the store ranks by that chunk's embedding. */
interface SpecProbe { key: string; text: string; criterionId: string | null; chunkId?: string }

async function mapLimit<T, R>(items: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); }
  }));
  return out;
}

/**
 * Ask the spec corpus about each probe with the hybrid query recall uses
 * (vector and full text fused by rank), and fold the hits into specs. Free
 * text is embedded by the store in one batch; a probe naming its own stored
 * chunk is not embedded at all. Graph expansion is off: neighbour edges would
 * otherwise feed back into the neighbours they came from.
 */
async function matchSpecCorpus(input: { workspaceId: string; probes: readonly SpecProbe[]; excludeSpecId?: string; includeDrafts: boolean; limit: number }): Promise<SpecMatch[]> {
  const ks = await import('@buildd/core/knowledge-store');
  const probes = input.probes.slice(0, MAX_PROBES);
  if (probes.length === 0) return [];
  const store = await specKnowledgeDeps.store();
  const namespace = ks.buildNamespace(input.workspaceId, 'spec');
  const free = probes.filter((p) => !p.chunkId);
  const vectors = free.length && store.embedQueries ? await store.embedQueries(namespace, free.map((p) => p.text.slice(0, PROBE_TEXT_CHARS))) : null;
  const embeddingOf = new Map(free.map((p, i) => [p, vectors?.[i]]));
  const exclude = input.excludeSpecId ? [ks.livingSpecChunkPrefix(input.excludeSpecId), ks.livingSpecDraftChunkPrefix(input.excludeSpecId)] : undefined;
  const results = await mapLimit(probes, PROBE_CONCURRENCY, async (p) => {
    const params: QueryParams = {
      text: p.text.slice(0, PROBE_TEXT_CHARS), mode: 'hybrid', topK: PROBE_TOP_K,
      useGraph: false, trackHits: false, recencyAuthority: false, includeDrafts: input.includeDrafts,
      ...(exclude ? { excludeSourceIdPrefixes: exclude } : {}),
    };
    const vector = embeddingOf.get(p);
    if (p.chunkId) params.nearChunkId = p.chunkId;
    else if (vector) params.embedding = vector;
    return { probe: { key: p.key, criterionId: p.criterionId }, results: await store.query(namespace, params) };
  });
  return ks.aggregateSpecMatches(results, { limit: input.limit, excludeSpecId: input.excludeSpecId });
}

/** `similar` (§14, R-101, R-102): the spec's pieces against the corpus, approved text only. */
export const specCorpusSimilar: SimilarFn = async ({ workspaceId, specId, text, body, revision }) => {
  const ks = await import('@buildd/core/knowledge-store');
  const stored = typeof body === 'string' && typeof revision === 'number';
  const pieces = ks.livingSpecPieces(stored ? body! : text);
  const order = { text: 0, criterion: 1, section: 2 } as const;
  const probes: SpecProbe[] = [...pieces].sort((a, b) => order[a.kind] - order[b.kind]).map((p) => ({
    key: p.key, text: p.content, criterionId: p.criterionId ?? null,
    ...(stored ? { chunkId: `${ks.livingSpecChunkPrefix(specId)}@${revision}#${p.key}` } : {}),
  }));
  const matches = await matchSpecCorpus({ workspaceId, probes, excludeSpecId: specId, includeDrafts: false, limit: 30 });
  return matches.map((m) => ({ specId: m.specId, score: m.score, source: m.mode, pair: m.pairs[0] ? { here: m.pairs[0].here, there: m.pairs[0].there } : null, chunkIds: m.chunkIds }));
};

/**
 * The duplicate shortlist (§13, R-104): each criterion and section of the new
 * text (with `criteria`, a revise's added or changed criteria only) against
 * the corpus, by spec, at most SHORTLIST_SIZE. `drafts` compares with other
 * drafts too (R-106). It only picks what the model reads; it never decides.
 */
export async function specCorpusShortlist(input: { workspaceId: string; title: string; body: string; criteria?: readonly string[]; excludeSpecId?: string; drafts: boolean }): Promise<SpecMatch[]> {
  const ks = await import('@buildd/core/knowledge-store');
  const pieces = ks.livingSpecPieces(input.body);
  const only = input.criteria ? new Set(input.criteria) : null;
  let chosen = only
    ? pieces.filter((p) => p.kind === 'criterion' && only.has(p.key))
    : [...pieces.filter((p) => p.kind === 'criterion'), ...pieces.filter((p) => p.kind === 'section')];
  // A body with neither criteria nor sections is matched as a whole.
  if (!only && chosen.length === 0) chosen = pieces.filter((p) => p.kind === 'text').map((p) => ({ ...p, content: `${input.title}\n\n${p.content}` }));
  const probes = chosen.map((p) => ({ key: p.key, text: p.content, criterionId: p.criterionId ?? null }));
  return matchSpecCorpus({ workspaceId: input.workspaceId, probes, excludeSpecId: input.excludeSpecId, includeDrafts: input.drafts, limit: SHORTLIST_SIZE });
}

/** The knowledge module's hook into core neighbours: answer `similar` from the spec corpus. */
export function installSpecSimilarity(): void {
  neighbourDeps.similar = specCorpusSimilar;
}
// Installed whenever this module loads (the approval's index and the cron load it); boot installs it for the rest.
installSpecSimilarity();

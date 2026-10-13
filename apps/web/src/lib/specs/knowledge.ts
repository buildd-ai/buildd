import { db } from '@buildd/core/db';
import { specOutcomeVerdicts, specRevisions, specs, tasks } from '@buildd/core/db/schema';
import { and, asc, desc, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { specCriteria } from '@buildd/spec-contract/requirements';
import { scopeOf } from '@buildd/spec-contract/scope';
import { computeSpecNeighbours, neighbourDeps, readSpecNeighbours, specFiles, type SimilarFn } from './neighbours';
import type { KnowledgeStore, LivingSpecGraph } from '@buildd/core/knowledge-store';
import { getArtifactRevision } from '@/lib/artifact-revisions';
import { appBaseUrl } from '@/lib/app-url';

/**
 * Put a spec's approved revision into recall (corpus `spec`) and project its
 * explicit references into the knowledge graph (packages/core/knowledge-store/
 * living-spec.ts), with the edges derived from data buildd holds and its
 * neighbours (§14, D-12). Called after a person's approval commits, and by the
 * backfill script for specs approved before this existed. The daily refresh
 * (`refreshSpecDerived`) recomputes neighbours and the graph without
 * re-embedding.
 *
 * Fail-open: an approval has already happened when this runs, so nothing here
 * may throw. A failure is logged and reported in the result; the approval
 * stands, and running this again (the backfill) repairs it.
 */

type Store = Pick<KnowledgeStore, 'upsert'> & Partial<Pick<KnowledgeStore, 'deleteBySource'>>;

/** Overridable for tests: where chunks and graph go. */
export const specKnowledgeDeps: {
  store: () => Promise<Store>;
  writeGraph: (input: { workspaceId: string; specId: string; namespace: string; graph: LivingSpecGraph; chunkIds: readonly string[] }) => Promise<unknown>;
} = {
  async store() {
    const { PgVectorStore, getVoyageEmbedder } = await import('@buildd/core/knowledge-store');
    // The store picks the code-tuned model for the spec corpus itself; lexical-only without a key.
    return new PgVectorStore(getVoyageEmbedder());
  },
  async writeGraph(input) {
    const { replaceLivingSpecGraph } = await import('@buildd/core/knowledge-store');
    return replaceLivingSpecGraph(input);
  },
};

export interface SpecKnowledgeResult {
  indexed: boolean;
  chunks: number;
  graph: boolean;
  neighbours?: { similar: number; sharesFiles: number };
  skipped?: 'not_found' | 'not_approved';
  errors: string[];
}

export function specDashboardUrl(specId: string): string {
  return `${appBaseUrl()}/app/specs/${encodeURIComponent(specId)}`;
}

export async function indexApprovedSpec(specId: string): Promise<SpecKnowledgeResult> {
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
      // Clear every chunk of the previous approval first: one approved text per spec.
      await store.deleteBySource?.(namespace, { sourceIdPrefix: `${ks.livingSpecChunkPrefix(specId)}#` });
      if (chunks.length) await store.upsert(namespace, chunks);
      out.indexed = true;
      out.chunks = chunks.length;
    } catch (err) {
      out.errors.push(`chunks: ${(err as Error).message}`);
    }

    await deriveAndWriteGraph(spec, rev, body.content, namespace, out.indexed ? chunks.map(c => c.id) : [], out);
  } catch (err) {
    out.errors.push((err as Error).message);
  }
  if (out.errors.length) console.error(`[living-specs] knowledge index for spec ${specId} incomplete: ${out.errors.join('; ')}`);
  return out;
}

type SpecRow = typeof specs.$inferSelect;
type RevisionRow = typeof specRevisions.$inferSelect;

/** What the approved revision's work derived: pinned tasks, their criteria and passes, the files changed. */
async function derivedInputs(spec: SpecRow, rev: RevisionRow, body: string) {
  const criteria = specCriteria(body).map((c) => ({ id: c.id, text: c.text }));
  const pinned = await db.select({ id: tasks.id, title: tasks.title, context: tasks.context }).from(tasks)
    .where(and(eq(tasks.workspaceId, spec.workspaceId), sql`${tasks.context}->'specSource'->>'specRevisionId' = ${rev.id}`));
  const verdicts = pinned.length
    ? await db.select({ taskId: specOutcomeVerdicts.taskId, criterionId: specOutcomeVerdicts.criterionId, verdict: specOutcomeVerdicts.verdict, headSha: specOutcomeVerdicts.headSha })
      .from(specOutcomeVerdicts).where(eq(specOutcomeVerdicts.specRevisionId, rev.id)).orderBy(asc(specOutcomeVerdicts.createdAt))
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

/** Refresh every approved spec, oldest refresh first, within `budgetMs`. For the daily cron. */
export async function refreshAllSpecDerived(budgetMs: number, now = Date.now): Promise<{ refreshed: number; failed: number }> {
  const started = now();
  const rows = await db.select({ id: specs.id }).from(specs).where(isNotNull(specs.approvedRevision)).orderBy(asc(specs.updatedAt)).limit(500);
  let refreshed = 0; let failed = 0;
  for (const r of rows) {
    if (now() - started > budgetMs) break;
    const res = await refreshSpecDerived(r.id);
    if (res.errors.length) failed++; else refreshed++;
  }
  return { refreshed, failed };
}

/** Nearest approved specs in the workspace's spec corpus (§14 `similar`). Vector when an embedder is configured, else lexical. */
export const specCorpusSimilar: SimilarFn = async ({ workspaceId, text }) => {
  const ks = await import('@buildd/core/knowledge-store');
  const store = new ks.PgVectorStore(ks.getVoyageEmbedder());
  const results = await store.query(ks.buildNamespace(workspaceId, 'spec'), {
    text: text.slice(0, 4000), mode: 'hybrid', topK: 30, useGraph: false, trackHits: false, recencyAuthority: false,
  });
  const best = new Map<string, { score: number; source: 'vector' | 'lexical' }>();
  for (const r of results) {
    const id = (r.metadata as Record<string, unknown> | undefined)?.specId;
    if (typeof id !== 'string') continue;
    const dense = r.scoreBreakdown?.dense;
    const hit = typeof dense === 'number' ? { score: dense, source: 'vector' as const } : { score: Math.min(1, r.score), source: 'lexical' as const };
    if (!best.has(id) || best.get(id)!.score < hit.score) best.set(id, hit);
  }
  return [...best].map(([specId, v]) => ({ specId, ...v }));
};

/** The knowledge module's hook into core neighbours: answer `similar` from the spec corpus. */
export function installSpecSimilarity(): void {
  neighbourDeps.similar = specCorpusSimilar;
}
// Installed whenever this module loads (the approval's index and the cron load it); boot installs it for the rest.
installSpecSimilarity();

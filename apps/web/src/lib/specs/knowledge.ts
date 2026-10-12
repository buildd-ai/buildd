import { db } from '@buildd/core/db';
import { specRevisions, specs } from '@buildd/core/db/schema';
import { and, desc, eq, isNotNull, lt } from 'drizzle-orm';
import type { KnowledgeStore, LivingSpecGraph } from '@buildd/core/knowledge-store';
import { getArtifactRevision } from '@/lib/artifact-revisions';
import { appBaseUrl } from '@/lib/app-url';

/**
 * Put a spec's approved revision into recall (corpus `spec`) and project its
 * explicit references into the knowledge graph (packages/core/knowledge-store/
 * living-spec.ts). Called after a person's approval commits, and by the
 * backfill script for specs approved before this existed.
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

    try {
      const [parent] = spec.parentSpecId
        ? await db.select({ id: specs.id, title: specs.title }).from(specs)
          .where(and(eq(specs.id, spec.parentSpecId), eq(specs.workspaceId, spec.workspaceId))).limit(1)
        : [];
      const [prev] = await db.select({ revision: specRevisions.revision }).from(specRevisions)
        .where(and(eq(specRevisions.specId, specId), lt(specRevisions.revision, n), isNotNull(specRevisions.approvedAt)))
        .orderBy(desc(specRevisions.revision)).limit(1);
      const graph = ks.buildLivingSpecGraph({
        workspaceId: spec.workspaceId, specId, title: spec.title, revision: n,
        parent: parent ? { specId: parent.id, title: parent.title } : null,
        repoRefs: rev.repoRefs ?? [],
        previousApprovedRevision: prev?.revision ?? null,
      });
      await specKnowledgeDeps.writeGraph({ workspaceId: spec.workspaceId, specId, namespace, graph, chunkIds: out.indexed ? chunks.map(c => c.id) : [] });
      out.graph = true;
    } catch (err) {
      out.errors.push(`graph: ${(err as Error).message}`);
    }
  } catch (err) {
    out.errors.push((err as Error).message);
  }
  if (out.errors.length) console.error(`[living-specs] knowledge index for spec ${specId} incomplete: ${out.errors.join('; ')}`);
  return out;
}

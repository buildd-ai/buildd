/**
 * Assess KnowledgeStore retrieval quality on the LIVE corpus (single model).
 *
 * This is NOT a model bake-off — it measures absolute retrieval health for a
 * workspace's namespace: sample indexed chunks, use each chunk's own
 * title/first line as a query, and check whether that chunk comes back
 * (recall@k + MRR). High recall = embeddings + indexing are working and the
 * corpus is self-consistent; a sudden drop flags a broken embed/index/model.
 *
 * It's a proxy (self-retrieval), not labeled relevance — but it's the cheap,
 * dependency-free "is retrieval any good?" signal to run after a backfill.
 *
 * Usage:
 *   DATABASE_URL=... VOYAGE_API_KEY=... \
 *   bun packages/core/scripts/assess-knowledge.ts <workspaceId> [corpus] [sampleSize] [k]
 */
import { db } from '../db/index';
import { sql, eq } from 'drizzle-orm';
import { workspaces } from '../db/schema';
import { PgVectorStore, buildNamespace } from '../knowledge-store/pg-vector-store';
import { getVoyageEmbedder } from '../knowledge-store/voyage-embedder';
import { getVoyageReranker } from '../knowledge-store/reranker';
import type { Corpus } from '../knowledge-store/types';

/** Derive a realistic query from a chunk: first meaningful, de-marked-down line. */
function queryFromChunk(text: string): string {
  const lines = text
    .split('\n')
    .map(l => l.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
  return (lines[0] || text).slice(0, 200);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const jsonMode = rawArgs.includes('--json');
  const [workspaceId, corpusArg, sampleArg, kArg] = rawArgs.filter(a => !a.startsWith('--'));
  if (!workspaceId) {
    console.error('Usage: assess-knowledge.ts <workspaceId> [corpus=memory] [sampleSize=25] [k=5] [--json]');
    process.exit(1);
  }
  const corpus = (corpusArg || 'memory') as Corpus;
  const sampleSize = parseInt(sampleArg || '25', 10);
  const k = parseInt(kArg || '5', 10);

  const embedder = getVoyageEmbedder();
  if (!embedder) console.warn('[assess] VOYAGE_API_KEY not set — lexical-only assessment');
  const store = new PgVectorStore(embedder, getVoyageReranker());

  // Memory is team-scoped; resolve the team for the memory corpus. Other
  // corpora are workspace-scoped.
  let scopeId = workspaceId;
  if (corpus === 'memory') {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { teamId: true },
    });
    scopeId = ws?.teamId ?? workspaceId;
  }
  const ns = buildNamespace(scopeId, corpus);

  const sample = await db.execute(sql`
    SELECT source_id, content, lexical_text
    FROM knowledge_chunks
    WHERE namespace = ${ns}
    ORDER BY random()
    LIMIT ${sampleSize}
  `);
  const rows = sample.rows as Array<{ source_id: string; content: string; lexical_text: string | null }>;
  if (rows.length === 0) {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ namespace: ns, sample: 0, k, recall: 0, mrr: 0, skipped: 'namespace empty' }) + '\n');
    } else {
      console.log(`[assess] no chunks in namespace ${ns} — nothing to assess`);
    }
    process.exit(0);
  }

  let hits = 0;
  let mrrSum = 0;
  for (const r of rows) {
    const q = queryFromChunk(r.lexical_text || r.content);
    // trackHits: false — assessment runs must not pollute retrieval-hit stats
    const results = await store.query(ns, { text: q, topK: k, trackHits: false });
    const rank = results.findIndex(x => x.id === r.source_id);
    if (rank >= 0) {
      hits++;
      mrrSum += 1 / (rank + 1);
    }
  }

  const recall = hits / rows.length;
  const mrr = mrrSum / rows.length;
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ namespace: ns, sample: rows.length, k, recall, mrr }) + '\n');
  } else {
    console.log(`\n[assess] namespace=${ns}  sample=${rows.length}  k=${k}`);
    console.log(`  recall@${k}: ${(recall * 100).toFixed(1)}%   (fraction of items retrievable by their own title/first line)`);
    console.log(`  MRR@${k}:    ${mrr.toFixed(3)}   (mean reciprocal rank of the source chunk)`);
  }
  process.exit(0);
}

main().catch(err => {
  console.error('[assess] Error:', err);
  process.exit(1);
});

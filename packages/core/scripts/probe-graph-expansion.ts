/**
 * Probe: verify graph expansion adds chunks beyond the vector-only seed set.
 *
 * Runs the same query twice — useGraph=false vs useGraph=true — and reports
 * which chunks appear only in the expanded result set.
 *
 * Usage:
 *   DATABASE_URL=... bun packages/core/scripts/probe-graph-expansion.ts <workspaceId> [query]
 *
 * Example:
 *   DATABASE_URL=... bun packages/core/scripts/probe-graph-expansion.ts \
 *     57ffc0e4-1c4e-44b3-be63-6ef6cc8f1be6 \
 *     "processEntityRefs wires graph edges on complete_task"
 *
 * The default query targets a cross-file relationship:
 *   "processEntityRefs complete_task save chunk_entities edges wired MCP"
 * This is only fully answerable via a graph edge (task chunk → entity → code chunk).
 */

import { PgVectorStore, buildNamespace } from '../knowledge-store/pg-vector-store';
import type { Corpus } from '../knowledge-store/types';

const workspaceId = process.argv[2];
if (!workspaceId) {
  console.error('Usage: bun probe-graph-expansion.ts <workspaceId> [query] [corpus]');
  process.exit(1);
}

const QUERY = process.argv[3] ?? 'processEntityRefs complete_task save chunk_entities edges wired MCP';
const CORPUS = (process.argv[4] ?? 'task') as Corpus;
const ns = buildNamespace(workspaceId, CORPUS);

const ks = new PgVectorStore(null); // no embedder → lexical only, avoids Voyage key requirement

async function main() {
  console.log(`\nProbe: graph expansion on namespace ${ns}`);
  console.log(`Query : "${QUERY}"`);
  console.log(`Mode  : lexical (no embedder required)\n`);

  const [withoutGraph, withGraph] = await Promise.all([
    ks.query(ns, { text: QUERY, mode: 'lexical', topK: 10, useGraph: false, trackHits: false }),
    ks.query(ns, { text: QUERY, mode: 'lexical', topK: 10, useGraph: true,  trackHits: false }),
  ]);

  const seedIds   = new Set(withoutGraph.map(r => r.id));
  const expanded  = withGraph.filter(r => !seedIds.has(r.id));
  const promotion = withGraph.filter(r => seedIds.has(r.id) && r.graphProximity && r.graphProximity === 1.0);

  console.log(`Seed results  (useGraph=false): ${withoutGraph.length} chunks`);
  console.log(`Graph results (useGraph=true) : ${withGraph.length} chunks`);
  console.log(`Net new chunks from expansion : ${expanded.length}\n`);

  if (expanded.length > 0) {
    console.log('=== Expansion-only chunks (reachable ONLY via graph) ===');
    for (const r of expanded) {
      console.log(`  [${r.corpus}] ${r.sourcePath ?? r.id}  score=${r.score.toFixed(4)}  gp=${r.graphProximity?.toFixed(2) ?? '?'}`);
      console.log(`    ${r.content.slice(0, 120).replace(/\n/g, ' ')}…`);
    }
  } else {
    console.log('  No net-new chunks added by graph expansion for this query/corpus.');
    console.log('  This is expected when: (a) seed chunks have no chunk_entities entries,');
    console.log('  (b) those entities have no outgoing edges, or (c) neighbor chunks are');
    console.log('  already in the seed set (topK overlap).');
  }

  // Also probe chunk_entities and knowledge_edges row counts for this namespace
  const { db } = await import('../db/index');
  const { sql } = await import('drizzle-orm');

  const [ceRes, edgeRes] = await Promise.all([
    db.execute(sql`SELECT count(*)::int AS n FROM chunk_entities WHERE namespace = ${ns}`),
    db.execute(sql`SELECT count(*)::int AS n FROM knowledge_edges WHERE workspace_id = ${workspaceId}`),
  ]);

  const ceCount   = (ceRes.rows[0] as { n: number }).n;
  const edgeCount = (edgeRes.rows[0] as { n: number }).n;

  console.log(`\n=== Graph data for namespace ${ns} ===`);
  console.log(`  chunk_entities rows  : ${ceCount}`);
  console.log(`  knowledge_edges rows : ${edgeCount} (workspace-wide)`);

  if (ceCount === 0) {
    console.log('\n  WARNING: chunk_entities is empty — graph expansion can never fire.');
    console.log('  Run the entity-graph backfill: POST /api/admin/backfill-entity-graph');
    console.log('  or: DATABASE_URL=... bun packages/core/scripts/backfill-entity-graph.ts');
  }

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });

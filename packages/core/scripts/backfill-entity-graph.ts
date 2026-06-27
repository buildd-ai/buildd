/**
 * Idempotent entity-graph backfill over ALL existing knowledge_chunks.
 *
 * For each chunk this script:
 *   1. Extracts deterministic entity refs (file, PR, task, heading, wikilink)
 *   2. Upserts entities + aliases → knowledge_entities / entity_aliases
 *   3. Links chunk→entity in chunk_entities (enables graph-expansion on query)
 *   4. Persists rule-based edges → knowledge_edges (PR-ref, part_of, outcome_of, etc.)
 *   5. When --backfill-ts: sets source_ts column from metadata.source_ts where NULL
 *
 * All writes use ON CONFLICT DO NOTHING / DO UPDATE — fully idempotent.
 *
 * Namespace convention:  namespace = "{scopeId}:{corpus}"
 *   memory corpus: scopeId = teamId   (matches processEntityRefs usage in mcp-tools.ts)
 *   all others:    scopeId = workspaceId
 *
 * Usage:
 *   DATABASE_URL=... bun packages/core/scripts/backfill-entity-graph.ts
 *   DATABASE_URL=... bun packages/core/scripts/backfill-entity-graph.ts [namespacePrefix]
 *   DATABASE_URL=... bun packages/core/scripts/backfill-entity-graph.ts --dry-run
 *   DATABASE_URL=... bun packages/core/scripts/backfill-entity-graph.ts --backfill-ts
 *
 * namespacePrefix  optional: only process namespaces beginning with this string
 * --dry-run        count chunks + print plan without writing anything
 * --backfill-ts    also backfill source_ts column from metadata.source_ts where NULL
 */
import { db } from '../db/index';
import { sql } from 'drizzle-orm';
import { buildEdges, buildOutcomeOfEdge } from '../knowledge-store/edge-builder';
import {
  upsertEntity,
  upsertAlias,
  upsertChunkEntity,
  upsertEdge,
} from '../knowledge-store/entity-resolver';
import type { Corpus } from '../knowledge-store/types';

const BATCH_SIZE = 100;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const BACKFILL_TS = args.includes('--backfill-ts');
const NAMESPACE_PREFIX = args.find(a => !a.startsWith('--')) ?? null;

interface ChunkRow {
  source_id: string;
  namespace: string;
  corpus: string;
  source_type: string;
  source_path: string | null;
  content: string;
  metadata: Record<string, unknown>;
}

interface CountRow {
  count: string;
}

async function countTable(table: string): Promise<number> {
  const res = await db.execute(sql.raw(`SELECT count(*) AS count FROM ${table}`));
  return parseInt((res.rows[0] as CountRow).count, 10);
}

async function getNamespaces(): Promise<string[]> {
  let q = sql`SELECT DISTINCT namespace FROM knowledge_chunks ORDER BY namespace`;
  if (NAMESPACE_PREFIX) {
    q = sql`
      SELECT DISTINCT namespace FROM knowledge_chunks
      WHERE namespace LIKE ${NAMESPACE_PREFIX + '%'}
      ORDER BY namespace
    `;
  }
  const res = await db.execute(q);
  return (res.rows as Array<{ namespace: string }>).map(r => r.namespace);
}

async function getChunkCount(namespace: string): Promise<number> {
  const res = await db.execute(sql`
    SELECT count(*) AS count FROM knowledge_chunks WHERE namespace = ${namespace}
  `);
  return parseInt((res.rows[0] as CountRow).count, 10);
}

async function fetchBatch(namespace: string, limit: number, offset: number): Promise<ChunkRow[]> {
  const res = await db.execute(sql`
    SELECT source_id, namespace, corpus, source_type, source_path, content, metadata
    FROM knowledge_chunks
    WHERE namespace = ${namespace}
    ORDER BY source_id
    LIMIT ${limit} OFFSET ${offset}
  `);
  return res.rows as unknown as ChunkRow[];
}

async function backfillChunkTs(namespace: string): Promise<number> {
  const res = await db.execute(sql`
    UPDATE knowledge_chunks
    SET source_ts = (metadata->>'source_ts')::timestamptz
    WHERE namespace = ${namespace}
      AND source_ts IS NULL
      AND metadata->>'source_ts' IS NOT NULL
      AND (metadata->>'source_ts')::text ~ '^\d{4}-'
    RETURNING source_id
  `);
  return (res.rows as unknown[]).length;
}

async function processChunk(chunk: ChunkRow): Promise<{ entities: number; edges: number }> {
  const scopeId = chunk.namespace.split(':')[0];
  const corpus = chunk.corpus as Corpus;

  // Build edges (includes entity extraction internally)
  const { entities, edges } = buildEdges({
    chunk: {
      id: chunk.source_id,
      content: chunk.content,
      sourceType: chunk.source_type,
      sourcePath: chunk.source_path,
      metadata: chunk.metadata,
    },
    corpus,
    workspaceId: scopeId,
  });

  if (entities.length === 0 && edges.length === 0) {
    return { entities: 0, edges: 0 };
  }

  // Upsert entities and map kind:key → uuid
  const entityIdMap = new Map<string, string>();
  let entitiesWritten = 0;

  for (const entity of entities) {
    try {
      const entityId = await upsertEntity(db, entity);
      entityIdMap.set(`${entity.kind}:${entity.key}`, entityId);
      await upsertAlias(db, entityId, entity.key, 'system');
      if (entity.canonicalName !== entity.key) {
        await upsertAlias(db, entityId, entity.canonicalName, 'system');
      }
      if (entity.kind === 'file') {
        const bn = entity.key.split('/').pop();
        if (bn && bn !== entity.canonicalName && bn !== entity.key) {
          await upsertAlias(db, entityId, bn, 'system');
        }
      }
      await upsertChunkEntity(db, chunk.source_id, chunk.namespace, entityId, 'mentions');
      entitiesWritten++;
    } catch {
      // Best-effort; skip on FK or constraint error
    }
  }

  // Persist edges where both endpoints resolved
  let edgesWritten = 0;
  for (const edge of edges) {
    const fromId = entityIdMap.get(`${edge.fromEntityKind}:${edge.fromEntityKey}`);
    const toId = entityIdMap.get(`${edge.toEntityKind}:${edge.toEntityKey}`);
    if (!fromId || !toId) continue;
    try {
      await upsertEdge(
        db,
        scopeId,
        fromId,
        toId,
        edge.type,
        edge.weight,
        chunk.source_id,
        edge.rule,
      );
      edgesWritten++;
    } catch {
      // Best-effort
    }
  }

  // outcome_of edge: task/plan chunks with missionId → mission entity
  const missionId = chunk.metadata?.missionId;
  const taskId = chunk.metadata?.taskId;
  if (missionId && taskId && typeof missionId === 'string' && typeof taskId === 'string') {
    await buildOutcomeOfEdge(scopeId, taskId, missionId, chunk.source_id).catch(() => {});
  }

  return { entities: entitiesWritten, edges: edgesWritten };
}

async function backfillNamespace(
  namespace: string,
): Promise<{ chunks: number; entities: number; edges: number; tsBackfilled: number }> {
  const total = await getChunkCount(namespace);
  const corpus = namespace.split(':')[1];

  console.log(`[backfill] ${namespace} — ${total} chunk(s)`);

  let chunksDone = 0;
  let totalEntities = 0;
  let totalEdges = 0;
  let tsBackfilled = 0;

  if (!DRY_RUN && BACKFILL_TS) {
    tsBackfilled = await backfillChunkTs(namespace);
    if (tsBackfilled > 0) {
      console.log(`[backfill] ${namespace} — backfilled source_ts on ${tsBackfilled} chunks`);
    }
  }

  let offset = 0;
  while (offset < total) {
    const batch = await fetchBatch(namespace, BATCH_SIZE, offset);
    if (batch.length === 0) break;

    for (const chunk of batch) {
      if (!DRY_RUN) {
        const { entities, edges } = await processChunk(chunk);
        totalEntities += entities;
        totalEdges += edges;
      }
      chunksDone++;
    }

    offset += batch.length;
    process.stdout.write(
      `\r[backfill] ${namespace} — ${offset}/${total} chunks | ` +
      `${totalEntities} entities | ${totalEdges} edges`,
    );
  }

  console.log(); // newline after progress
  return { chunks: chunksDone, entities: totalEntities, edges: totalEdges, tsBackfilled };
}

async function main() {
  console.log('[backfill-entity-graph] Starting...');
  if (DRY_RUN) console.log('[backfill-entity-graph] DRY RUN — no writes');
  if (NAMESPACE_PREFIX) console.log(`[backfill-entity-graph] Filtering to namespace prefix: ${NAMESPACE_PREFIX}`);

  // Before counts
  const [entitiesBefore, edgesBefore, chunkEntitiesBefore] = await Promise.all([
    countTable('knowledge_entities'),
    countTable('knowledge_edges'),
    countTable('chunk_entities'),
  ]);

  console.log(`\n[before]`);
  console.log(`  knowledge_entities: ${entitiesBefore}`);
  console.log(`  knowledge_edges:    ${edgesBefore}`);
  console.log(`  chunk_entities:     ${chunkEntitiesBefore}`);
  console.log();

  const namespaces = await getNamespaces();
  console.log(`[backfill-entity-graph] ${namespaces.length} namespace(s) to process:`);
  for (const ns of namespaces) console.log(`  ${ns}`);
  console.log();

  let totalChunks = 0;
  let totalEntities = 0;
  let totalEdges = 0;
  let totalTsBackfilled = 0;

  for (const ns of namespaces) {
    const result = await backfillNamespace(ns);
    totalChunks += result.chunks;
    totalEntities += result.entities;
    totalEdges += result.edges;
    totalTsBackfilled += result.tsBackfilled;
  }

  // After counts
  const [entitiesAfter, edgesAfter, chunkEntitiesAfter] = await Promise.all([
    countTable('knowledge_entities'),
    countTable('knowledge_edges'),
    countTable('chunk_entities'),
  ]);

  console.log(`\n[after]`);
  console.log(`  knowledge_entities: ${entitiesAfter}  (+${entitiesAfter - entitiesBefore})`);
  console.log(`  knowledge_edges:    ${edgesAfter}  (+${edgesAfter - edgesBefore})`);
  console.log(`  chunk_entities:     ${chunkEntitiesAfter}  (+${chunkEntitiesAfter - chunkEntitiesBefore})`);
  if (BACKFILL_TS) {
    console.log(`  source_ts updated:  ${totalTsBackfilled}`);
  }

  console.log(`\n[backfill-entity-graph] Done.`);
  console.log(`  Processed: ${totalChunks} chunk(s) across ${namespaces.length} namespace(s)`);
  console.log(`  Entities written: ${totalEntities}`);
  console.log(`  Edges written:    ${totalEdges}`);

  process.exit(0);
}

main().catch(err => {
  console.error('[backfill-entity-graph] Fatal:', err);
  process.exit(1);
});

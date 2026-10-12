import { sql } from 'drizzle-orm';
import { upsertChunkEntity, upsertEdge, upsertEntity } from './entity-resolver';
import { LIVING_SPEC_RULE_PREFIX, livingSpecChunkPrefix, type LivingSpecGraph } from './living-spec';

async function getDb() {
  const { db } = await import('../db/index');
  return db;
}

/**
 * Replace one spec's derived graph: drop every edge this module wrote from the
 * spec or any of its revisions, and every chunk link to its chunks, then write
 * `graph` and link `chunkIds` to it. Idempotent, so an approval or a backfill
 * can run it again at any time. Edges other writers made are never touched:
 * only rules under `living_spec:` go.
 */
export async function replaceLivingSpecGraph(input: {
  workspaceId: string;
  specId: string;
  namespace: string;
  graph: LivingSpecGraph;
  chunkIds: readonly string[];
}): Promise<{ entities: number; edges: number }> {
  const db = await getDb();
  const { workspaceId, specId, namespace, graph } = input;

  await db.execute(sql`
    DELETE FROM knowledge_edges
    WHERE workspace_id = ${workspaceId}
      AND starts_with(rule, ${LIVING_SPEC_RULE_PREFIX})
      AND from_entity_id IN (
        SELECT id FROM knowledge_entities
        WHERE workspace_id = ${workspaceId}
          AND ((kind = 'spec' AND key = ${specId}) OR (kind = 'spec_revision' AND starts_with(key, ${`${specId}@`})))
      )
  `);
  await db.execute(sql`
    DELETE FROM chunk_entities
    WHERE namespace = ${namespace} AND starts_with(chunk_source_id, ${livingSpecChunkPrefix(specId)})
  `);

  const ids = new Map<string, string>();
  for (const e of graph.entities) {
    const k = `${e.kind}:${e.key}`;
    if (!ids.has(k)) ids.set(k, await upsertEntity(db, e));
  }
  let edges = 0;
  for (const e of graph.edges) {
    const from = ids.get(`${e.fromEntityKind}:${e.fromEntityKey}`);
    const to = ids.get(`${e.toEntityKind}:${e.toEntityKey}`);
    if (!from || !to) continue;
    await upsertEdge(db, workspaceId, from, to, e.type, e.weight, e.sourceChunkId, e.rule);
    edges++;
  }
  for (const link of graph.chunkLinks) {
    const entityId = ids.get(`${link.kind}:${link.key}`);
    if (!entityId) continue;
    for (const chunkId of input.chunkIds) await upsertChunkEntity(db, chunkId, namespace, entityId, link.role);
  }
  return { entities: ids.size, edges };
}

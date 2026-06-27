import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';

/**
 * POST /api/admin/backfill-entity-graph
 *
 * Runs an idempotent entity-graph backfill over all existing knowledge_chunks
 * (or a single namespace when ?namespace=... is provided). Populates:
 *   - knowledge_entities / entity_aliases (entity upsert + alias seeding)
 *   - chunk_entities (chunk→entity junction, enables graph-expansion on query)
 *   - knowledge_edges (rule-based edges: PR-ref, part_of, outcome_of, etc.)
 *
 * Processes chunks in pages of 100. Runs synchronously within the request so
 * the caller receives before/after counts in the response.
 *
 * Request body (optional):
 *   { namespace?: string, backfillTs?: boolean, dryRun?: boolean }
 *
 * Admin-level API key required.
 */

export const maxDuration = 300; // Vercel Pro: up to 300s

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (apiAccount && apiAccount.level !== 'admin') {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }

  let body: { namespace?: string; backfillTs?: boolean; dryRun?: boolean } = {};
  try { body = (await req.json().catch(() => ({}))) ?? {}; } catch { body = {}; }

  const { namespace: targetNamespace, backfillTs = false, dryRun = false } = body;

  const { sql } = await import('drizzle-orm');
  const { db } = await import('@buildd/core/db/index');
  const { buildEdges, buildOutcomeOfEdge } = await import('@buildd/core/knowledge-store/edge-builder');
  const {
    upsertEntity, upsertAlias, upsertChunkEntity, upsertEdge,
  } = await import('@buildd/core/knowledge-store/entity-resolver');
  type Corpus = import('@buildd/core/knowledge-store/types').Corpus;

  async function count(table: string): Promise<number> {
    const r = await db.execute(sql.raw(`SELECT count(*) AS c FROM ${table}`));
    return parseInt((r.rows[0] as { c: string }).c, 10);
  }

  // Before counts
  const [entBefore, edgeBefore, ceBefore] = await Promise.all([
    count('knowledge_entities'),
    count('knowledge_edges'),
    count('chunk_entities'),
  ]);

  // Discover namespaces
  const nsRes = targetNamespace
    ? { rows: [{ namespace: targetNamespace }] }
    : await db.execute(sql`SELECT DISTINCT namespace FROM knowledge_chunks ORDER BY namespace`);
  const namespaces = (nsRes.rows as Array<{ namespace: string }>).map(r => r.namespace);

  interface ChunkRow {
    source_id: string;
    namespace: string;
    corpus: string;
    source_type: string;
    source_path: string | null;
    content: string;
    metadata: Record<string, unknown>;
  }

  const BATCH = 100;
  let totalChunks = 0, totalEntities = 0, totalEdges = 0, totalTsFixed = 0;
  const namespaceStats: Record<string, { chunks: number; entities: number; edges: number }> = {};

  for (const ns of namespaces) {
    const countRes = await db.execute(sql`SELECT count(*) AS c FROM knowledge_chunks WHERE namespace = ${ns}`);
    const total = parseInt((countRes.rows[0] as { c: string }).c, 10);
    namespaceStats[ns] = { chunks: 0, entities: 0, edges: 0 };

    // Optional source_ts backfill from metadata
    if (!dryRun && backfillTs) {
      const tsRes = await db.execute(sql`
        UPDATE knowledge_chunks
        SET source_ts = (metadata->>'source_ts')::timestamptz
        WHERE namespace = ${ns}
          AND source_ts IS NULL
          AND metadata->>'source_ts' IS NOT NULL
          AND (metadata->>'source_ts') ~ '^[0-9]{4}-'
        RETURNING source_id
      `);
      totalTsFixed += (tsRes.rows as unknown[]).length;
    }

    let offset = 0;
    while (offset < total) {
      const batchRes = await db.execute(sql`
        SELECT source_id, namespace, corpus, source_type, source_path, content, metadata
        FROM knowledge_chunks
        WHERE namespace = ${ns}
        ORDER BY source_id
        LIMIT ${BATCH} OFFSET ${offset}
      `);
      const batch = batchRes.rows as unknown as ChunkRow[];
      if (batch.length === 0) break;

      for (const chunk of batch) {
        const scopeId = chunk.namespace.split(':')[0];
        const corpus = chunk.corpus as Corpus;

        if (!dryRun) {
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

          const entityIdMap = new Map<string, string>();

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
                if (bn && bn !== entity.key && bn !== entity.canonicalName) {
                  await upsertAlias(db, entityId, bn, 'system');
                }
              }
              await upsertChunkEntity(db, chunk.source_id, chunk.namespace, entityId, 'mentions');
              totalEntities++;
              namespaceStats[ns].entities++;
            } catch { /* best-effort */ }
          }

          for (const edge of edges) {
            const fromId = entityIdMap.get(`${edge.fromEntityKind}:${edge.fromEntityKey}`);
            const toId = entityIdMap.get(`${edge.toEntityKind}:${edge.toEntityKey}`);
            if (!fromId || !toId) continue;
            try {
              await upsertEdge(db, scopeId, fromId, toId, edge.type, edge.weight, chunk.source_id, edge.rule);
              totalEdges++;
              namespaceStats[ns].edges++;
            } catch { /* best-effort */ }
          }

          // outcome_of for task/plan chunks
          const missionId = chunk.metadata?.missionId;
          const taskId = chunk.metadata?.taskId;
          if (missionId && taskId && typeof missionId === 'string' && typeof taskId === 'string') {
            await buildOutcomeOfEdge(scopeId, taskId, missionId, chunk.source_id).catch(() => {});
          }
        }

        totalChunks++;
        namespaceStats[ns].chunks++;
      }

      offset += batch.length;
    }
  }

  const [entAfter, edgeAfter, ceAfter] = await Promise.all([
    count('knowledge_entities'),
    count('knowledge_edges'),
    count('chunk_entities'),
  ]);

  return NextResponse.json({
    dryRun,
    namespaces: namespaces.length,
    before: { knowledge_entities: entBefore, knowledge_edges: edgeBefore, chunk_entities: ceBefore },
    after:  { knowledge_entities: entAfter,  knowledge_edges: edgeAfter,  chunk_entities: ceAfter },
    delta:  {
      knowledge_entities: entAfter - entBefore,
      knowledge_edges:    edgeAfter - edgeBefore,
      chunk_entities:     ceAfter - ceBefore,
      source_ts_fixed:    totalTsFixed,
    },
    summary: { totalChunks, totalEntities, totalEdges },
    namespaceStats,
  });
}

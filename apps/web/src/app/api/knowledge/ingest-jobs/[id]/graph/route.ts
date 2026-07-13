/**
 * POST /api/knowledge/ingest-jobs/[id]/graph — persist a precise SCIP code
 * graph for a claimed `full`-scope ingest job (KM v2 spec §4, stream B2b).
 *
 * The runner computes a precise cross-file graph (`scip-typescript` → the pure
 * `scip-parser`) and transmits it here via `pushGraph`. We upsert its entities,
 * edges, and symbol aliases into the job's workspace namespace ADDITIVELY: the
 * parser tags every edge with a `scip:*` rule, so these layer on top of the
 * ast-grep (`astgrep:*`) edges built during file ingest and never delete them.
 * All writes are idempotent upserts, so re-running a job re-converges the graph.
 *
 * This is the server companion to `IngestGraphPayload` / `pushGraph` in
 * packages/core/knowledge-store/full-ingest.ts, and reuses the same
 * upsertEntity/upsertEdge/upsertAlias writers the ast-grep layer uses.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { authenticateApiKey } from '@/lib/api-auth';
import { getIngestAccessibleWorkspaceIds } from '@/lib/knowledge-ingest-access';

// A precise graph for a whole repo can be large, but the Vercel body cap
// (~4.5 MB) is the real limiter. Guard against pathological payloads by capping
// the total element count (entities + edges + aliases) → 413 when exceeded.
export const MAX_GRAPH_ELEMENTS = 200_000;

const ALIAS_SOURCES = new Set(['scip', 'system', 'agent', 'confirmed']);

interface GraphBody {
  entities?: unknown;
  edges?: unknown;
  aliases?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authHeader = req.headers.get('authorization');
  const account = await authenticateApiKey(authHeader?.replace('Bearer ', '') || null);
  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  let body: GraphBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ error: 'body must be an object' }, { status: 400 });
  }

  const entities = body.entities ?? [];
  const edges = body.edges ?? [];
  const aliases = body.aliases ?? [];
  if (!Array.isArray(entities) || !Array.isArray(edges) || !Array.isArray(aliases)) {
    return NextResponse.json(
      { error: 'entities, edges and aliases must be arrays' },
      { status: 400 },
    );
  }
  if (entities.length + edges.length + aliases.length > MAX_GRAPH_ELEMENTS) {
    return NextResponse.json(
      { error: `graph exceeds ${MAX_GRAPH_ELEMENTS} elements` },
      { status: 413 },
    );
  }

  const job = await db.query.knowledgeIngestJobs.findFirst({
    where: (jobs, { eq }) => eq(jobs.id, id),
  });
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }
  const accessible = await getIngestAccessibleWorkspaceIds(account.id);
  if (!accessible.has(job.workspaceId)) {
    return NextResponse.json({ error: 'No access to this workspace' }, { status: 403 });
  }
  if (job.status !== 'running') {
    return NextResponse.json({ error: `Job is ${job.status}, expected running` }, { status: 409 });
  }

  const workspaceId = job.workspaceId;

  try {
    // Dynamic import keeps this module light for route tests (the store pulls in
    // drizzle/pgvector machinery at load time) — same pattern as the files route.
    const { upsertEntity, upsertEdge, upsertAlias } = await import('@buildd/core/knowledge-store');

    // ── Entities: upsert and map (kind,key) → db id for edge/alias resolution.
    // workspaceId is always taken from the JOB, never trusted from the payload.
    const idByKey = new Map<string, string>();
    for (const raw of entities) {
      if (!isRecord(raw)) continue;
      const kind = raw.kind;
      const key = raw.key;
      const canonicalName = raw.canonicalName;
      if (!isNonEmptyString(kind) || !isNonEmptyString(key) || !isNonEmptyString(canonicalName)) {
        continue; // malformed sub-entry — skip, don't fail the batch
      }
      const attributes = isRecord(raw.attributes) ? raw.attributes : undefined;
      const entityId = await upsertEntity(db, {
        workspaceId,
        kind: kind as never,
        key,
        canonicalName,
        attributes,
      });
      idByKey.set(`${kind}:${key}`, entityId);
    }

    // ── Edges: resolve both endpoints via the entity map; skip unresolvable.
    let edgesWritten = 0;
    for (const raw of edges) {
      if (!isRecord(raw)) continue;
      const { fromEntityKind, fromEntityKey, toEntityKind, toEntityKey, type, rule } = raw;
      if (
        !isNonEmptyString(fromEntityKind) || !isNonEmptyString(fromEntityKey) ||
        !isNonEmptyString(toEntityKind) || !isNonEmptyString(toEntityKey) ||
        !isNonEmptyString(type) || !isNonEmptyString(rule)
      ) {
        continue;
      }
      const fromId = idByKey.get(`${fromEntityKind}:${fromEntityKey}`);
      const toId = idByKey.get(`${toEntityKind}:${toEntityKey}`);
      if (!fromId || !toId) continue; // endpoint not in this graph — skip
      const weight = typeof raw.weight === 'number' && Number.isFinite(raw.weight) ? raw.weight : 0.5;
      const sourceChunkId = isNonEmptyString(raw.sourceChunkId) ? raw.sourceChunkId : undefined;
      await upsertEdge(db, workspaceId, fromId, toId, type, weight, sourceChunkId, rule);
      edgesWritten++;
    }

    // ── Aliases: resolve the target entity via (kind,key); skip unresolvable.
    let aliasesWritten = 0;
    for (const raw of aliases) {
      if (!isRecord(raw)) continue;
      const { entityKind, entityKey, alias } = raw;
      if (!isNonEmptyString(entityKind) || !isNonEmptyString(entityKey) || !isNonEmptyString(alias)) {
        continue;
      }
      const entityId = idByKey.get(`${entityKind}:${entityKey}`);
      if (!entityId) continue;
      const source = (isNonEmptyString(raw.source) && ALIAS_SOURCES.has(raw.source)
        ? raw.source
        : 'scip') as 'scip' | 'system' | 'agent' | 'confirmed';
      await upsertAlias(db, entityId, alias, source);
      aliasesWritten++;
    }

    return NextResponse.json({ edges: edgesWritten, aliases: aliasesWritten });
  } catch (err) {
    console.error(`[knowledge-ingest] graph persist failed for job ${id}:`, err);
    return NextResponse.json({ error: 'Graph persist failed' }, { status: 500 });
  }
}

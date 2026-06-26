/**
 * Three-tier entity resolver (deterministic — no LLM):
 *   1. Exact match on entity.key (kind + normalized key)
 *   2. Alias table lookup (case-insensitive)
 *   3. pg_trgm fuzzy search returning candidates (not auto-bind)
 *
 * Unresolved refs are queued in pending_entity_refs.
 */

import { sql } from 'drizzle-orm';
import type { EntityRef, RelationRef, EntityBinding } from './types';
import type { ExtractedEntity } from './entity-extractor';

// ── DB accessor ───────────────────────────────────────────────────────────────

async function getDb() {
  const { db } = await import('../db/index');
  return db;
}

// ── Entity upsert ─────────────────────────────────────────────────────────────

export interface EntityUpsertInput {
  workspaceId: string;
  kind: string;
  key: string;
  canonicalName: string;
  attributes?: Record<string, unknown>;
}

/** Upsert a single entity. Returns its DB id. */
export async function upsertEntity(input: EntityUpsertInput): Promise<string> {
  const db = await getDb();
  const res = await db.execute(sql`
    INSERT INTO knowledge_entities (workspace_id, kind, key, canonical_name, attributes)
    VALUES (${input.workspaceId}, ${input.kind}, ${input.key}, ${input.canonicalName},
            ${JSON.stringify(input.attributes ?? {})}::jsonb)
    ON CONFLICT (workspace_id, kind, key) DO UPDATE
      SET canonical_name = EXCLUDED.canonical_name,
          last_seen_at   = NOW()
    RETURNING id
  `);
  return (res.rows[0] as { id: string }).id;
}

/** Upsert an alias for an entity. */
export async function upsertAlias(
  entityId: string,
  alias: string,
  source: string = 'system',
): Promise<void> {
  const db = await getDb();
  const normalised = alias.toLowerCase().trim();
  if (!normalised) return;
  await db.execute(sql`
    INSERT INTO entity_aliases (entity_id, alias, source)
    VALUES (${entityId}, ${normalised}, ${source})
    ON CONFLICT (entity_id, alias) DO NOTHING
  `);
}

/** Link a chunk to an entity in chunk_entities. */
export async function upsertChunkEntity(
  chunkSourceId: string,
  namespace: string,
  entityId: string,
  role: string = 'mentions',
): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    INSERT INTO chunk_entities (chunk_source_id, namespace, entity_id, role)
    VALUES (${chunkSourceId}, ${namespace}, ${entityId}, ${role})
    ON CONFLICT DO NOTHING
  `);
}

/** Queue an unresolved ref for later auto-heal. */
export async function queuePendingRef(
  workspaceId: string,
  rawRef: string,
  kindHint: string | null,
  sourceChunkId: string | null,
  source: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    INSERT INTO pending_entity_refs (workspace_id, raw_ref, kind_hint, source_chunk_id, source)
    VALUES (${workspaceId}, ${rawRef}, ${kindHint}, ${sourceChunkId}, ${source})
  `);
}

// ── Three-tier resolver ───────────────────────────────────────────────────────

interface ResolveResult {
  entityId: string | null;
  candidates: Array<{ id: string; key: string; canonicalName: string }>;
}

/** Tier 1: exact match on (workspaceId, kind, key). */
async function resolveExact(
  workspaceId: string,
  kind: string,
  key: string,
): Promise<string | null> {
  const db = await getDb();
  const res = await db.execute(sql`
    SELECT id FROM knowledge_entities
    WHERE workspace_id = ${workspaceId} AND kind = ${kind} AND key = ${key}
    LIMIT 1
  `);
  const row = res.rows[0] as { id: string } | undefined;
  return row?.id ?? null;
}

/** Tier 2: alias lookup (case-insensitive normalised). */
async function resolveByAlias(
  workspaceId: string,
  alias: string,
): Promise<string | null> {
  const db = await getDb();
  const normalised = alias.toLowerCase().trim();
  const res = await db.execute(sql`
    SELECT ea.entity_id
    FROM entity_aliases ea
    JOIN knowledge_entities ke ON ke.id = ea.entity_id
    WHERE ke.workspace_id = ${workspaceId}
      AND ea.alias = ${normalised}
    LIMIT 1
  `);
  const row = res.rows[0] as { entity_id: string } | undefined;
  return row?.entity_id ?? null;
}

/** Tier 3: pg_trgm fuzzy candidates (NOT auto-bound). */
async function resolveFuzzy(
  workspaceId: string,
  query: string,
  limit = 5,
): Promise<Array<{ id: string; key: string; canonicalName: string }>> {
  const db = await getDb();
  const q = query.toLowerCase().trim();
  const res = await db.execute(sql`
    SELECT ke.id, ke.key, ke.canonical_name
    FROM knowledge_entities ke
    JOIN entity_aliases ea ON ea.entity_id = ke.id
    WHERE ke.workspace_id = ${workspaceId}
      AND ea.alias % ${q}
    ORDER BY similarity(ea.alias, ${q}) DESC
    LIMIT ${limit}
  `);
  return (res.rows as Array<{ id: string; key: string; canonical_name: string }>).map(r => ({
    id: r.id,
    key: r.key,
    canonicalName: r.canonical_name,
  }));
}

/**
 * Resolve a single entity ref through the three-tier cascade.
 * Returns: { entityId } on exact/alias match, { candidates } for fuzzy, both null for unresolved.
 */
async function resolveOne(
  workspaceId: string,
  ref: EntityRef,
): Promise<ResolveResult> {
  // Tier 1: exact
  const exactId = await resolveExact(workspaceId, ref.kind, ref.ref);
  if (exactId) return { entityId: exactId, candidates: [] };

  // Tier 2: alias
  const aliasId = await resolveByAlias(workspaceId, ref.ref);
  if (aliasId) return { entityId: aliasId, candidates: [] };

  // Tier 3: fuzzy candidates
  const candidates = await resolveFuzzy(workspaceId, ref.ref);
  return { entityId: null, candidates };
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ResolveEntitiesInput {
  workspaceId: string;
  chunkSourceId: string;
  namespace: string;
  /** Extracted entities from entity-extractor (auto-bound). */
  extracted: ExtractedEntity[];
  /** Agent-supplied entity refs (resolver-mediated). */
  agentRefs?: EntityRef[];
  agentRelations?: RelationRef[];
  source?: string;
}

export interface ResolveEntitiesOutput {
  binding: EntityBinding;
}

/**
 * Resolve and persist all entity refs for a chunk.
 *
 * - Extracted entities (from entity-extractor) are upserted directly — they
 *   have authoritative keys and don't need resolution.
 * - Agent-supplied refs go through the three-tier resolver.
 * - Unresolved refs are queued in pending_entity_refs.
 *
 * Returns EntityBinding for caller feedback.
 */
export async function resolveAndPersistEntities(
  input: ResolveEntitiesInput,
): Promise<ResolveEntitiesOutput> {
  const { workspaceId, chunkSourceId, namespace } = input;
  let bound = 0;
  const ambiguous: EntityBinding['ambiguous'] = [];
  const unresolved: string[] = [];

  // 1. Upsert extracted (authoritative) entities
  for (const e of input.extracted) {
    try {
      const entityId = await upsertEntity({
        workspaceId,
        kind: e.kind,
        key: e.key,
        canonicalName: e.canonicalName,
      });
      // Seed aliases: canonical_name lowercase, basename for files
      await upsertAlias(entityId, e.key, 'system');
      if (e.canonicalName !== e.key) {
        await upsertAlias(entityId, e.canonicalName, 'system');
      }
      // For file entities, also alias the basename
      if (e.kind === 'file') {
        const basename = e.key.split('/').pop();
        if (basename && basename !== e.canonicalName) {
          await upsertAlias(entityId, basename, 'system');
        }
      }
      await upsertChunkEntity(chunkSourceId, namespace, entityId, e.role);
      bound++;
    } catch {
      // Non-fatal — best-effort entity persistence
    }
  }

  // 2. Resolve agent-supplied refs
  for (const ref of input.agentRefs ?? []) {
    try {
      const { entityId, candidates } = await resolveOne(workspaceId, ref);

      if (entityId) {
        await upsertChunkEntity(chunkSourceId, namespace, entityId, ref.role ?? 'mentions');
        bound++;
      } else if (candidates.length > 0) {
        ambiguous.push({ ref: ref.ref, candidates: candidates.map(c => c.canonicalName) });
        await queuePendingRef(workspaceId, ref.ref, ref.kind, chunkSourceId, input.source ?? 'agent');
      } else {
        unresolved.push(ref.ref);
        await queuePendingRef(workspaceId, ref.ref, ref.kind, chunkSourceId, input.source ?? 'agent');
      }
    } catch {
      unresolved.push(ref.ref);
    }
  }

  return { binding: { bound, ambiguous, unresolved } };
}

/**
 * Bulk-upsert extracted entities without chunk-entity linking.
 * Used during SCIP ingest to pre-populate the entity catalog.
 */
export async function upsertExtractedEntities(
  workspaceId: string,
  entities: ExtractedEntity[],
): Promise<Map<string, string>> {
  const keyToId = new Map<string, string>();
  for (const e of entities) {
    try {
      const id = await upsertEntity({ workspaceId, kind: e.kind, key: e.key, canonicalName: e.canonicalName });
      keyToId.set(`${e.kind}:${e.key}`, id);
      await upsertAlias(id, e.key, 'system');
      if (e.canonicalName !== e.key) await upsertAlias(id, e.canonicalName, 'system');
    } catch { /* best-effort */ }
  }
  return keyToId;
}

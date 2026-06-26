import { sql } from 'drizzle-orm';
import type { EntityKind, EntityUpsert, PendingRef } from './types';

async function getDb() {
  const { db } = await import('../db/index');
  return db;
}

type Db = Awaited<ReturnType<typeof getDb>>;

/**
 * Upsert an entity and return its DB uuid.
 * Uses INSERT ... ON CONFLICT DO UPDATE to handle the lastSeenAt refresh.
 */
export async function upsertEntity(db: Db, entity: EntityUpsert): Promise<string> {
  const res = await db.execute(sql`
    INSERT INTO knowledge_entities (workspace_id, kind, key, canonical_name, attributes)
    VALUES (
      ${entity.workspaceId},
      ${entity.kind},
      ${entity.key},
      ${entity.canonicalName},
      ${JSON.stringify(entity.attributes ?? {})}::jsonb
    )
    ON CONFLICT (workspace_id, kind, key) DO UPDATE SET
      canonical_name = EXCLUDED.canonical_name,
      last_seen_at   = NOW()
    RETURNING id
  `);
  return (res.rows[0] as { id: string }).id;
}

/**
 * Upsert an entity alias (for fuzzy resolution).
 */
export async function upsertAlias(
  db: Db,
  entityId: string,
  alias: string,
  source: 'scip' | 'system' | 'agent' | 'confirmed' = 'system',
): Promise<void> {
  await db.execute(sql`
    INSERT INTO entity_aliases (entity_id, alias, source)
    VALUES (${entityId}, ${alias.toLowerCase()}, ${source})
    ON CONFLICT (entity_id, alias) DO NOTHING
  `);
}

/**
 * Resolve a loose entity ref to a canonical entity ID using two-tier lookup:
 * 1. Exact match on (workspace_id, kind, key)
 * 2. Alias table lookup (case-insensitive)
 * Returns null if unresolved — caller should queue as pending_entity_ref.
 */
export async function resolveEntity(
  db: Db,
  workspaceId: string,
  ref: string,
  kindHint?: EntityKind,
): Promise<string | null> {
  const normalizedRef = ref.toLowerCase().trim();

  // Tier 1: exact key match
  const exactRes = await db.execute(sql`
    SELECT id FROM knowledge_entities
    WHERE workspace_id = ${workspaceId}
      AND key = ${normalizedRef}
      ${kindHint ? sql`AND kind = ${kindHint}` : sql``}
    LIMIT 1
  `);
  if (exactRes.rows.length > 0) return (exactRes.rows[0] as { id: string }).id;

  // Tier 2: alias lookup
  const aliasRes = await db.execute(sql`
    SELECT e.id
    FROM entity_aliases a
    JOIN knowledge_entities e ON e.id = a.entity_id
    WHERE e.workspace_id = ${workspaceId}
      AND a.alias = ${normalizedRef}
    LIMIT 1
  `);
  if (aliasRes.rows.length > 0) return (aliasRes.rows[0] as { id: string }).id;

  return null;
}

/**
 * Auto-heal: when a new entity is created, scan pending_entity_refs in the same
 * workspace and resolve any refs that now match this entity's key or canonical name.
 * Writes alias entries so future refs auto-bind.
 * Returns the number of pending refs resolved.
 */
export async function autoHealPendingRefs(
  db: Db,
  workspaceId: string,
  entityId: string,
  entityKey: string,
  canonicalName: string,
): Promise<number> {
  const normalizedKey = entityKey.toLowerCase();
  const normalizedName = canonicalName.toLowerCase();

  const pendingRes = await db.execute(sql`
    SELECT id, raw_ref
    FROM pending_entity_refs
    WHERE workspace_id = ${workspaceId}
      AND resolved_at IS NULL
      AND (
        lower(raw_ref) = ${normalizedKey}
        OR lower(raw_ref) = ${normalizedName}
      )
  `);

  const pendingRows = pendingRes.rows as Array<{ id: string; raw_ref: string }>;
  if (pendingRows.length === 0) return 0;

  for (const row of pendingRows) {
    await db.execute(sql`
      UPDATE pending_entity_refs
      SET resolved_at = NOW(),
          resolved_entity_id = ${entityId}
      WHERE id = ${row.id}
    `);
    // Write alias so future refs with this string auto-bind immediately
    await upsertAlias(db, entityId, row.raw_ref, 'confirmed');
  }

  return pendingRows.length;
}

/**
 * Insert a pending entity ref for an unresolved reference from agent or ingest.
 */
export async function insertPendingRef(db: Db, ref: PendingRef): Promise<void> {
  await db.execute(sql`
    INSERT INTO pending_entity_refs (workspace_id, raw_ref, kind_hint, source_chunk_id, source)
    VALUES (
      ${ref.workspaceId},
      ${ref.rawRef},
      ${ref.kindHint ?? null},
      ${ref.sourceChunkId ?? null},
      ${ref.source}
    )
  `);
}

/**
 * Upsert an edge between two entity IDs.
 * Uses INSERT ... ON CONFLICT DO UPDATE to refresh weight on re-encounter.
 */
export async function upsertEdge(
  db: Db,
  workspaceId: string,
  fromEntityId: string,
  toEntityId: string,
  type: string,
  weight: number,
  sourceChunkId: string | undefined,
  rule: string,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO knowledge_edges
      (workspace_id, from_entity_id, to_entity_id, type, weight, source_chunk_id, rule)
    VALUES (
      ${workspaceId},
      ${fromEntityId},
      ${toEntityId},
      ${type},
      ${weight.toFixed(4)},
      ${sourceChunkId ?? null},
      ${rule}
    )
    ON CONFLICT (workspace_id, from_entity_id, to_entity_id, type) DO UPDATE SET
      weight          = EXCLUDED.weight,
      source_chunk_id = EXCLUDED.source_chunk_id
  `);
}

/**
 * Link a chunk to an entity in chunk_entities junction table.
 */
export async function upsertChunkEntity(
  db: Db,
  chunkSourceId: string,
  namespace: string,
  entityId: string,
  role: 'defines' | 'references' | 'mentions',
): Promise<void> {
  await db.execute(sql`
    INSERT INTO chunk_entities (chunk_source_id, namespace, entity_id, role)
    VALUES (${chunkSourceId}, ${namespace}, ${entityId}, ${role})
    ON CONFLICT (chunk_source_id, namespace, entity_id, role) DO NOTHING
  `);
}

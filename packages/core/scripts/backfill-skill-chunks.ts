/**
 * Backfill enabled team/workspace skills into the `skill` corpus
 * (`{workspaceId}:skill`). No schema change; the namespace is free text.
 *
 * Per workspace: its own enabled skills plus the team-level enabled skills
 * (workspace_id NULL) that apply to it. Personal/private roles are never
 * indexed. A skill whose stored hash already matches is not re-embedded, so the
 * script is safe to re-run. Stale chunks (disabled or deleted skills) are
 * dropped.
 *
 * Usage:
 *   VOYAGE_API_KEY=... DATABASE_URL=... \
 *   bun packages/core/scripts/backfill-skill-chunks.ts [workspaceId] [--dry-run]
 */
import { db } from '../db/index';
import { workspaces, workspaceSkills } from '../db/schema';
import { and, eq, isNull, or } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { PgVectorStore, buildNamespace } from '../knowledge-store/pg-vector-store';
import { getVoyageEmbedder } from '../knowledge-store/voyage-embedder';
import { buildSkillChunk, isIndexableSkill, skillSourceId } from '../knowledge-store/skills';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const only = args.find((a) => !a.startsWith('--'));

async function storedHashes(namespace: string): Promise<Map<string, string | null>> {
  const res = await db.execute(sql`
    SELECT source_id, metadata->>'skillHash' AS h FROM knowledge_chunks
    WHERE namespace = ${namespace} AND is_current = true`);
  return new Map((res.rows as Array<{ source_id: string; h: string | null }>).map((r) => [r.source_id, r.h]));
}

async function main() {
  const store = new PgVectorStore(getVoyageEmbedder());
  const wsRows = await db.select({ id: workspaces.id, teamId: workspaces.teamId }).from(workspaces)
    .where(only ? eq(workspaces.id, only) : undefined);
  let indexed = 0; let unchanged = 0; let dropped = 0;

  for (const ws of wsRows) {
    const rows = await db.select().from(workspaceSkills).where(and(
      or(
        eq(workspaceSkills.workspaceId, ws.id),
        and(isNull(workspaceSkills.workspaceId), eq(workspaceSkills.teamId, ws.teamId)),
      ),
      isNull(workspaceSkills.ownerUserId),
    ));
    const namespace = buildNamespace(ws.id, 'skill');
    const stored = await storedHashes(namespace);
    const wanted = new Set<string>();

    for (const s of rows) {
      if (!isIndexableSkill(s)) continue;
      const chunk = buildSkillChunk(s);
      if (!chunk) continue;
      wanted.add(chunk.id);
      if (stored.get(chunk.id) === chunk.metadata!.skillHash) { unchanged++; continue; }
      if (dryRun) { console.log(`[dry-run] would index ${chunk.id} in ${ws.id}`); indexed++; continue; }
      await store.deleteBySource(namespace, { sourceIdPrefix: skillSourceId(s.id) });
      await store.upsert(namespace, [chunk]);
      indexed++;
    }
    for (const id of stored.keys()) {
      if (wanted.has(id)) continue;
      dropped++;
      if (!dryRun) await store.deleteBySource(namespace, { sourceIdPrefix: id });
    }
  }
  console.log(`[backfill-skills] workspaces=${wsRows.length} indexed=${indexed} unchanged=${unchanged} dropped=${dropped}${dryRun ? ' (dry run)' : ''}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

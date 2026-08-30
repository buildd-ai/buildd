/**
 * Migrate memories from the standalone memory service database into buildd's memories table.
 *
 * Reads from the memory service Postgres (MEMORY_DB_URL) and inserts into the buildd
 * Neon database (DATABASE_URL). Idempotent — rows whose UUID already exists are skipped.
 *
 * Both databases are Neon, so this uses the same HTTP driver as packages/core/db/client.ts
 * rather than a TCP client: 'postgres' was never a dependency of this repo, and port 5432 is
 * not reachable from every network an operator runs this from.
 *
 * Usage:
 *   MEMORY_DB_URL=postgres://... DATABASE_URL=postgres://... \
 *   bun packages/core/scripts/migrate-memory-service.ts [--dry-run]
 *
 * Options:
 *   --dry-run   Print what would be migrated; do not write anything.
 *
 * After running, inspect the reconciliation report:
 *   - Every memory row should have a corresponding current knowledge_chunk.
 *   - Rows under non-buildd team UUIDs are reported but not imported by default.
 *     Pass --include-external to import them too (they will have no team match).
 */

import { neon } from '@neondatabase/serverless';
import { db } from '../db/index';
import { memories, teams } from '../db/schema';
import { sql, inArray } from 'drizzle-orm';

/** db.execute() on the neon-http driver returns a result object, not a row array. */
function resultRows<T = Record<string, unknown>>(res: unknown): T[] {
  return ((res as { rows?: T[] }).rows ?? []);
}

const DRY_RUN = process.argv.includes('--dry-run');
const INCLUDE_EXTERNAL = process.argv.includes('--include-external');
const BATCH = 100;

const MEMORY_DB_URL = process.env.MEMORY_DB_URL;
if (!MEMORY_DB_URL) {
  console.error('[migrate] MEMORY_DB_URL is required — set it to the memory service Postgres connection string');
  process.exit(1);
}

interface ServiceMemory {
  id: string;
  team_id: string;
  type: string;
  title: string;
  content: string;
  project: string | null;
  tags: string[];
  files: string[];
  source: string | null;
  // The HTTP driver returns timestamps as strings, not Date objects.
  created_at: string | Date;
  updated_at: string | Date;
}

async function main() {
  const memDb = neon(MEMORY_DB_URL!);

  // Count source rows by team
  const sourceCounts = (await memDb`
    SELECT team_id, count(*) as cnt
    FROM memories
    GROUP BY team_id
    ORDER BY cnt DESC
  `) as unknown as { team_id: string; cnt: string }[];

  console.log('\n[migrate] Source row counts by team:');
  for (const r of sourceCounts) {
    console.log(`  ${r.team_id}: ${r.cnt} memories`);
  }
  console.log(`  Total: ${sourceCounts.reduce((s, r) => s + Number(r.cnt), 0)} memories\n`);

  // Identify known buildd teams
  const sourceTeamIds = [...new Set(sourceCounts.map(r => r.team_id))];
  const builddTeams = await db.query.teams.findMany({
    where: inArray(teams.id, sourceTeamIds),
    columns: { id: true },
  });
  const builddTeamSet = new Set(builddTeams.map(t => t.id));

  const externalTeamIds = sourceTeamIds.filter(id => !builddTeamSet.has(id));
  if (externalTeamIds.length > 0) {
    console.log('[migrate] External (non-buildd) team IDs found:');
    for (const id of externalTeamIds) {
      const cnt = sourceCounts.find(r => r.team_id === id)?.cnt ?? '0';
      console.log(`  ${id}: ${cnt} memories (skipping unless --include-external)`);
    }
    console.log();
  }

  const targetTeamIds = INCLUDE_EXTERNAL ? sourceTeamIds : [...builddTeamSet];

  if (targetTeamIds.length === 0) {
    console.log('[migrate] No matching buildd teams found. Exiting.');
    return;
  }

  let offset = 0;
  let imported = 0;
  let skipped = 0;

  // Count existing rows to detect idempotent re-run
  const [existingRes] = resultRows(await db.execute(sql`SELECT count(*) as n FROM memories`));
  const existingCount = Number((existingRes as any).n ?? 0);
  console.log(`[migrate] Existing rows in buildd memories table: ${existingCount}`);

  if (DRY_RUN) {
    console.log('[migrate] DRY RUN — no writes will occur\n');
  }

  while (true) {
    const rows = (await memDb`
      SELECT id, team_id, type, title, content, project, tags, files, source, created_at, updated_at
      FROM memories
      -- explicit ::text[]: the source column is text, and an inferred uuid[] parameter
      -- fails with "operator does not exist: text = uuid"
      WHERE team_id = ANY(${targetTeamIds}::text[])
      ORDER BY created_at ASC
      LIMIT ${BATCH} OFFSET ${offset}
    `) as unknown as ServiceMemory[];

    if (rows.length === 0) break;

    // Find which IDs already exist in buildd
    const ids = rows.map(r => r.id);
    const existing = resultRows<{ id: string }>(await db.execute(
      sql`SELECT id FROM memories WHERE id = ANY(${sql.raw(`ARRAY[${ids.map(id => `'${id.replace(/'/g, "''")}'`).join(',')}]::uuid[]`)})`,
    ));
    const existingIds = new Set(existing.map(r => r.id));

    const toInsert = rows.filter(r => !existingIds.has(r.id));
    skipped += rows.length - toInsert.length;

    if (toInsert.length > 0 && !DRY_RUN) {
      await db.insert(memories).values(
        toInsert.map(r => ({
          id: r.id,
          teamId: r.team_id,
          type: r.type as 'discovery' | 'decision' | 'gotcha' | 'pattern' | 'architecture' | 'summary',
          title: r.title,
          content: r.content,
          project: r.project,
          tags: r.tags ?? [],
          files: r.files ?? [],
          source: r.source,
          createdAt: new Date(r.created_at),
          updatedAt: new Date(r.updated_at),
        })),
      );
    }

    imported += toInsert.length;
    offset += rows.length;
    console.log(`[migrate] Processed ${offset} | imported: ${imported} | skipped (already exist): ${skipped}`);
  }

  // Reconciliation report
  const [finalRes] = resultRows(await db.execute(sql`SELECT count(*) as n FROM memories`));
  const finalCount = Number((finalRes as any).n ?? 0);

  // Check for memories without a current knowledge chunk
  const [chunkRes] = resultRows(await db.execute(sql`
    SELECT count(*) as n FROM memories m
    WHERE NOT EXISTS (
      SELECT 1 FROM knowledge_chunks kc
      -- knowledge_chunks.source_id is text, memories.id is uuid
      WHERE kc.source_id = m.id::text
        AND kc.is_current = true
    )
  `));
  const missingChunks = Number((chunkRes as any).n ?? 0);

  console.log('\n[migrate] Reconciliation report:');
  console.log(`  Source memories: ${sourceCounts.reduce((s, r) => s + Number(r.cnt), 0)}`);
  console.log(`  Buildd memories before: ${existingCount}`);
  console.log(`  Buildd memories after:  ${finalCount}`);
  console.log(`  Imported this run:  ${DRY_RUN ? `${imported} (dry run — not written)` : imported}`);
  console.log(`  Skipped (existed):  ${skipped}`);
  console.log(`  Memories without current chunk: ${missingChunks} (run backfill-knowledge-chunks.ts to repair)`);

  console.log('\n[migrate] Done.');
}

main().catch(err => {
  console.error('[migrate] Error:', err);
  process.exit(1);
});

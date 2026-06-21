/**
 * Wipe knowledge_chunks for a namespace, so a re-ingest starts clean.
 * (Skipping files on re-ingest does NOT remove their old chunks — reset first.)
 * Used by the spec-sync dev loop; safe for any namespace.
 *
 * Usage:
 *   DATABASE_URL=... bun packages/core/scripts/reset-knowledge-namespace.ts <workspaceId> [code|docs|all]
 */
import { db } from '../db/index';
import { sql } from 'drizzle-orm';

async function main() {
  const [workspaceId, which = 'all'] = process.argv.slice(2);
  if (!workspaceId) {
    console.error('Usage: reset-knowledge-namespace.ts <workspaceId> [code|docs|all]');
    process.exit(1);
  }
  const namespaces =
    which === 'all' ? [`${workspaceId}:code`, `${workspaceId}:docs`] : [`${workspaceId}:${which}`];
  for (const ns of namespaces) {
    const res: any = await db.execute(sql`DELETE FROM knowledge_chunks WHERE namespace = ${ns}`);
    console.log(`[reset] cleared namespace ${ns} (${res?.rowCount ?? '?'} rows)`);
  }
  process.exit(0);
}

main().catch(err => { console.error('[reset] Error:', err); process.exit(1); });

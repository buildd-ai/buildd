/**
 * Dedup the pr corpus: find chunks with identical content (same content_hash)
 * under different source_ids and archive the duplicates.
 *
 * Root cause: when the same file appears unchanged across multiple rebased PRs
 * (e.g. a design doc added in PR #1604 that also shows @@ -0,0 +1,N @@ in PRs
 * #1608 and #1609), the diff ingest job writes near-identical chunks for each
 * PR. They have different source_ids (`pr:1604#file` vs `pr:1608#file`) so the
 * ON CONFLICT constraint doesn't catch them — they accumulate as near-duplicates.
 *
 * Strategy: for each (namespace, content_hash) group with >1 distinct source_id,
 * keep the row with the EARLIEST source_ts (oldest PR wins — it introduced the
 * content first). Archive the rest by setting is_current=false.
 *
 * Idempotent: running it again finds no remaining duplicates (already archived
 * rows are excluded from the is_current=true query).
 *
 * Usage:
 *   DATABASE_URL=... WORKSPACE_ID=<uuid> \
 *   bun packages/core/scripts/dedup-pr-corpus.ts [--apply]
 *
 * Without --apply (default): reports duplicate groups, makes no changes.
 * With --apply: archives the losers (is_current=false, superseded_by=winner).
 */
import { db } from '../db/index';
import { sql } from 'drizzle-orm';

const DRY_RUN = !process.argv.includes('--apply');
const WORKSPACE_ID = process.env.WORKSPACE_ID;

if (!WORKSPACE_ID) {
  console.error('[dedup-pr] WORKSPACE_ID is required');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('[dedup-pr] DATABASE_URL is required');
  process.exit(1);
}

interface DupGroup {
  content_hash: string;
  source_ids: string[];
  winner: string;
  losers: string[];
}

async function findDuplicateGroups(namespace: string): Promise<DupGroup[]> {
  // Find content_hashes with more than one distinct current source_id in the namespace.
  const dupHashRows = await db.execute(sql`
    SELECT content_hash, array_agg(source_id ORDER BY source_ts ASC NULLS LAST, source_id ASC) AS source_ids
    FROM knowledge_chunks
    WHERE namespace = ${namespace}
      AND is_current = true
      AND content_hash IS NOT NULL
    GROUP BY content_hash
    HAVING count(DISTINCT source_id) > 1
  `);

  return (dupHashRows.rows as Array<{ content_hash: string; source_ids: string[] }>).map(row => {
    const [winner, ...losers] = row.source_ids;
    return { content_hash: row.content_hash, source_ids: row.source_ids, winner, losers };
  });
}

async function archiveLosers(namespace: string, groups: DupGroup[]): Promise<number> {
  let archived = 0;
  for (const group of groups) {
    for (const loser of group.losers) {
      await db.execute(sql`
        UPDATE knowledge_chunks
        SET is_current = false,
            superseded_by = ${group.winner}
        WHERE namespace = ${namespace}
          AND source_id = ${loser}
          AND is_current = true
      `);
      archived++;
      console.log(`  archived ${loser} → superseded by ${group.winner}`);
    }
  }
  return archived;
}

async function main() {
  const namespace = `${WORKSPACE_ID}:pr`;
  console.log(`[dedup-pr] namespace: ${namespace}`);
  if (DRY_RUN) {
    console.log('[dedup-pr] DRY RUN — pass --apply to archive duplicates');
  } else {
    console.log('[dedup-pr] LIVE RUN — losers will be archived (is_current=false)');
  }

  const groups = await findDuplicateGroups(namespace);

  if (groups.length === 0) {
    console.log('[dedup-pr] No duplicate content_hash groups found. Corpus is clean.');
    process.exit(0);
  }

  const totalLosers = groups.reduce((n, g) => n + g.losers.length, 0);
  console.log(`[dedup-pr] ${groups.length} duplicate group(s), ${totalLosers} chunk(s) to archive:`);

  for (const group of groups) {
    console.log(`  hash: ${group.content_hash.slice(0, 16)}… — keep: ${group.winner} | archive: ${group.losers.join(', ')}`);
  }

  if (DRY_RUN) {
    console.log(`\n[dedup-pr] ${totalLosers} chunk(s) would be archived. Re-run with --apply to commit.`);
    process.exit(0);
  }

  const archived = await archiveLosers(namespace, groups);
  console.log(`\n[dedup-pr] Archived ${archived} duplicate chunk(s).`);
  process.exit(0);
}

main().catch(err => {
  console.error('[dedup-pr] Error:', err);
  process.exit(1);
});

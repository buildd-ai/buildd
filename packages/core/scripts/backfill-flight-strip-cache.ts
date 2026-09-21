/**
 * One-time backfill: compute and store `missions.flightStripCache` for every
 * existing `status='completed'` mission where the column is still NULL
 * (docs/design/mission-flight-strip.md, Rule P-1/P-5). Idempotent by
 * construction — the selection query itself excludes any mission that
 * already has a cached strip (AC-13), so re-running only ever touches the
 * missions a previous run didn't reach (or missions completed since).
 *
 * Usage:
 *   DATABASE_URL=... bun packages/core/scripts/backfill-flight-strip-cache.ts [--dry-run]
 *
 * --dry-run  Print what would be written without touching the DB.
 */

import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../db/index';
import { missions } from '../db/schema';
import { computeAndStoreFlightStripCache, loadFlightStripInputs } from '../flight-strip-store';
import { computeMissionFlightStrip } from '../mission-helpers';

/** Pure selection rule, split out so idempotency (AC-13) is testable without
 * a database: a mission already carrying a cache is never re-selected. */
export function selectMissionsNeedingBackfill(
  rows: Array<{ id: string; flightStripCache: unknown }>,
): string[] {
  return rows.filter(r => r.flightStripCache == null).map(r => r.id);
}

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const candidates = await db.query.missions.findMany({
    where: and(eq(missions.status, 'completed'), isNull(missions.flightStripCache)),
    columns: { id: true, flightStripCache: true, completedAt: true, updatedAt: true },
  });

  const missionIds = selectMissionsNeedingBackfill(candidates);
  console.log(`Found ${missionIds.length} completed mission(s) with no flight-strip cache${DRY_RUN ? ' [DRY RUN]' : ''}`);
  if (missionIds.length === 0) return;

  const byId = new Map(candidates.map(m => [m.id, m]));
  let written = 0;
  let skippedEmpty = 0;

  for (const missionId of missionIds) {
    const mission = byId.get(missionId)!;
    // v1 approximation, same one the old skyline call site used: completedAt
    // may be null for a mission that closed before that column existed.
    const missionCompletedAt = mission.completedAt ?? mission.updatedAt;

    if (DRY_RUN) {
      const { tasks, workers } = await loadFlightStripInputs(missionId);
      const data = computeMissionFlightStrip(tasks, workers, { missionCompletedAt });
      console.log(`  ${missionId}: ${data.bars.length} bar(s), ${data.phases.length} phase(s) [dry]`);
      if (data.bars.length === 0) skippedEmpty++;
      written++;
      continue;
    }

    await computeAndStoreFlightStripCache(missionId, { missionCompletedAt });
    written++;
  }

  console.log(`\n=== Summary ===`);
  console.log(`  ${DRY_RUN ? 'would write' : 'wrote'} : ${written}`);
  if (DRY_RUN) console.log(`  zero-bar    : ${skippedEmpty}`);
}

// Guarded so a test can import `selectMissionsNeedingBackfill` without
// triggering a real DB connection attempt on module load.
if (import.meta.main) {
  main().catch(err => { console.error(err); process.exit(1); });
}

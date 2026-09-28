#!/usr/bin/env bun
/**
 * Backfill task categories: the category sweep (apps/web/src/lib/task-category-sweep.ts)
 * over every task no look has been recorded for, in batches, then the ones an
 * earlier look skipped for want of a key. Same gate as live: fill a blank at
 * ≥0.8, replace a keyword category at ≥0.9, never a caller's or `review`, and
 * each write records its provenance in tasks.category_decision.
 *
 *   DATABASE_URL=... bun run scripts/backfill-task-categories.ts --dry-run
 *   DATABASE_URL=... bun run scripts/backfill-task-categories.ts [--batch 200] [--concurrency 8] [--max 5000]
 *
 * Idempotent: a task is looked at once; re-running picks up only what is left.
 * Stops when a batch changes nothing (e.g. every remaining row is a transient
 * failure), so it can't spin.
 */
import { db } from '../packages/core/db';
import { tasks } from '../packages/core/db/schema';
import { isNull, sql } from 'drizzle-orm';
import { sweepTaskCategories, type SweepCounts } from '../apps/web/src/lib/task-category-sweep';

const arg = (name: string, d: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const dryRun = process.argv.includes('--dry-run');
const batch = arg('batch', 200);
const concurrency = arg('concurrency', 8);
const max = arg('max', Infinity);

const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(tasks).where(isNull(tasks.categoryDecision));
console.log(`${n} task(s) with no recorded look`);
if (dryRun) process.exit(0);

const total: SweepCounts = { looked: 0, applied: 0, kept: 0, skipped: 0, lost_race: 0, error: 0 };
for (const retryUnconfigured of [false, true]) {
  while (total.looked < max) {
    const c = await sweepTaskCategories({ limit: Math.min(batch, max - total.looked), concurrency, budgetMs: 10 * 60_000, retryUnconfigured });
    for (const k of Object.keys(total) as Array<keyof SweepCounts>) total[k] += c[k];
    console.log(JSON.stringify(c));
    // The retry pass re-picks rows whose team still has no key; only real looks count as progress there.
    const progress = retryUnconfigured ? c.applied + c.kept : c.applied + c.kept + c.skipped + c.lost_race;
    if (c.looked === 0 || progress === 0) break;
  }
}
console.log('total', JSON.stringify(total));
process.exit(0);

/**
 * Sweep every worker PR and reconcile its merge state against GitHub.
 *
 * Repairs the damage from repo-unscoped worker lookups: PR numbers are unique
 * per repo, not globally, so a merge webhook for one repo could stamp another
 * repo's worker. That left real merges unrecorded (blocking dependent tasks
 * forever) and marked never-merged PRs as merged.
 *
 * Dry run by default — prints the diff and writes nothing.
 *
 *   bun run apps/web/scripts/reconcile-pr-merge-state.ts
 *   bun run apps/web/scripts/reconcile-pr-merge-state.ts --apply
 *   bun run apps/web/scripts/reconcile-pr-merge-state.ts --collisions-only
 */
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { isNotNull, sql } from 'drizzle-orm';
import { reconcileWorkerPrState } from '../src/lib/pr-state-reconcile';

const apply = process.argv.includes('--apply');
const collisionsOnly = process.argv.includes('--collisions-only');

const rows = await db
  .select({
    id: workers.id,
    prUrl: workers.prUrl,
    prNumber: workers.prNumber,
    mergedAt: workers.mergedAt,
    prLifecycleStatus: workers.prLifecycleStatus,
    workspaceId: workers.workspaceId,
  })
  .from(workers)
  .where(
    collisionsOnly
      ? sql`${workers.prUrl} IS NOT NULL AND ${workers.prNumber} IN (
            SELECT pr_number FROM workers
            WHERE pr_number IS NOT NULL AND pr_url IS NOT NULL
            GROUP BY pr_number HAVING count(DISTINCT workspace_id) > 1)`
      : isNotNull(workers.prUrl),
  );

console.log(`${rows.length} worker PR(s) to check${collisionsOnly ? ' (colliding PR numbers only)' : ''}`);
console.log(apply ? 'MODE: apply (writes)' : 'MODE: dry run (no writes)');

const result = await reconcileWorkerPrState(rows as any, { dryRun: !apply });

for (const f of result.fixes) {
  console.log(
    `  ${f.prUrl}\n` +
      `      mergedAt          ${f.before.mergedAt ?? 'null'}  →  ${f.after.mergedAt ?? 'null'}\n` +
      `      prLifecycleStatus ${f.before.prLifecycleStatus ?? 'null'}  →  ${f.after.prLifecycleStatus}`,
  );
}

console.log(`\nchecked ${result.checked} · ${apply ? 'corrected' : 'would correct'} ${result.fixes.length}`);
if (result.unverified.length > 0) {
  console.log(`unverified ${result.unverified.length}:`);
  for (const u of result.unverified.slice(0, 20)) console.log(`  ${u.prUrl} — ${u.reason}`);
}

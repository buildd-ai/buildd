import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import { db } from '@buildd/core/db';
import { sql, eq } from 'drizzle-orm';
import { workers } from '@buildd/core/db/schema';
import { refreshWorkerMergeStateIfStale } from '@/lib/pr-reconcile';
import { shouldMarkUnresolvable } from '@/lib/pr-freshness';

/**
 * POST /api/admin/backfill-merged-prs
 *
 * One-shot backfill over every worker row that still looks un-merged: calls the
 * GitHub API for each and stamps the correct terminal state. This is the
 * immediate clear-down for a backlog that accumulated while the reconcile sweep
 * could not authenticate; the sweep itself is what keeps it clear afterwards.
 *
 * Two things this route used to get wrong, both of which made it useless
 * against exactly the rows it existed to fix:
 *
 *   1. It resolved the installation through `workspaces.github_installation_id`
 *      only. That FK is legacy and, after an App reinstall, points at a dead
 *      installation — so `installation_id` came back NULL or dead and every row
 *      in the affected workspace was skipped. github_repos.installation_id is
 *      refreshed on every installation sync; prefer it. See
 *      lib/workspace-installation.ts.
 *   2. It required `t.status = 'completed'`. A worker whose task failed or was
 *      cancelled still has a PR that may have merged, and Home renders it.
 *
 * Rows GitHub cannot resolve at all are written to terminal `unresolvable`
 * rather than left to be retried forever.
 *
 * Admin-level API key required.
 * Returns { total, refreshed, unresolvable, skipped }.
 */
export async function POST(req: NextRequest) {
  // Admin-level API key required. A browser session is deliberately NOT
  // accepted: there is no platform-admin concept for sessions in this codebase,
  // so accepting one would let any signed-in user drive a bulk GitHub-backed
  // write across every workspace. Same bar as admin/refresh-model-aliases.
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!apiAccount) {
    return NextResponse.json({ error: 'Requires an admin-level API key' }, { status: 401 });
  }
  if (apiAccount.level !== 'admin') {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }

  // Every row with a PR that has not landed and is not already terminal —
  // regardless of how the originating task ended.
  const rows = await db.execute(sql`
    SELECT
      w.id,
      w.pr_number,
      w.pr_url,
      w.pr_check_failure_count,
      COALESCE(w.completed_at, w.created_at) AS pr_opened_at,
      COALESCE(gr_inst.installation_id, gi.installation_id) AS installation_id
    FROM workers w
    LEFT JOIN workspaces ws ON ws.id = w.workspace_id
    LEFT JOIN github_repos gr ON gr.id = ws.github_repo_id
    LEFT JOIN github_installations gr_inst ON gr_inst.id = gr.installation_id
    LEFT JOIN github_installations gi ON gi.id = ws.github_installation_id
    WHERE
      w.merged_at IS NULL
      AND w.pr_number IS NOT NULL
      AND w.pr_url IS NOT NULL
      AND (
        w.pr_lifecycle_status IS NULL
        OR w.pr_lifecycle_status NOT IN ('merged', 'closed', 'unresolvable')
      )
  `);

  type Row = {
    id: string;
    pr_number: number;
    pr_url: string;
    pr_check_failure_count: number | null;
    pr_opened_at: string | null;
    installation_id: number | null;
  };
  const candidates = rows.rows as unknown as Row[];

  const total = candidates.length;
  let refreshed = 0;
  let unresolvable = 0;
  let skipped = 0;

  /** A row with no reachable installation can never resolve — retire it. */
  const retire = async (row: Row, reason: string) => {
    const failureCount = (row.pr_check_failure_count ?? 0) + 1;
    const prOpenedAt = row.pr_opened_at ? new Date(row.pr_opened_at) : null;
    const now = new Date();
    const terminal = shouldMarkUnresolvable({ failureCount, prOpenedAt, now });
    await db.update(workers)
      .set({
        prLastCheckedAt: now,
        prCheckFailureCount: failureCount,
        ...(terminal
          ? { prLifecycleStatus: 'unresolvable' as const, prUnresolvableReason: reason, updatedAt: now }
          : {}),
      })
      .where(eq(workers.id, row.id));
    if (terminal) unresolvable++; else skipped++;
  };

  // Process in batches of 5 to avoid hammering the GitHub API
  const BATCH = 5;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async row => {
        if (!row.installation_id) {
          await retire(row, 'Workspace has no usable GitHub App installation');
          return false;
        }
        return refreshWorkerMergeStateIfStale(
          { id: row.id, prNumber: row.pr_number, prUrl: row.pr_url },
          row.installation_id,
        );
      })
    );
    refreshed += results.filter(Boolean).length;
  }

  return NextResponse.json({ total, refreshed, unresolvable, skipped });
}

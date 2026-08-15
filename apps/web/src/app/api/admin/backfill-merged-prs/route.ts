import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { db } from '@buildd/core/db';
import { sql } from 'drizzle-orm';
import { refreshWorkerMergeStateIfStale } from '@/lib/pr-reconcile';

/**
 * POST /api/admin/backfill-merged-prs
 *
 * One-shot backfill: finds all completed workers with a prNumber and no mergedAt,
 * then calls the GitHub API for each to stamp the correct merge state.
 *
 * Admin auth required (session or admin-level API key).
 * Returns { total, refreshed }.
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (apiAccount && apiAccount.level !== 'admin') {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }

  // Find workers that need backfill: completed task, has prNumber, no mergedAt, not closed.
  const rows = await db.execute(sql`
    SELECT
      w.id,
      w.pr_number,
      w.pr_url,
      gi.installation_id
    FROM workers w
    JOIN tasks t ON t.id = w.task_id
    LEFT JOIN workspaces ws ON ws.id = w.workspace_id
    LEFT JOIN github_installations gi ON gi.id = ws.github_installation_id
    WHERE
      w.merged_at IS NULL
      AND w.pr_number IS NOT NULL
      AND w.pr_url IS NOT NULL
      AND (w.pr_lifecycle_status IS NULL OR w.pr_lifecycle_status != 'merged')
      AND t.status = 'completed'
  `);

  type Row = { id: string; pr_number: number; pr_url: string; installation_id: number | null };
  const candidates = rows.rows as unknown as Row[];

  const total = candidates.length;
  let refreshed = 0;

  // Process in batches of 5 to avoid hammering the GitHub API
  const BATCH = 5;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(row => {
        if (!row.installation_id) return Promise.resolve(false);
        return refreshWorkerMergeStateIfStale(
          { id: row.id, prNumber: row.pr_number, prUrl: row.pr_url },
          row.installation_id,
        );
      })
    );
    refreshed += results.filter(Boolean).length;
  }

  return NextResponse.json({ total, refreshed });
}

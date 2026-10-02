/**
 * GET /api/cron/evidence-index
 *
 * The evidence index sweep (docs/specs/byo-evidence-storage.md, "The `evidence`
 * corpus"): indexes `evidence_objects` rows whose `index_state` is `queued`, and
 * re-drives `failed` rows past a backoff, into the `{workspaceId}:evidence`
 * knowledge corpus. This is what makes the best-effort upsert durable: a row
 * whose indexing never happened is picked up on the next tick. Sensitive
 * workspaces are marked `skipped` and never reach the embedder.
 *
 * `changed` = rows given a final state (indexed or skipped); `errors` = rows
 * that failed this run (they are retried later, not lost). An empty queue is
 * one cheap query.
 *
 * Auth: Bearer CRON_SECRET (via withCronRun). Triggered by cron-manifest.json.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withCronRun } from '@/lib/cron-run';
import { runEvidenceIndexSweep } from '@/lib/evidence-indexer';

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  return withCronRun('evidence-index', req, async report => {
    const result = await runEvidenceIndexSweep();
    report({
      processed: result.considered,
      changed: result.indexed + result.skipped,
      errors: result.failed,
      result: { ...result },
    });
    return NextResponse.json({ ok: true, ...result });
  });
}

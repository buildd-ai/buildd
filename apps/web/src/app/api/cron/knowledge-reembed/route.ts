/**
 * GET /api/cron/knowledge-reembed
 *
 * Re-embeds knowledge for namespaces whose embedding model or size changed
 * (lib/knowledge-reembed.ts). Never throws; bounded by its own time budget.
 * `changed` = rows processed; `errors` = rows that failed.
 *
 * Auth: Bearer CRON_SECRET (via withCronRun). Triggered by cron-manifest.json.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withCronRun } from '@/lib/cron-run';
import { runReembedTick } from '@/lib/knowledge-reembed';

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  return withCronRun('knowledge-reembed', req, async report => {
    const reembed = await runReembedTick();
    report({ changed: reembed.processed, errors: reembed.failed, result: { ...reembed } });
    return NextResponse.json({ ok: true, ...reembed });
  });
}

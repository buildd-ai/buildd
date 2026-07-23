// GET /api/cron/pr-reconcile
//
// Daily sweep: reconcile workers stuck in "awaiting merge" state.
//
// Workers with prUrl && !mergedAt that haven't been updated for 7+ days are
// checked against the GitHub Pulls API. If GitHub reports merged → stamps
// mergedAt. If closed-unmerged → stamps prLifecycleStatus='closed'.
//
// Self-heals rows missed by the pull_request webhook (missed deliveries, PRs
// merged before the webhook handler existed, etc.). The MergeConfirmButton and
// mission timeline gate (BT-18) then hide correctly.
//
// Auth: Bearer token matching CRON_SECRET env var.
// Schedule: daily.

import { NextRequest, NextResponse } from 'next/server';
import { reconcileStalePrWorkers } from '@/lib/pr-reconcile';

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }

  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (token !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await reconcileStalePrWorkers();
    console.log(
      `[PrReconcile] total=${result.total} stamped=${result.stamped} closed=${result.closed} skipped=${result.skipped}`,
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[PrReconcile] error:', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

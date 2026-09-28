/**
 * Cron endpoint: POST /api/cron/feedback-digest
 *
 * Processes recent user feedback (down-votes and dismissals) on AI-generated
 * content, distills patterns, and saves actionable memories so future agent
 * runs produce more relevant output.
 *
 * Also runs the memory index reconcile pass: re-mirrors memory rows that are
 * missing from the recall index (a failed mirror, or a row written before its
 * path mirrored), bounded per run. It rides this schedule so it adds no Neon
 * wake window of its own.
 *
 * Auth: Bearer token matching CRON_SECRET env var.
 * Schedule: recommended every 1-4 hours via external cron trigger.
 */

import { NextRequest, NextResponse } from 'next/server';
import { runFeedbackDigest, getFeedbackStats } from '@/lib/feedback-digest';
import { withCronRun, type CronReport } from '@/lib/cron-run';
import { getMemoryIndexStore } from '@/lib/memory-helper';
import { reconcileMemoryIndex, type ReconcileResult } from '@buildd/core/memory-index-reconcile';

/**
 * Re-mirror unindexed memory rows. Never throws: a reconcile failure is
 * reported in the result, it does not fail the digest.
 */
async function runReconcile(): Promise<ReconcileResult | { error: string }> {
  try {
    return await reconcileMemoryIndex({ knowledgeStore: getMemoryIndexStore() });
  } catch (error) {
    console.error('[feedback-digest] Memory index reconcile error:', error);
    return { error: String(error) };
  }
}

export const maxDuration = 60; // Allow up to 60s for processing

export async function POST(req: NextRequest) {
  return withCronRun('feedback-digest', req, report => runCronJob(req, report));
}

async function runCronJob(req: NextRequest, report: CronReport): Promise<NextResponse> {

  // ── Parameters ─────────────────────────────────────────────────────────
  const url = new URL(req.url);
  const windowHours = parseInt(url.searchParams.get('windowHours') || '24', 10);

  try {
    // Run the digest pipeline
    const digest = await runFeedbackDigest(windowHours);

    // Gather stats for the response (includes positive signals too)
    const stats = await getFeedbackStats(windowHours);

    const memoryIndexReconcile = await runReconcile();
    const reconcileFailed = 'error' in memoryIndexReconcile ? 1 : memoryIndexReconcile.failed;

    report({
      processed: digest.totalFeedback,
      changed: digest.results.length,
      ...(reconcileFailed > 0 ? { errors: reconcileFailed } : {}),
      result: {
        windowHours,
        totalNegativeFeedback: digest.totalFeedback,
        teams: digest.results.length,
        memoryIndexReconcile,
      },
    });

    return NextResponse.json({
      ok: true,
      windowHours,
      stats,
      digest: {
        totalNegativeFeedback: digest.totalFeedback,
        teams: digest.results,
      },
      memoryIndexReconcile,
    });
  } catch (error) {
    console.error('[feedback-digest] Pipeline error:', error);
    // The reconcile pass does not depend on the digest, so a digest failure
    // does not also cost the index its catch-up run.
    const memoryIndexReconcile = await runReconcile();
    report({ processed: 0, changed: 0, errors: 1, result: { error: String(error), memoryIndexReconcile } });
    return NextResponse.json(
      { error: 'Feedback digest failed', detail: String(error) },
      { status: 500 },
    );
  }
}

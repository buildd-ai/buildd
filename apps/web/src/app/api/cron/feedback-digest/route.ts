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
 * And the memory lifecycle pass (packages/core/memory-lifecycle.ts):
 * candidate extraction, promotion (Jev `promote` in shadow), expiry and
 * re-verify flags, each bounded per run. Only workspaces with
 * `memoryCandidateWrites` on produce candidates, so with the flag off
 * everywhere it reads and changes nothing.
 *
 * Auth: Bearer token matching CRON_SECRET env var.
 * Schedule: recommended every 1-4 hours via external cron trigger.
 */

import { NextRequest, NextResponse } from 'next/server';
import { runFeedbackDigest, getFeedbackStats } from '@/lib/feedback-digest';
import { withCronRun, type CronReport } from '@/lib/cron-run';
import { getMemoryIndexStore } from '@/lib/memory-helper';
import { reconcileMemoryIndex, type ReconcileResult } from '@buildd/core/memory-index-reconcile';
import { runMemoryLifecycle, type LifecycleResult } from '@buildd/core/memory-lifecycle';
import { memoryDeciderFor } from '@/lib/memory-decisions';

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

/** The memory lifecycle pass. Never throws; failures are counted in the result. */
async function runLifecycle(): Promise<LifecycleResult | { error: string }> {
  try {
    return await runMemoryLifecycle({ knowledgeStore: getMemoryIndexStore(), decider: memoryDeciderFor(null) });
  } catch (error) {
    console.error('[feedback-digest] Memory lifecycle error:', error);
    return { error: String(error) };
  }
}

const lifecycleErrors = (r: LifecycleResult | { error: string }): number => ('error' in r ? 1 : r.errors);

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
    const memoryLifecycle = await runLifecycle();
    const failed = reconcileFailed + lifecycleErrors(memoryLifecycle);

    report({
      processed: digest.totalFeedback,
      changed: digest.results.length,
      ...(failed > 0 ? { errors: failed } : {}),
      result: {
        windowHours,
        totalNegativeFeedback: digest.totalFeedback,
        teams: digest.results.length,
        memoryIndexReconcile,
        memoryLifecycle,
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
      memoryLifecycle,
    });
  } catch (error) {
    console.error('[feedback-digest] Pipeline error:', error);
    // The reconcile pass does not depend on the digest, so a digest failure
    // does not also cost the index its catch-up run.
    const memoryIndexReconcile = await runReconcile();
    const memoryLifecycle = await runLifecycle();
    report({ processed: 0, changed: 0, errors: 1, result: { error: String(error), memoryIndexReconcile, memoryLifecycle } });
    return NextResponse.json(
      { error: 'Feedback digest failed', detail: String(error) },
      { status: 500 },
    );
  }
}

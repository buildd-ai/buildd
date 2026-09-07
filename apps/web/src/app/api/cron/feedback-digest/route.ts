/**
 * Cron endpoint: POST /api/cron/feedback-digest
 *
 * Processes recent user feedback (down-votes and dismissals) on AI-generated
 * content, distills patterns, and saves actionable memories so future agent
 * runs produce more relevant output.
 *
 * Auth: Bearer token matching CRON_SECRET env var.
 * Schedule: recommended every 1-4 hours via external cron trigger.
 */

import { NextRequest, NextResponse } from 'next/server';
import { runFeedbackDigest, getFeedbackStats } from '@/lib/feedback-digest';
import { withCronRun, type CronReport } from '@/lib/cron-run';

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

    return NextResponse.json({
      ok: true,
      windowHours,
      stats,
      digest: {
        totalNegativeFeedback: digest.totalFeedback,
        teams: digest.results,
      },
    });
  } catch (error) {
    console.error('[feedback-digest] Pipeline error:', error);
    return NextResponse.json(
      { error: 'Feedback digest failed', detail: String(error) },
      { status: 500 },
    );
  }
}

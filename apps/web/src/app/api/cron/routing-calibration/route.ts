import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { taskOutcomes } from '@buildd/core/db/schema';
import { gte, and, sql } from 'drizzle-orm';

/**
 * Routing-calibration cron.
 *
 * Walks the last 7 days of `taskOutcomes` and emits an aggregate by
 * (kind × complexity × predictedModel) — success rate, retry rate, mean
 * turns, mean cost. The PR-writing step (surface flips in the Organizer
 * prompt) is deliberately out of scope here; this is the data layer.
 *
 * Protected by CRON_SECRET. Read-only: we return the aggregate as JSON so
 * a separate workflow (or manual query) can act on it.
 *
 * See plans/buildd/smart-model-routing.md Phase 5.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (authHeader?.replace('Bearer ', '') !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const windowStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      kind: taskOutcomes.kind,
      complexity: taskOutcomes.complexity,
      predictedModel: taskOutcomes.predictedModel,
      total: sql<number>`count(*)::int`,
      completed: sql<number>`count(*) filter (where ${taskOutcomes.outcome} = 'completed')::int`,
      retried: sql<number>`count(*) filter (where ${taskOutcomes.wasRetried} = true)::int`,
      downshifted: sql<number>`count(*) filter (where ${taskOutcomes.downshifted} = true)::int`,
      avgTurns: sql<number>`avg(${taskOutcomes.totalTurns})::float`,
      avgCostUsd: sql<number>`avg(${taskOutcomes.totalCostUsd}::numeric)::float`,
    })
    .from(taskOutcomes)
    .where(and(gte(taskOutcomes.createdAt, windowStart)))
    .groupBy(taskOutcomes.kind, taskOutcomes.complexity, taskOutcomes.predictedModel);

  const buckets = rows.map(r => ({
    kind: r.kind,
    complexity: r.complexity,
    predictedModel: r.predictedModel,
    total: r.total,
    completed: r.completed,
    retried: r.retried,
    downshifted: r.downshifted,
    successRate: r.total > 0 ? r.completed / r.total : 0,
    retryRate: r.total > 0 ? r.retried / r.total : 0,
    avgTurns: r.avgTurns,
    avgCostUsd: r.avgCostUsd,
  }));

  // Heuristic flags for the eventual prompt-flip step.
  const UNDERSHOOT_RETRY_RATE = 0.25;
  const OVERSHOOT_TURNS = 5;
  const flags = {
    undershoots: buckets.filter(b => b.retryRate >= UNDERSHOOT_RETRY_RATE && b.total >= 5),
    overshoots: buckets.filter(
      b => b.predictedModel === 'opus' && b.avgTurns != null && b.avgTurns <= OVERSHOOT_TURNS && b.total >= 5,
    ),
  };

  return NextResponse.json({
    windowDays: 7,
    windowStart: windowStart.toISOString(),
    totalOutcomes: buckets.reduce((s, b) => s + b.total, 0),
    buckets,
    flags,
  });
}

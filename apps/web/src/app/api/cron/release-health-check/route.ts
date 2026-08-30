// GET /api/cron/release-health-check
//
// Post-deploy health watch window: for every release that reached `healthy`
// within the last 30 minutes with an http verification strategy, probe the
// workspace's verificationUrl once. On non-2xx or network error, transition
// the release to `degraded` and auto-file a degradation task in the workspace.
//
// Runs every 2 minutes via Vercel Cron (vercel.json).
// Auth: Bearer token matching CRON_SECRET env var.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { releases, workspaces } from '@buildd/core/db/schema';
import { eq, and, gte, sql } from 'drizzle-orm';
import { probeAndDegrade } from '@/lib/release-health-watcher';

export const maxDuration = 60;

const WATCH_WINDOW_MINUTES = 30;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }

  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (token !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const windowStart = new Date(Date.now() - WATCH_WINDOW_MINUTES * 60_000);

  const candidates = await db
    .select({
      id: releases.id,
      workspaceId: releases.workspaceId,
      verificationStrategy: releases.verificationStrategy,
      deployUrl: releases.deployUrl,
      healthyAt: releases.healthyAt,
      verificationUrl: sql<string | null>`${workspaces.releaseConfig}->>'verificationUrl'`,
    })
    .from(releases)
    .innerJoin(workspaces, eq(releases.workspaceId, workspaces.id))
    .where(
      and(
        eq(releases.state, 'healthy'),
        eq(releases.verificationStrategy, 'http'),
        gte(releases.healthyAt, windowStart),
      ),
    );

  let probed = 0;
  let degraded = 0;
  const results: Array<{ releaseId: string; outcome: string }> = [];

  for (const row of candidates) {
    if (!row.verificationUrl) continue;

    probed++;
    const outcome = await probeAndDegrade(
      {
        id: row.id,
        workspaceId: row.workspaceId,
        verificationStrategy: row.verificationStrategy,
        deployUrl: row.deployUrl,
        healthyAt: row.healthyAt,
      },
      row.verificationUrl,
      db,
    );

    if (outcome === 'degraded') degraded++;
    results.push({ releaseId: row.id, outcome });
  }

  console.log(
    JSON.stringify({
      event: 'release_health_check',
      candidates: candidates.length,
      probed,
      degraded,
    }),
  );

  return NextResponse.json({ ok: true, candidates: candidates.length, probed, degraded, results });
}

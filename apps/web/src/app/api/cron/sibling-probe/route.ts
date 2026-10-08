/**
 * GET /api/cron/sibling-probe
 *
 * Live sibling conflict probe, step 1 (lib/sibling-conflict-probe.ts): find
 * pairs of live workers whose observed touches (the runner's touched-paths
 * heartbeat) share a file, and ask one of each pair to run `git merge-tree`
 * against the other's branch. The server has no clone, so the probe itself
 * runs on the prober's runner, handed out on its next heartbeat; its result
 * comes back the same way and is what notifies both workers.
 *
 * Two triggers, both in cron-manifest.json (see lib/cron-due-queue.ts):
 *   - `?gate=due` every 5 minutes: reads `buildd:due:sibling-probe`, which the
 *     worker PATCH route marks when a heartbeat reports new touched paths, and
 *     returns without touching Postgres when no workspace's touches moved.
 *   - no param, hourly in the day: the floor tick, which also re-probes pairs
 *     whose touches stayed put while their commits moved on.
 *
 * A pair is asked at most once per SIBLING_PROBE_INTERVAL_MS (the
 * `sibling_probes` row is the debounce). SIBLING_PROBE_ENABLED=0 turns the
 * probe off everywhere.
 *
 * Auth: Bearer CRON_SECRET (via withCronRun).
 */
import { NextRequest, NextResponse } from 'next/server';
import { withCronRun } from '@/lib/cron-run';
import { gateOnDueQueue } from '@/lib/cron-due-queue';
import { clearDueThrough } from '@/lib/redis';
import { SIBLING_PROBE_DUE_QUEUE, requestSiblingProbes } from '@/lib/sibling-conflict-probe';
import { createSiblingProbeStore } from '@/lib/sibling-conflict-probe-store';

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  return withCronRun('sibling-probe', req, async report => {
    if (process.env.SIBLING_PROBE_ENABLED === '0') {
      return NextResponse.json({ ok: true, disabled: true });
    }
    const gate = await gateOnDueQueue(SIBLING_PROBE_DUE_QUEUE, req.nextUrl.searchParams);
    if (!gate.proceed) {
      return NextResponse.json({ ok: true, gated: true, reason: gate.reason });
    }
    const startedAt = Date.now();
    const counts = await requestSiblingProbes(createSiblingProbeStore());
    await clearDueThrough(SIBLING_PROBE_DUE_QUEUE, startedAt);
    report({ processed: counts.pairs, changed: counts.requested, result: { ...counts, gate: gate.reason } });
    return NextResponse.json({ ok: true, ...counts });
  });
}

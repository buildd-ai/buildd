/**
 * GET /api/cron/maintenance
 *
 * Core maintenance for the coordination loop. Two repair sweeps that used to
 * ride the `schedules` tick, a module job:
 *
 *   1. Stale-worker cleanup: fail the workers of accounts whose runners have
 *      all gone quiet. The claim route's own cleanup only runs for an account
 *      that claims, and a dead runner never calls /api/tasks/cleanup.
 *   2. Abandoned path-claim release: release claims a terminal task should have
 *      released. A held claim blocks the claim gate.
 *   3. Ended-task interactive workers: detach any live claim_task worker whose
 *      task already ended (lib/interactive-detach.ts), across every team. The
 *      claim and MCP paths do this as they run; this is the floor that repairs
 *      the rest, including rows leaked before those paths existed.
 *   4. Stale artifact uploads (lib/artifact-upload.ts): finalize an upload its
 *      uploader never finalized, and remove one that never arrived or failed,
 *      after a day. Storage must be configured; otherwise it is skipped.
 *
 * They live here so a deployment that schedules only the `core` cron profile
 * keeps them (cron-manifest.json, `cron:sync --profile core,ops`). On
 * buildd.dev this runs at the schedules tick's minute, so the effective
 * schedule is unchanged. Same order as before: workers first, then claims.
 *
 * Each sweep swallows its own failures (logged), so one cannot stop the other.
 * Auth: Bearer CRON_SECRET, via withCronRun.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withCronRun, type CronReport } from '@/lib/cron-run';
import { runStaleWorkerCleanup } from './stale-workers';
import { sweepAbandonedPathClaims } from './path-claims';
import { detachInteractiveWorkersOfEndedTasks } from '@/lib/interactive-detach';
import { sweepStaleUploads } from '@/lib/artifact-upload';
import { isStorageConfigured } from '@/lib/storage';

export async function GET(req: NextRequest) {
  return withCronRun('maintenance', req, report => runCronJob(report));
}

async function runCronJob(report: CronReport): Promise<NextResponse> {
  const now = new Date();
  const heartbeatOrphans = await runStaleWorkerCleanup(now);
  const abandonedClaimsReleased = await sweepAbandonedPathClaims();
  const interactiveDetached = await detachInteractiveWorkersOfEndedTasks({ now });
  const uploads = isStorageConfigured()
    ? await sweepStaleUploads(now).catch((err) => {
      console.error('[maintenance] stale upload sweep failed', err instanceof Error ? err.message : err);
      return { finalized: 0, removed: 0, waiting: 0 };
    })
    : { finalized: 0, removed: 0, waiting: 0 };
  const result = { heartbeatOrphans, abandonedClaimsReleased, interactiveDetached, uploads };
  // Nothing to repair is the healthy state, so changed=0 with errors=0 is fine.
  // Every sweep logs and swallows its own failures, so errors stays 0 here.
  report({ changed: heartbeatOrphans + abandonedClaimsReleased + interactiveDetached + uploads.finalized + uploads.removed, errors: 0, result });
  return NextResponse.json(result);
}

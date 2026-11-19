/**
 * POST /api/relay/jobs/claim — a runner's outbound poll for relay jobs
 * (docs/specs/local-runner-provider.md §4.1).
 *
 * Body `{ runnerId, models, max? }`. `runnerId` is the caller's own heartbeat
 * id (403 otherwise); `models` is what its local model server serves now, and
 * only jobs for those tags are handed out. The claim itself is one atomic
 * UPDATE in `@buildd/core/model-relay`, scoped to the caller's team and to
 * jobs pinned to this runner, chat first.
 *
 * Every poll sweeps first (expired, lapsed leases, retention), as the ingest
 * claim reclaims: the poll is the trigger, so a requeued job is visible to
 * this claim. The maintenance cron sweeps too, for an idle team.
 *
 * Response `{ jobs, pollAfterMs }`. `pollAfterMs: 0` tells a runner the team
 * does not pin to stop polling until its next heartbeat says otherwise.
 */
import { NextRequest, NextResponse } from 'next/server';
import { RELAY_DEFAULTS, isLocalModelName, LOCAL_MODELS_ADVERT_MAX_MODELS, type RelayClaimResponse } from '@buildd/shared';
import { claimRelayJobs, loadLocalRunnerPick, pickUsesRelay, sweepRelayJobs } from '@buildd/core/model-relay';
import { authenticateRelayRunner } from '@/lib/relay-runner-auth';

const MAX_PER_CLAIM = 8;

export async function POST(req: NextRequest) {
  const caller = await authenticateRelayRunner(req);
  if (!caller.ok) return caller.response;

  const { models, max } = caller.body;
  if (!Array.isArray(models) || !models.every(m => typeof m === 'string')) {
    return NextResponse.json({ error: 'models (string array) is required' }, { status: 400 });
  }
  const served = [...new Set(models.filter(isLocalModelName))].slice(0, LOCAL_MODELS_ADVERT_MAX_MODELS);

  try {
    const pick = await loadLocalRunnerPick(caller.teamId);
    if (!pickUsesRelay(pick) || pick!.runnerId !== caller.runnerId) {
      return NextResponse.json({ jobs: [], pollAfterMs: 0 } satisfies RelayClaimResponse);
    }
    await sweepRelayJobs().catch(err => {
      console.warn('[relay/claim] sweep failed:', err instanceof Error ? err.message : err);
    });
    if (served.length === 0) {
      return NextResponse.json({ jobs: [], pollAfterMs: RELAY_DEFAULTS.pollAfterMs } satisfies RelayClaimResponse);
    }
    const fallbackMax = pick!.chatAssigned ? RELAY_DEFAULTS.claimMax.chat : RELAY_DEFAULTS.claimMax.embed;
    const limit = typeof max === 'number' && Number.isSafeInteger(max) && max > 0 ? Math.min(max, MAX_PER_CLAIM) : fallbackMax;
    const jobs = await claimRelayJobs({ teamId: caller.teamId, runnerId: caller.runnerId, models: served, max: limit });
    const response: RelayClaimResponse = {
      jobs: jobs.map(j => ({ id: j.id, kind: j.kind, model: j.model, payload: j.payload, deadlineAt: j.deadlineAt, leaseExpiresAt: j.leaseExpiresAt, leaseId: j.leaseId })),
      pollAfterMs: RELAY_DEFAULTS.pollAfterMs,
    };
    return NextResponse.json(response);
  } catch (error) {
    console.error('[relay/claim] failed:', error);
    return NextResponse.json({ error: 'Failed to claim relay jobs' }, { status: 500 });
  }
}

/**
 * POST /api/relay/jobs/[id]/progress — a runner renews its lease and, for
 * chat, appends the text generated so far (docs/specs/local-runner-provider.md
 * §4.5). The waiter forwards new text to the chat stream as it appears.
 *
 * Body `{ runnerId, leaseId, partialText? }`. 200 `{ ok: true }`; 409 when the
 * lease moved, 410 when the job is terminal (the runner stops the model call),
 * 404 when it does not exist.
 */
import { NextRequest, NextResponse } from 'next/server';
import { RELAY_DEFAULTS, isTerminalRelayStatus } from '@buildd/shared';
import { getRelayJob, progressRelayJob, relayLeaseOwner } from '@buildd/core/model-relay';
import { authenticateRelayRunner, isUuid } from '@/lib/relay-runner-auth';

const LEASE_ID_MAX = 100;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await authenticateRelayRunner(req);
  if (!caller.ok) return caller.response;
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid job id' }, { status: 400 });

  const { leaseId, partialText } = caller.body;
  if (typeof leaseId !== 'string' || !leaseId || leaseId.length > LEASE_ID_MAX) {
    return NextResponse.json({ error: 'leaseId is required' }, { status: 400 });
  }
  if (partialText !== undefined && typeof partialText !== 'string') {
    return NextResponse.json({ error: 'partialText must be a string' }, { status: 400 });
  }
  if (partialText && partialText.length > RELAY_DEFAULTS.chatPayloadMaxBytes) {
    return NextResponse.json({ error: 'partialText is too long' }, { status: 400 });
  }

  try {
    const renewed = await progressRelayJob({ id, leaseOwner: relayLeaseOwner(caller.runnerId, leaseId), ...(partialText ? { partialText } : {}) });
    if (renewed) return NextResponse.json({ ok: true });
    const job = await getRelayJob(id);
    if (!job) return NextResponse.json({ error: 'Relay job not found' }, { status: 404 });
    return isTerminalRelayStatus(job.status)
      ? NextResponse.json({ error: 'The job is no longer open; stop', status: job.status }, { status: 410 })
      : NextResponse.json({ error: 'The lease is held by another owner' }, { status: 409 });
  } catch (error) {
    console.error('[relay/progress] failed:', error);
    return NextResponse.json({ error: 'Failed to record relay progress' }, { status: 500 });
  }
}

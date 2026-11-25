/**
 * POST /api/relay/jobs/[id]/result — a runner posts a job's result or error
 * (docs/specs/local-runner-provider.md §4.2).
 *
 * Body `{ runnerId, leaseId, ok: true, result }` or
 * `{ runnerId, leaseId, ok: false, error: { code, message, httpStatus? } }`.
 * The write is guarded by the lease (`runnerId:leaseId`), so only the runner
 * that holds the job can finish it: another owner is 409, a job already
 * cancelled, expired or finished is 410 and the runner drops it.
 *
 * 200 `{ status: 'done' | 'failed' | 'requeued' }`. `failed` on an `ok: true`
 * post means the server refused the result (a vector of the wrong size is
 * `dimension_mismatch`; nothing was stored). `requeued` is a retryable error
 * with attempts left.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isRelayErrorCode, type RelayJobError, type RelayJobResult } from '@buildd/shared';
import { completeRelayJob, relayLeaseOwner } from '@buildd/core/model-relay';
import { authenticateRelayRunner, isUuid } from '@/lib/relay-runner-auth';

const ERROR_MESSAGE_MAX = 2_000;
const LEASE_ID_MAX = 100;

function parseError(raw: unknown): RelayJobError | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if (!isRelayErrorCode(e.code)) return null;
  const error: RelayJobError = { code: e.code, message: typeof e.message === 'string' ? e.message.slice(0, ERROR_MESSAGE_MAX) : '' };
  if (typeof e.httpStatus === 'number' && Number.isSafeInteger(e.httpStatus) && e.httpStatus >= 100 && e.httpStatus <= 599) error.httpStatus = e.httpStatus;
  return error;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await authenticateRelayRunner(req);
  if (!caller.ok) return caller.response;
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid job id' }, { status: 400 });

  const { leaseId, ok } = caller.body;
  if (typeof leaseId !== 'string' || !leaseId || leaseId.length > LEASE_ID_MAX) {
    return NextResponse.json({ error: 'leaseId is required' }, { status: 400 });
  }
  if (typeof ok !== 'boolean') return NextResponse.json({ error: 'ok (boolean) is required' }, { status: 400 });
  const leaseOwner = relayLeaseOwner(caller.runnerId, leaseId);

  let input: Parameters<typeof completeRelayJob>[0];
  if (ok) {
    const result = caller.body.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return NextResponse.json({ error: 'result (object) is required when ok is true' }, { status: 400 });
    }
    input = { id, leaseOwner, ok: true, result: result as RelayJobResult };
  } else {
    const error = parseError(caller.body.error);
    if (!error) return NextResponse.json({ error: 'error { code, message } with a known code is required when ok is false' }, { status: 400 });
    input = { id, leaseOwner, ok: false, error };
  }

  try {
    const out = await completeRelayJob(input);
    switch (out.outcome) {
      case 'done': return NextResponse.json({ status: 'done' });
      case 'failed': return NextResponse.json({ status: 'failed', error: out.error });
      case 'requeued': return NextResponse.json({ status: 'requeued', notBeforeMs: out.notBeforeMs });
      case 'conflict': return NextResponse.json({ error: 'The lease is held by another owner' }, { status: 409 });
      case 'gone':
        return out.status === null
          ? NextResponse.json({ error: 'Relay job not found' }, { status: 404 })
          : NextResponse.json({ error: 'The job is no longer open; drop the result', status: out.status }, { status: 410 });
    }
  } catch (error) {
    console.error('[relay/result] failed:', error);
    return NextResponse.json({ error: 'Failed to record the relay result' }, { status: 500 });
  }
}

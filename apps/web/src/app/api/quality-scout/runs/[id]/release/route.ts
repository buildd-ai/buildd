/**
 * POST /api/quality-scout/runs/[id]/release — the runner holding the lease
 * cannot serve the run (its checkout cannot get the SHA). The lease is
 * cleared and the run goes back to `awaiting_host` for another runner; the
 * reason is kept on the run's warnings. Not a lapse: only an expired lease
 * counts toward `runner_host_lost`.
 *
 * Body (ScoutRunReleaseRequest): { leaseId, reason }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { releaseScoutRunForRunner } from '@/lib/quality-scout-runner-host';
import { dbScoutRunnerHostStore } from '@/lib/quality-scout-runner-host-store';
import { fail, NO_STORE, resolveScoutHostCaller } from '../../caller';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return fail(404, 'Scout run not found', 'run_not_found');

  const auth = await resolveScoutHostCaller(req);
  if (!auth.ok) return auth.response;

  let body: { leaseId?: unknown; reason?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail(400, 'Invalid JSON body');
  }
  const out = await releaseScoutRunForRunner(
    { caller: auth.caller, runId: id, leaseId: body?.leaseId, reason: body?.reason, now: new Date() },
    dbScoutRunnerHostStore,
  );
  return NextResponse.json(out.body, { status: out.status, headers: NO_STORE });
}

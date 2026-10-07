/**
 * POST /api/quality-scout/runs/[id]/probes — a runner reports substrate
 * results for the runner-assigned probes of a run it holds the lease on.
 *
 * Body (ScoutProbeResultsRequest): { leaseId, results: [{ candidateId,
 * result, reproducibility? }] }, at most 128 KB and 10 results.
 *
 * Refused as a whole, nothing written: another team's run (404), a lease this
 * key and lease id do not hold or that expired (409), a probe not assigned to
 * a runner on this run (422), one already reported (409), a malformed or
 * wrong-SHA / wrong-check result (422). When the last runner probe lands the
 * run is finalized here, on the server, with the server's stores.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { MAX_SCOUT_RESULTS_BODY_BYTES, reportScoutProbeResults } from '@/lib/quality-scout-runner-host';
import { dbScoutRunnerHostStore } from '@/lib/quality-scout-runner-host-store';
import { fail, NO_STORE, resolveScoutHostCaller } from '../../caller';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return fail(404, 'Scout run not found', 'run_not_found');

  const auth = await resolveScoutHostCaller(req);
  if (!auth.ok) return auth.response;

  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_SCOUT_RESULTS_BODY_BYTES) return fail(413, `Body over ${MAX_SCOUT_RESULTS_BODY_BYTES} bytes`, 'payload_too_large');
  const text = await req.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_SCOUT_RESULTS_BODY_BYTES) return fail(413, `Body over ${MAX_SCOUT_RESULTS_BODY_BYTES} bytes`, 'payload_too_large');
  let body: { leaseId?: unknown; results?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, 'Invalid JSON body');
  }

  const out = await reportScoutProbeResults(
    { caller: auth.caller, runId: id, leaseId: body?.leaseId, results: body?.results, now: new Date() },
    dbScoutRunnerHostStore,
  );
  return NextResponse.json(out.body, { status: out.status, headers: NO_STORE });
}

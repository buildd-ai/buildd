/**
 * POST /api/quality-scout/runs/[id]/evidence/[evidenceId]/confirm  { leaseId }
 *
 * The runner calls this after a 2xx PUT to the URL [id]/evidence signed. The
 * server HEADs the object on the row's own backend and settles the row:
 * `stored` when it exists with the signed size, `failed` otherwise
 * (lib/evidence-confirm.ts). Until then the row is `pending` and reads refuse it.
 *
 * Same lease check as the upload route; the object must be this run's.
 * Idempotent. Never a 5xx: a bucket that cannot be checked now is a 424 and
 * the row stays pending (the evidence indexer's reaper settles it later).
 */
import { NextRequest, NextResponse } from 'next/server';
import { confirmEvidenceUpload } from '@/lib/evidence-confirm';
import { findScoutRunEvidenceObject } from '@/lib/evidence-read';
import { checkScoutRunLease } from '@/lib/quality-scout-runner-host';
import { dbScoutRunnerHostStore } from '@/lib/quality-scout-runner-host-store';
import { isUuid } from '@/lib/uuid';
import { fail, NO_STORE, resolveScoutHostCaller } from '../../../../caller';

const MAX_BODY_BYTES = 1024;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; evidenceId: string }> }) {
  const { id, evidenceId } = await params;
  if (!isUuid(id)) return fail(404, 'Scout run not found', 'run_not_found');
  if (!isUuid(evidenceId)) return fail(404, 'Evidence object not found', 'evidence_not_found');

  const auth = await resolveScoutHostCaller(req);
  if (!auth.ok) return auth.response;

  const text = await req.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return fail(413, `Body over ${MAX_BODY_BYTES} bytes`, 'payload_too_large');
  let body: { leaseId?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, 'Invalid JSON body');
  }

  const held = await checkScoutRunLease(auth.caller, id, body?.leaseId, new Date(), dbScoutRunnerHostStore);
  if (!held.ok) return NextResponse.json(held.body, { status: held.status, headers: NO_STORE });

  try {
    const row = await findScoutRunEvidenceObject({ id: held.run.id, workspaceId: held.run.workspaceId }, evidenceId);
    if (!row) return fail(404, 'Evidence object not found', 'evidence_not_found');
    const result = await confirmEvidenceUpload(row);
    return NextResponse.json(
      { evidenceId, uploadState: result.uploadState, bytes: result.bytes, ...(result.reason ? { reason: result.reason } : {}) },
      { status: result.uploadState === 'pending' ? 424 : 200, headers: NO_STORE },
    );
  } catch {
    return NextResponse.json({ error: 'Evidence storage unavailable', evidenceId, uploadState: 'pending' }, { status: 424, headers: NO_STORE });
  }
}

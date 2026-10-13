import { NextRequest, NextResponse } from 'next/server';
import { listSpecMetadataChanges, updateSpecMetadata } from '@/lib/specs/metadata';
import { specCaller } from '@/lib/specs/caller';

type Ctx = { params: Promise<{ specId: string }> };

/**
 * GET /api/specs/[specId]/metadata: the spec's metadata block (living-specs.md
 * §18, R-14) and its change log, newest first.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const r = await listSpecMetadataChanges(caller, specId);
  return r.ok ? NextResponse.json({ metadata: r.metadata, changes: r.changes }) : NextResponse.json({ error: r.error }, { status: r.status });
}

/**
 * PATCH /api/specs/[specId]/metadata { changes: { verified_by?, surfaces?,
 * last_verified?, assertions?, owner? }, reason }: change the metadata block
 * without a new revision (R-31). Write access is enough, an agent or CI
 * included; the version, the approved revision and its hash do not move.
 */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'changes and reason are required' }, { status: 400 });
  const r = await updateSpecMetadata(caller, specId, body as { changes: unknown; reason: unknown });
  return r.ok
    ? NextResponse.json({ spec: { id: r.spec.id, version: r.spec.version, approvedRevision: r.spec.approvedRevision, metadata: r.spec.metadata ?? {} }, changed: r.changed })
    : NextResponse.json({ error: r.error }, { status: r.status });
}

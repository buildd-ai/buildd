/**
 * POST /api/evidence-backends/[id]/verify — probe a backend now (admin|owner).
 *
 * Writes, reads back and deletes one object under `{prefix}/.buildd-probe/`;
 * never lists the bucket. A failing probe is a 200 with `status: "failing"`:
 * the backend is reporting its own health, not the request failing.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { evidenceBackends } from '@buildd/core/db/schema';
import { resolveExperimentViewer } from '@/lib/experiment-access';
import { verifyEvidenceBackend } from '@/lib/evidence-backend';
import { isUuid } from '@/lib/uuid';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const notFound = NextResponse.json({ error: 'Evidence backend not found' }, { status: 404 });
  if (!isUuid(id)) return notFound;

  const who = await resolveExperimentViewer(req, req.nextUrl.searchParams.get('workspaceId'));
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const { viewer } = who;

  const row = await db.query.evidenceBackends.findFirst({
    where: eq(evidenceBackends.id, id),
    columns: { id: true, teamId: true },
  });
  if (!row || row.teamId !== viewer.teamId) return notFound;
  if (viewer.role !== 'admin' && viewer.role !== 'owner') {
    return NextResponse.json({ error: 'Verifying evidence storage requires team admin or owner' }, { status: 403 });
  }

  return NextResponse.json(await verifyEvidenceBackend(row.id));
}

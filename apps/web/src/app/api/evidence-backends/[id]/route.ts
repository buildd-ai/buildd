/**
 * /api/evidence-backends/[id]
 *
 * GET     one backend (any team member who can reach its workspace, if scoped).
 * PATCH   update (admin|owner). `provider` and `workspaceId` are fixed at
 *         creation. Sending `credentials` replaces the stored credential. The
 *         backend is re-verified on save.
 * DELETE  remove the backend and its credential (admin|owner). Evidence
 *         pointers already written keep their row with no backend.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { evidenceBackends } from '@buildd/core/db/schema';
import { getSecretsProvider } from '@buildd/core/secrets';
import { resolveExperimentViewer } from '@/lib/experiment-access';
import {
  EVIDENCE_CREDENTIAL_PURPOSE,
  toEvidenceBackendDTO,
  validateEvidenceEndpoint,
  verifyEvidenceBackend,
} from '@/lib/evidence-backend';
import { parseUpdateEvidenceBackend } from '@/lib/evidence-backend-input';
import { filterReachableEvidenceBackends } from '@/lib/evidence-backend-access';
import { isUuid } from '@/lib/uuid';
import { roleHas, getTeamPermissionOverrides } from '@/lib/permissions';

type RouteContext = { params: Promise<{ id: string }> };

const notFound = () => NextResponse.json({ error: 'Evidence backend not found' }, { status: 404 });

async function load(req: NextRequest, id: string) {
  if (!isUuid(id)) return { res: notFound() };
  const who = await resolveExperimentViewer(req, req.nextUrl.searchParams.get('workspaceId'));
  if (!who.ok) return { res: NextResponse.json({ error: who.error }, { status: who.status }) };
  const row = await db.query.evidenceBackends.findFirst({ where: eq(evidenceBackends.id, id) });
  // Another team's backend, or a workspace backend the caller cannot reach,
  // answers exactly like a missing one.
  if (!row || row.teamId !== who.viewer.teamId) return { res: notFound() };
  if ((await filterReachableEvidenceBackends(who.viewer, [row])).length === 0) return { res: notFound() };
  return { viewer: who.viewer, row };
}

export async function GET(req: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const found = await load(req, id);
  if (!found.row) return found.res;
  return NextResponse.json({ backend: toEvidenceBackendDTO(found.row) });
}

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const found = await load(req, id);
  if (!found.row) return found.res;
  const { viewer, row } = found;
  if (!roleHas(viewer.role, 'manage_evidence_backends', await getTeamPermissionOverrides(viewer.teamId))) {
    return NextResponse.json({ error: 'Configuring evidence storage requires team admin or owner' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = parseUpdateEvidenceBackend(body, row.provider, { sse: row.sse, kmsKeyId: row.kmsKeyId ?? null });
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { credentials, ...fields } = parsed.value;

  if (fields.endpoint) {
    const check = await validateEvidenceEndpoint(fields.endpoint);
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
  }

  let credentialSecretId = row.credentialSecretId;
  if (credentials) {
    credentialSecretId = await getSecretsProvider().set(row.credentialSecretId ?? null, JSON.stringify(credentials), {
      teamId: row.teamId,
      purpose: EVIDENCE_CREDENTIAL_PURPOSE,
      label: 'evidence-backend',
    });
  }

  const now = new Date();
  await db.update(evidenceBackends)
    .set({ ...fields, credentialSecretId, status: 'unverified', updatedAt: now })
    .where(eq(evidenceBackends.id, row.id));

  const verification = await verifyEvidenceBackend(row.id);
  const saved = await db.query.evidenceBackends.findFirst({ where: eq(evidenceBackends.id, row.id) });
  return NextResponse.json({ backend: toEvidenceBackendDTO(saved ?? row), verification });
}

export async function DELETE(req: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const found = await load(req, id);
  if (!found.row) return found.res;
  const { viewer, row } = found;
  if (!roleHas(viewer.role, 'manage_evidence_backends', await getTeamPermissionOverrides(viewer.teamId))) {
    return NextResponse.json({ error: 'Configuring evidence storage requires team admin or owner' }, { status: 403 });
  }

  await db.delete(evidenceBackends).where(eq(evidenceBackends.id, row.id));
  if (row.credentialSecretId) await getSecretsProvider().delete(row.credentialSecretId).catch(() => {});
  return NextResponse.json({ deleted: true, id: row.id });
}

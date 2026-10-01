/**
 * /api/evidence-backends — where a team's run evidence is stored
 * (docs/specs/byo-evidence-storage.md, "Backend configuration").
 *
 * GET   list the team's backends (any team member). A workspace-scoped backend
 *       is listed only to callers who can reach that workspace. Credentials are
 *       reported as `hasCredential`, never returned.
 * POST  create one (admin|owner). A workspace-scoped create needs the same
 *       reach to that workspace as a read (404 otherwise). An endpoint that resolves to a private or
 *       link-local address is a 400. The new backend is verified on save; a
 *       failing probe is reported in `verification`, it does not reject the save.
 *
 * `?workspaceId=` (optional) resolves the team through that workspace. A body
 * `workspaceId` scopes the backend to one workspace; without it the backend is
 * the team default.
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { evidenceBackends, workspaces } from '@buildd/core/db/schema';
import { getSecretsProvider } from '@buildd/core/secrets';
import { config } from '@buildd/core/config';
import { resolveExperimentViewer } from '@/lib/experiment-access';
import {
  EVIDENCE_CREDENTIAL_PURPOSE,
  toEvidenceBackendDTO,
  validateEvidenceEndpoint,
  verifyEvidenceBackend,
} from '@/lib/evidence-backend';
import { parseCreateEvidenceBackend } from '@/lib/evidence-backend-input';
import { filterReachableEvidenceBackends, viewerReachesWorkspace } from '@/lib/evidence-backend-access';

const isAdmin = (role: string) => role === 'admin' || role === 'owner';

export async function GET(req: NextRequest) {
  const who = await resolveExperimentViewer(req, req.nextUrl.searchParams.get('workspaceId'));
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const { viewer } = who;

  const rows = await db.query.evidenceBackends.findMany({
    where: eq(evidenceBackends.teamId, viewer.teamId),
    orderBy: [desc(evidenceBackends.createdAt)],
  });
  const visible = await filterReachableEvidenceBackends(viewer, rows);
  return NextResponse.json({ backends: visible.map(toEvidenceBackendDTO), canManage: isAdmin(viewer.role) });
}

export async function POST(req: NextRequest) {
  const who = await resolveExperimentViewer(req, req.nextUrl.searchParams.get('workspaceId'));
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const { viewer } = who;
  if (!isAdmin(viewer.role)) {
    return NextResponse.json({ error: 'Configuring evidence storage requires team admin or owner' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = parseCreateEvidenceBackend(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const input = parsed.value;

  if (input.workspaceId) {
    const ws = await db.query.workspaces.findFirst({
      where: and(eq(workspaces.id, input.workspaceId), eq(workspaces.teamId, viewer.teamId)),
      columns: { id: true },
    });
    // Same reach rule as GET/PATCH/DELETE/verify, checked before the 409
    // lookup: a team admin key not linked to a restricted workspace must not
    // point its future evidence at a bucket of the caller's choosing, nor learn
    // from a 409 that the workspace already has a backend.
    if (!ws || !(await viewerReachesWorkspace(viewer, input.workspaceId))) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
  }

  if (input.endpoint) {
    const check = await validateEvidenceEndpoint(input.endpoint);
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
  }

  // No unique index on (team, workspace): one backend per scope is enforced here.
  const existing = await db.query.evidenceBackends.findFirst({
    where: and(
      eq(evidenceBackends.teamId, viewer.teamId),
      input.workspaceId ? eq(evidenceBackends.workspaceId, input.workspaceId) : isNull(evidenceBackends.workspaceId),
    ),
    columns: { id: true },
  });
  if (existing) {
    return NextResponse.json({
      error: input.workspaceId
        ? 'This workspace already has an evidence backend; update or delete it first'
        : 'This team already has a default evidence backend; update or delete it first',
    }, { status: 409 });
  }

  let secretId: string | null = null;
  if (input.credentials) {
    secretId = await getSecretsProvider().set(null, JSON.stringify(input.credentials), {
      teamId: viewer.teamId,
      purpose: EVIDENCE_CREDENTIAL_PURPOSE,
      label: 'evidence-backend',
    });
  }

  let row;
  try {
    [row] = await db.insert(evidenceBackends).values({
      teamId: viewer.teamId,
      workspaceId: input.workspaceId,
      provider: input.provider,
      endpoint: input.endpoint,
      region: input.region,
      bucket: input.provider === 'buildd_default' ? config.storageBucket : input.bucket,
      prefix: input.prefix,
      forcePathStyle: input.forcePathStyle,
      credentialSecretId: secretId,
      sse: input.sse,
      kmsKeyId: input.kmsKeyId,
      retentionDays: input.retentionDays,
      maxBytesPerTask: input.maxBytesPerTask,
    }).returning();
  } catch (err) {
    if (secretId) await getSecretsProvider().delete(secretId).catch(() => {});
    throw err;
  }

  const verification = await verifyEvidenceBackend(row.id);
  const saved = await db.query.evidenceBackends.findFirst({ where: eq(evidenceBackends.id, row.id) });
  return NextResponse.json({ backend: toEvidenceBackendDTO(saved ?? row), verification }, { status: 201 });
}

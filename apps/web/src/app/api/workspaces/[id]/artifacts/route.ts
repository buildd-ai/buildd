import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { artifacts } from '@buildd/core/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { appBaseUrl } from '@/lib/app-url';
import { ARTIFACT_TYPES, isArtifactType } from '@buildd/shared';

async function authenticateRequest(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  const account = await authenticateApiKey(apiKey);
  if (account) return { type: 'api' as const, account };

  if (process.env.NODE_ENV !== 'development') {
    const user = await getCurrentUser();
    if (user) return { type: 'session' as const, user };
  } else {
    return { type: 'dev' as const };
  }

  return null;
}

// GET /api/workspaces/[id]/artifacts - Query artifacts by workspace
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await authenticateRequest(req);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify workspace access
  if (auth.type === 'session') {
    const access = await verifyWorkspaceAccess(auth.user.id, id);
    if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  } else if (auth.type === 'api') {
    const hasAccess = await verifyAccountWorkspaceAccess(auth.account.id, id);
    if (!hasAccess) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  const url = new URL(req.url);
  const missionId = url.searchParams.get('missionId');
  const key = url.searchParams.get('key');
  const type = url.searchParams.get('type');
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '10'), 1), 50);

  // Build conditions
  const conditions = [eq(artifacts.workspaceId, id)];
  if (missionId) conditions.push(eq(artifacts.missionId, missionId));
  if (key) conditions.push(eq(artifacts.key, key));
  if (type) conditions.push(eq(artifacts.type, type));

  const results = await db.query.artifacts.findMany({
    where: and(...conditions),
    orderBy: [desc(artifacts.updatedAt)],
    limit,
  });

  const baseUrl = appBaseUrl();

  const artifactsWithUrls = results.map(a => ({
    ...a,
    // Only a public artifact has a link anyone can follow.
    shareUrl: a.shareToken && a.visibility === 'public'
      ? `${baseUrl}/share/${a.shareToken}`
      : null,
  }));

  return NextResponse.json({ artifacts: artifactsWithUrls });
}

/**
 * POST /api/workspaces/[id]/artifacts — create or upsert a workspace-level
 * artifact, with no owning mission/initiative/worker.
 *
 * Every other artifact-create route (mission, initiative, worker) requires
 * an owning entity, but a durable per-repo CI marker — e.g. the §4 delta
 * gate's `spec-conformance-last-sha` keyed artifact in
 * docs/design/spec-conformance.md — has none: it must outlive any mission
 * that happens to be open when it's first written. `artifacts_workspace_key_idx`
 * (UNIQUE on workspaceId, key) already gives this the upsert semantics the
 * design calls for; this route is the missing write path to it. Admin API
 * key only — this is a machine/CI credential operation, not a user-facing
 * artifact flow, so it does not accept session auth the way GET does.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (apiAccount.level !== 'admin') {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }

  const hasAccess = await verifyAccountWorkspaceAccess(apiAccount.id, id);
  if (!hasAccess) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  const body = await req.json();
  const { type, title, content, url, metadata, key } = body;

  if (!isArtifactType(type)) {
    return NextResponse.json(
      { error: `Invalid type. Must be one of: ${ARTIFACT_TYPES.join(', ')}` },
      { status: 400 }
    );
  }
  if (!title || typeof title !== 'string') {
    return NextResponse.json({ error: 'title is required' }, { status: 400 });
  }
  if (!key || typeof key !== 'string') {
    return NextResponse.json({ error: 'key is required for a workspace-level artifact' }, { status: 400 });
  }

  const artifactMetadata = {
    ...(metadata || {}),
    ...(url ? { url } : {}),
  };

  const existing = await db.query.artifacts.findFirst({
    where: and(eq(artifacts.workspaceId, id), eq(artifacts.key, key)),
  });

  if (existing) {
    const [updated] = await db
      .update(artifacts)
      .set({
        title,
        content: content || null,
        metadata: artifactMetadata,
        type,
        updatedAt: new Date(),
      })
      .where(eq(artifacts.id, existing.id))
      .returning();

    return NextResponse.json({ artifact: { ...updated, shareUrl: null }, upserted: true });
  }

  const [artifact] = await db
    .insert(artifacts)
    .values({
      workerId: null,
      workspaceId: id,
      missionId: null,
      key,
      type,
      title,
      content: content || null,
      shareToken: null,
      visibility: 'private',
      metadata: artifactMetadata,
    })
    .returning();

  return NextResponse.json({ artifact: { ...artifact, shareUrl: null } });
}

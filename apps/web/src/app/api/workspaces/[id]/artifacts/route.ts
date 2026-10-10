import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { artifacts } from '@buildd/core/db/schema';
import { eq, and, desc, like, gte, lt } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { appBaseUrl } from '@/lib/app-url';
import { reviewArtifactScope } from '@/lib/artifact-scope';
import { ARTIFACT_TYPES, isArtifactType } from '@buildd/shared';
import { isUuid } from '@/lib/uuid';
import { notifyTeamOf, type NotifyPayload } from '@/lib/notify';
import { isReviewArtifact } from '@/lib/artifact-prominence';
import { upsertedContent } from '@/lib/artifact-upsert-content';

/** GET's auth. A per-task token is accepted here and confined in GET. */
async function authenticateRequest(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  const account = await authenticateTaskScopedCaller(apiKey, req);
  if (account) return { type: 'api' as const, account };

  if (process.env.NODE_ENV !== 'development') {
    const user = await getCurrentUser();
    if (user) return { type: 'session' as const, user };
  } else {
    return { type: 'dev' as const };
  }

  return null;
}

async function notifyWorkspaceArtifact(
  artifact: Record<string, unknown>,
  workspaceId: string
): Promise<void> {
  try {
    // Only notify for review artifacts; don't expose content in push.
    const typedArtifact = artifact as { title?: string; id?: string; type?: string };
    if (!isReviewArtifact(typedArtifact as any)) return;

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev';
    const artifactUrl = `${baseUrl}/app/workspaces/${workspaceId}/artifacts?artifact=${typedArtifact.id}`;

    const payload: NotifyPayload = {
      title: `Artifact ready: ${typedArtifact.title}`,
      message: `A ${typedArtifact.type} artifact is ready for review.`,
      url: artifactUrl,
      urlTitle: 'View artifact',
      priority: -1,
    };

    await notifyTeamOf(
      { workspaceId },
      'artifactReady',
      payload
    );
  } catch (err) {
    // Non-fatal: notifications must never block artifact creation.
    console.error('[workspace-artifact-notify] Failed to notify:', err instanceof Error ? err.message : 'unknown');
  }
}

function parseTime(raw: string | null): Date | null | 'invalid' {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? 'invalid' : d;
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
    // A per-task token lists artifacts only in its own task's workspace.
    if (!taskScopeAllowsWorkspace(auth.account, id)) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    const hasAccess = await verifyAccountWorkspaceAccess(auth.account, id);
    if (!hasAccess) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  const url = new URL(req.url);
  const missionId = url.searchParams.get('missionId');
  const key = url.searchParams.get('key');
  const type = url.searchParams.get('type');

  // A non-UUID can never name a mission; querying with one throws 22P02 (a 500).
  if (missionId && !isUuid(missionId)) {
    return NextResponse.json({ error: `Invalid missionId: expected a UUID, got "${missionId}". Pass the full UUID.` }, { status: 400 });
  }
  // `keyPrefix` + `since`/`before` (on updatedAt) list a keyed family of
  // artifacts over a window and page through it: results are newest first, so
  // the next page is `before=<oldest updatedAt seen>`. Used by the cloud
  // runner's eval report for `cloud-run-report:<workerId>`.
  const keyPrefix = url.searchParams.get('keyPrefix');
  const since = parseTime(url.searchParams.get('since'));
  const before = parseTime(url.searchParams.get('before'));
  if (since === 'invalid' || before === 'invalid') {
    return NextResponse.json({ error: 'since and before must be ISO 8601 timestamps' }, { status: 400 });
  }
  // `review=true` narrows to artifacts deliberately produced for a human to
  // read, using the same rule as the dashboard — see `@/lib/artifact-scope`.
  // Applied in SQL, not after the fact, so `limit` counts matching rows.
  const reviewOnly = url.searchParams.get('review') === 'true';
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '10'), 1), 50);

  // Build conditions
  const conditions = [eq(artifacts.workspaceId, id)];
  if (missionId) conditions.push(eq(artifacts.missionId, missionId));
  if (key) conditions.push(eq(artifacts.key, key));
  if (type) conditions.push(eq(artifacts.type, type));
  if (keyPrefix) conditions.push(like(artifacts.key, `${keyPrefix.replace(/[\\%_]/g, c => `\\${c}`)}%`));
  if (since) conditions.push(gte(artifacts.updatedAt, since));
  if (before) conditions.push(lt(artifacts.updatedAt, before));
  if (reviewOnly) conditions.push(reviewArtifactScope());

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
  const apiAccount = await authenticateApiKey(apiKey, req);

  if (!apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!hasTokenRouteAdminAccess(apiAccount, req)) {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }

  const hasAccess = await verifyAccountWorkspaceAccess(apiAccount, id);
  if (!hasAccess) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  const body = await req.json();
  const { type, title, content, url, metadata, key, notifyOnCreate } = body;

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
        content: upsertedContent(existing.content, content),
        metadata: artifactMetadata,
        type,
        updatedAt: new Date(),
      })
      .where(eq(artifacts.id, existing.id))
      .returning();

    // Notify if opted in and content or title changed (not on every upsert).
    if (notifyOnCreate && (existing.content !== upsertedContent(existing.content, content) || existing.title !== title)) {
      await notifyWorkspaceArtifact(updated, id);
    }

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

  // Notify if opted in.
  if (notifyOnCreate) {
    await notifyWorkspaceArtifact(artifact, id);
  }

  return NextResponse.json({ artifact: { ...artifact, shareUrl: null } });
}

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missions, artifacts } from '@buildd/core/db/schema';
import { eq, and, inArray, desc, sql } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { authenticateTaskScopedCaller, taskScopeAllowsMission, taskScopeAllowsTask } from '@/lib/task-token-auth';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { ARTIFACT_TYPES, ArtifactType, isArtifactType } from '@buildd/shared';
import { appBaseUrl } from '@/lib/app-url';
import { isUuid } from '@/lib/uuid';
import { workspaceOpenToCaller } from '@/lib/open-workspaces';
import { shouldNotifyOnArtifact, notifyArtifactReady } from '@/lib/artifact-notify';
import { upsertedContent } from '@/lib/artifact-upsert-content';


/**
 * POST /api/missions/[id]/artifacts — create an artifact linked to a mission
 * Does NOT require a worker context. Auth: API key (admin) or session.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid mission id: expected a UUID, got "${id}". Pass the full UUID.` }, { status: 404 });
  }

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  // A per-task token writes only to its own task's mission.
  const apiAccount = await authenticateTaskScopedCaller(apiKey, req);
  const user = await getCurrentUser();

  if (!apiAccount && !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (apiAccount && !(await taskScopeAllowsMission(apiAccount, id))) {
    return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
  }

  // Verify mission exists and belongs to user's team
  const teamIds = await resolveAccountTeamIds(user, apiAccount);

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, id),
    columns: { id: true, teamId: true, workspaceId: true },
  });

  if (!mission) {
    return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
  }
  if (!teamIds.includes(mission.teamId)) {
    // Allow access to open-access workspace missions
    let allowed = false;
    if (mission.workspaceId) {
      if (await workspaceOpenToCaller(mission.workspaceId, { teamIds, accountId: apiAccount?.id })) allowed = true;
    }
    if (!allowed) {
      return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    }
  }

  const body = await req.json();
  const { type, title, content, url, metadata, key, taskId } = body;

  // Single vocabulary (@buildd/shared ARTIFACT_TYPES) — see the note in
  // packages/shared/src/types.ts on why no route keeps its own list.
  if (!isArtifactType(type)) {
    return NextResponse.json(
      { error: `Invalid type. Must be one of: ${ARTIFACT_TYPES.join(', ')}` },
      { status: 400 }
    );
  }

  if (!title || typeof title !== 'string') {
    return NextResponse.json({ error: 'title is required' }, { status: 400 });
  }

  if (type === ArtifactType.LINK && !url) {
    return NextResponse.json({ error: 'url is required for link artifacts' }, { status: 400 });
  }
  // `taskId` addresses a review notification: a task token names only its own task.
  if (apiAccount && taskId && !taskScopeAllowsTask(apiAccount, taskId)) {
    return NextResponse.json({ error: 'A task token may name only its own task' }, { status: 403 });
  }

  const artifactMetadata = {
    ...(metadata || {}),
    ...(url ? { url } : {}),
  };

  const baseUrl = appBaseUrl();

  // Upsert by (workspaceId, key) if key provided
  if (key && typeof key === 'string' && mission.workspaceId) {
    const existing = await db.query.artifacts.findFirst({
      where: and(
        eq(artifacts.workspaceId, mission.workspaceId),
        eq(artifacts.key, key),
      ),
    });

    // A key is unique per workspace, so the upsert can land on any artifact
    // there. A task token may take over only this mission's own
    // mission-level artifact, never a worker's or another mission's.
    if (existing && apiAccount?.taskScope && (existing.missionId !== id || existing.workerId || existing.initiativeId)) {
      return NextResponse.json({ error: 'That key belongs to an artifact outside this mission' }, { status: 409 });
    }

    if (existing) {
      const [updated] = await db
        .update(artifacts)
        .set({
          title,
          content: upsertedContent(existing.content, content),
          contentAuthor: apiAccount ? `account:${apiAccount.id}` : `user:${user!.id}`,
          metadata: artifactMetadata,
          type,
          missionId: id,
          updatedAt: new Date(),
        })
        .where(eq(artifacts.id, existing.id))
        .returning();

      // Preserve any existing token; only expose a live URL if still shared.
      const shareUrl = updated.shareToken && updated.visibility === 'public'
        ? `${baseUrl}/share/${updated.shareToken}`
        : null;

      // Notify if this artifact is meant for review, the task opted in, and content or title changed.
      if (taskId && mission.workspaceId) {
        const shouldNotify = await shouldNotifyOnArtifact(updated, taskId);
        if (shouldNotify && (existing.content !== upsertedContent(existing.content, content) || existing.title !== title)) {
          await notifyArtifactReady(updated, taskId, mission.workspaceId);
        }
      }

      return NextResponse.json({ artifact: { ...updated, shareUrl }, upserted: true });
    }
  }

  // Artifacts are PRIVATE by default; no share token until an explicit Share action.
  const [artifact] = await db
    .insert(artifacts)
    .values({
      workerId: null,
      workspaceId: mission.workspaceId || null,
      missionId: id,
      key: key || null,
      type,
      title,
      content: content || null,
      contentAuthor: apiAccount ? `account:${apiAccount.id}` : `user:${user!.id}`,
      shareToken: null,
      visibility: 'private',
      metadata: artifactMetadata,
    })
    .returning();

  // Notify if this artifact is meant for review and the task opted in.
  if (taskId && mission.workspaceId) {
    const shouldNotify = await shouldNotifyOnArtifact(artifact, taskId);
    if (shouldNotify) {
      await notifyArtifactReady(artifact, taskId, mission.workspaceId);
    }
  }

  return NextResponse.json({ artifact: { ...artifact, shareUrl: null } });
}

/** `?limit` ceiling, and the body `?preview=1` keeps. */
const MAX_LIST_LIMIT = 200;
const PREVIEW_CHARS = 2048;

type ListQuery = { types: string[] | null; limit: number | null; preview: boolean };

/** Parse the optional list filters. A malformed one is an error, never ignored. */
function parseListQuery(sp: URLSearchParams): ListQuery | string {
  let types: string[] | null = null;
  const rawTypes = sp.get('types');
  if (rawTypes !== null) {
    const list = rawTypes.split(',').map(t => t.trim()).filter(Boolean);
    const bad = list.filter(t => !isArtifactType(t));
    if (list.length === 0 || bad.length > 0) {
      return `Invalid types: ${bad.join(', ') || '(empty)'}. Each must be one of: ${ARTIFACT_TYPES.join(', ')}`;
    }
    types = list;
  }
  let limit: number | null = null;
  const rawLimit = sp.get('limit');
  if (rawLimit !== null) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1) return 'limit must be a positive integer';
    limit = Math.min(n, MAX_LIST_LIMIT);
  }
  const preview = sp.get('preview') === '1' || sp.get('preview') === 'true';
  return { types, limit, preview };
}

/**
 * GET /api/missions/[id]/artifacts — list artifacts for a mission.
 *
 * Optional, for callers that need a bounded read (get_visual_review):
 * - `?types=screenshot,report` — only those types, filtered in SQL.
 * - `?limit=N` — newest N by updatedAt (max 200).
 * - `?preview=1` — `content` is its first 2KB, cut in SQL, never the full body.
 * With none of them the response is the whole list, as it always was.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid mission id: expected a UUID, got "${id}". Pass the full UUID.` }, { status: 404 });
  }

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey, req);
  const user = await getCurrentUser();

  if (!apiAccount && !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const teamIds = await resolveAccountTeamIds(user, apiAccount);

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, id),
    columns: { id: true, teamId: true, workspaceId: true },
  });

  if (!mission) {
    return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
  }
  if (!teamIds.includes(mission.teamId)) {
    let allowed = false;
    if (mission.workspaceId) {
      if (await workspaceOpenToCaller(mission.workspaceId, { teamIds, accountId: apiAccount?.id })) allowed = true;
    }
    if (!allowed) {
      return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    }
  }

  const q = parseListQuery(req.nextUrl.searchParams);
  if (typeof q === 'string') {
    return NextResponse.json({ error: q }, { status: 400 });
  }

  const byMission = eq(artifacts.missionId, id);
  const rows = await db.query.artifacts.findMany({
    where: q.types ? and(byMission, inArray(artifacts.type, q.types)) : byMission,
    ...(q.limit !== null ? { limit: q.limit, orderBy: [desc(artifacts.updatedAt)] } : {}),
    ...(q.preview
      ? {
          columns: { content: false },
          extras: { contentPreview: sql<string | null>`left(${artifacts.content}, ${PREVIEW_CHARS})`.as('content_preview') },
        }
      : {}),
  }) as Array<Record<string, unknown> & { type: string; contentPreview?: string | null }>;

  // The SQL predicate is the filter; this only guarantees the response honours it.
  const types = q.types;
  const typed = types ? rows.filter(a => types.includes(a.type)) : rows;
  const out = q.preview
    ? typed.map(({ contentPreview, ...a }) => ({ ...a, content: typeof contentPreview === 'string' ? contentPreview.slice(0, PREVIEW_CHARS) : null }))
    : typed;

  return NextResponse.json({ artifacts: out });
}

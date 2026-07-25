import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { initiatives, missions, artifacts, workspaces } from '@buildd/core/db/schema';
import { eq, and, or, inArray } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { ArtifactType } from '@buildd/shared';

const VALID_TYPES = new Set([
  ArtifactType.CONTENT,
  ArtifactType.REPORT,
  ArtifactType.DATA,
  ArtifactType.LINK,
  ArtifactType.SUMMARY,
  ArtifactType.FILE,
  ArtifactType.ANALYSIS,
  ArtifactType.RECOMMENDATION,
]);

/** Load the initiative and enforce access; returns the row or a NextResponse error. */
async function loadInitiative(id: string, teamIds: string[]) {
  const initiative = await db.query.initiatives.findFirst({
    where: eq(initiatives.id, id),
    columns: { id: true, teamId: true, workspaceId: true },
  });
  if (!initiative) return { error: NextResponse.json({ error: 'Initiative not found' }, { status: 404 }) };
  if (!teamIds.includes(initiative.teamId)) {
    let allowed = false;
    if (initiative.workspaceId) {
      const ws = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, initiative.workspaceId),
        columns: { accessMode: true },
      });
      if (ws?.accessMode === 'open') allowed = true;
    }
    if (!allowed) return { error: NextResponse.json({ error: 'Initiative not found' }, { status: 404 }) };
  }
  return { initiative };
}

/**
 * GET /api/initiatives/[id]/artifacts — initiative-level artifacts PLUS rolled-up
 * artifacts from every child mission, in one call (no tree-walking by the caller).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);
  const user = await getCurrentUser();

  if (!apiAccount && !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const teamIds = await resolveAccountTeamIds(user, apiAccount);
  const { initiative, error } = await loadInitiative(id, teamIds);
  if (error) return error;

  // Child mission ids for the rollup.
  const childMissions = await db.query.missions.findMany({
    where: eq(missions.initiativeId, id),
    columns: { id: true },
  });
  const missionIds = childMissions.map((m) => m.id);

  const filter = missionIds.length > 0
    ? or(eq(artifacts.initiativeId, id), inArray(artifacts.missionId, missionIds))
    : eq(artifacts.initiativeId, id);

  const rolledUp = await db.query.artifacts.findMany({ where: filter });

  return NextResponse.json({ artifacts: rolledUp });
}

/**
 * POST /api/initiatives/[id]/artifacts — create an initiative-level artifact
 * (roadmap/spec) not tied to a specific mission. Auth: API key (admin) or session.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);
  const user = await getCurrentUser();

  if (!apiAccount && !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const teamIds = await resolveAccountTeamIds(user, apiAccount);
  const { initiative, error } = await loadInitiative(id, teamIds);
  if (error) return error;

  const body = await req.json();
  const { type, title, content, url, metadata, key } = body;

  if (!type || !VALID_TYPES.has(type)) {
    return NextResponse.json(
      { error: `Invalid type. Must be one of: ${[...VALID_TYPES].join(', ')}` },
      { status: 400 }
    );
  }
  if (!title || typeof title !== 'string') {
    return NextResponse.json({ error: 'title is required' }, { status: 400 });
  }
  if (type === ArtifactType.LINK && !url) {
    return NextResponse.json({ error: 'url is required for link artifacts' }, { status: 400 });
  }

  const artifactMetadata = {
    ...(metadata || {}),
    ...(url ? { url } : {}),
  };

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'https://buildd.dev';

  // Upsert by (workspaceId, key) if key provided and the initiative is workspace-scoped.
  if (key && typeof key === 'string' && initiative!.workspaceId) {
    const existing = await db.query.artifacts.findFirst({
      where: and(
        eq(artifacts.workspaceId, initiative!.workspaceId),
        eq(artifacts.key, key),
      ),
    });
    if (existing) {
      const [updated] = await db
        .update(artifacts)
        .set({
          title,
          content: content || null,
          metadata: artifactMetadata,
          type,
          initiativeId: id,
          updatedAt: new Date(),
        })
        .where(eq(artifacts.id, existing.id))
        .returning();
      const shareUrl = `${baseUrl}/share/${updated.shareToken}`;
      return NextResponse.json({ artifact: { ...updated, shareUrl }, upserted: true });
    }
  }

  const shareToken = randomBytes(24).toString('base64url');

  const [artifact] = await db
    .insert(artifacts)
    .values({
      workerId: null,
      workspaceId: initiative!.workspaceId || null,
      initiativeId: id,
      key: key || null,
      type,
      title,
      content: content || null,
      shareToken,
      metadata: artifactMetadata,
    })
    .returning();

  const shareUrl = `${baseUrl}/share/${shareToken}`;

  return NextResponse.json({ artifact: { ...artifact, shareUrl } });
}

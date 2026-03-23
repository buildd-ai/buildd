import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missions, artifacts } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserTeamIds } from '@/lib/team-access';
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

/**
 * POST /api/missions/[id]/artifacts — create an artifact linked to a mission
 * Does NOT require a worker context. Auth: API key (admin) or session.
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

  // Verify mission exists and belongs to user's team
  let teamIds: string[] = [];
  if (apiAccount) {
    teamIds = [apiAccount.teamId];
  } else {
    teamIds = await getUserTeamIds(user!.id);
  }

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, id),
    columns: { id: true, teamId: true, workspaceId: true },
  });

  if (!mission || !teamIds.includes(mission.teamId)) {
    return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
  }

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

  // Upsert by (workspaceId, key) if key provided
  if (key && typeof key === 'string' && mission.workspaceId) {
    const existing = await db.query.artifacts.findFirst({
      where: and(
        eq(artifacts.workspaceId, mission.workspaceId),
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
          missionId: id,
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
      workspaceId: mission.workspaceId || null,
      missionId: id,
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

/**
 * GET /api/missions/[id]/artifacts — list artifacts for a mission
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

  let teamIds: string[] = [];
  if (apiAccount) {
    teamIds = [apiAccount.teamId];
  } else {
    teamIds = await getUserTeamIds(user!.id);
  }

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, id),
    columns: { id: true, teamId: true },
  });

  if (!mission || !teamIds.includes(mission.teamId)) {
    return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
  }

  const missionArtifacts = await db.query.artifacts.findMany({
    where: eq(artifacts.missionId, id),
  });

  return NextResponse.json({ artifacts: missionArtifacts });
}

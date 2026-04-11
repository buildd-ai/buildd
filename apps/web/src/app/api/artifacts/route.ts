import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { artifacts, missions, teamMembers } from '@buildd/core/db/schema';
import { eq, and, inArray, desc, isNotNull } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserTeamIds } from '@/lib/team-access';

// GET /api/artifacts — list artifacts for the user's team(s)
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (apiAccount && apiAccount.level !== 'admin') {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }

  try {
    let teamIds: string[] = [];
    if (apiAccount) {
      const ownerMembership = await db.query.teamMembers.findFirst({
        where: and(eq(teamMembers.teamId, apiAccount.teamId), eq(teamMembers.role, 'owner')),
        columns: { userId: true },
      });
      if (ownerMembership?.userId) {
        teamIds = await getUserTeamIds(ownerMembership.userId);
      } else {
        teamIds = [apiAccount.teamId];
      }
    } else {
      teamIds = await getUserTeamIds(user!.id);
    }

    if (teamIds.length === 0) {
      return NextResponse.json({ artifacts: [] });
    }

    const { searchParams } = new URL(req.url);
    const typeFilter = searchParams.get('type');
    const limitParam = searchParams.get('limit');
    const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 50, 100) : 50;

    // Get all mission IDs for the user's teams
    const teamMissions = await db.query.missions.findMany({
      where: inArray(missions.teamId, teamIds),
      columns: { id: true },
    });
    const missionIds = teamMissions.map(m => m.id);

    if (missionIds.length === 0) {
      return NextResponse.json({ artifacts: [] });
    }

    let where = inArray(artifacts.missionId, missionIds);
    if (typeFilter) {
      where = and(where, eq(artifacts.type, typeFilter))!;
    }

    const results = await db.query.artifacts.findMany({
      where,
      orderBy: [desc(artifacts.createdAt)],
      limit,
      with: {
        mission: { columns: { id: true, title: true } },
      },
    });

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'https://buildd.dev';

    const artifactsWithMeta = results.map(a => {
      const { mission: missionRel, ...artifactData } = a;
      return {
        ...artifactData,
        missionTitle: missionRel?.title ?? null,
        shareUrl: a.shareToken ? `${baseUrl}/share/${a.shareToken}` : null,
      };
    });

    return NextResponse.json({ artifacts: artifactsWithMeta });
  } catch (error) {
    console.error('List artifacts error:', error);
    return NextResponse.json({ error: 'Failed to list artifacts' }, { status: 500 });
  }
}

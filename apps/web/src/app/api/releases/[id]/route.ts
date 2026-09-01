import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, missions, workspaces, githubRepos } from '@buildd/core/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserTeamIds } from '@/lib/team-access';
import { getReleaseWithTaskEdges } from '@/lib/release-queries';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount && process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const found = await getReleaseWithTaskEdges(id);
  if (!found) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { release, edges } = found;

  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, release.workspaceId),
    columns: { id: true, name: true, teamId: true, githubRepoId: true },
  });

  if (!ws) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (apiAccount) {
    if (apiAccount.teamId !== ws.teamId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  } else if (user) {
    const teamIds = await getUserTeamIds(user.id);
    if (!teamIds.includes(ws.teamId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  let repoFullName: string | null = null;
  if (ws.githubRepoId) {
    const repoRow = await db.query.githubRepos.findFirst({
      where: eq(githubRepos.id, ws.githubRepoId),
      columns: { fullName: true },
    });
    repoFullName = repoRow?.fullName ?? null;
  }

  const commitRangeUrl =
    repoFullName && release.previousSha && release.headSha
      ? `https://github.com/${repoFullName}/compare/${release.previousSha}...${release.headSha}`
      : null;

  const missionIds = [...new Set(edges.map((e) => e.missionId).filter(Boolean) as string[])];
  const missionRows =
    missionIds.length > 0
      ? await db
          .select({ id: missions.id, title: missions.title })
          .from(missions)
          .where(inArray(missions.id, missionIds))
      : [];

  const [degradationTaskRow] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(
      sql`${tasks.context}->>'releaseId' = ${id}`,
      sql`${tasks.context}->>'type' = 'degradation'`,
    ))
    .limit(1);
  const degradationTaskId = degradationTaskRow?.id ?? null;

  return NextResponse.json({
    ...release,
    workspaceName: ws.name,
    commitRangeUrl,
    degradationTaskId,
    attributedTasks: edges.map((e) => ({
      taskId: e.taskId,
      prNumber: e.prNumber,
      commitSha: e.commitSha,
      title: e.taskTitle,
      status: e.taskStatus,
      missionId: e.missionId,
    })),
    attributedMissions: missionRows,
  });
}

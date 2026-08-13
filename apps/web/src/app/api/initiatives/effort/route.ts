import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, tasks, missions, workspaces } from '@buildd/core/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveAccountTeamIds } from '@/lib/team-access';

const WINDOW_DAYS = 14;

// GET /api/initiatives/effort?workspaceId=<id>
// Aggregates token usage and task outcome counts per initiative per day over the last 14 days.
// Workers are attributed by completedAt (falling back to updatedAt when null).
// Missions with no initiative are grouped under the 'unassigned' key.
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const workspaceId = searchParams.get('workspaceId');

  if (!workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
  }

  try {
    const teamIds = await resolveAccountTeamIds(user, apiAccount);

    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { id: true, teamId: true },
    });
    if (!ws || !teamIds.includes(ws.teamId)) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const rows = await db
      .select({
        initiativeId: missions.initiativeId,
        day: sql<string>`DATE(COALESCE(${workers.completedAt}, ${workers.updatedAt}) AT TIME ZONE 'UTC')`,
        tokens: sql<number>`SUM(${workers.inputTokens} + ${workers.outputTokens})`,
        merged: sql<number>`COUNT(*) FILTER (WHERE ${workers.status} = 'completed' AND ${workers.prUrl} IS NOT NULL)`,
        failed: sql<number>`COUNT(*) FILTER (WHERE ${workers.status} = 'error')`,
        open: sql<number>`COUNT(*) FILTER (WHERE ${workers.status} NOT IN ('completed', 'error'))`,
      })
      .from(workers)
      .innerJoin(tasks, eq(tasks.id, workers.taskId))
      .innerJoin(missions, eq(missions.id, tasks.missionId))
      .where(and(
        eq(missions.workspaceId, workspaceId),
        sql`COALESCE(${workers.completedAt}, ${workers.updatedAt}) >= ${cutoff}`,
      ))
      .groupBy(
        missions.initiativeId,
        sql`DATE(COALESCE(${workers.completedAt}, ${workers.updatedAt}) AT TIME ZONE 'UTC')`,
      );

    type DayEntry = { date: string; tokens: number; merged: number; failed: number; open: number };
    const grouped = new Map<string, DayEntry[]>();

    for (const row of rows) {
      const key = row.initiativeId ?? 'unassigned';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push({
        date: row.day,
        tokens: Number(row.tokens),
        merged: Number(row.merged),
        failed: Number(row.failed),
        open: Number(row.open),
      });
    }

    const efforts = Array.from(grouped.entries()).map(([initiativeId, days]) => ({
      initiativeId,
      days,
    }));

    return NextResponse.json({ efforts });
  } catch (error) {
    console.error('Initiative effort error:', error);
    return NextResponse.json({ error: 'Failed to load effort data' }, { status: 500 });
  }
}

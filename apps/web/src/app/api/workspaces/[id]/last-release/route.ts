import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { eq, desc, isNotNull, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess } from '@/lib/team-access';

/**
 * GET /api/workspaces/[id]/last-release
 *
 * Returns the most recent release result for this workspace (last task that has
 * a non-null releaseResult), plus a list of up to 5 recent release tasks.
 *
 * This feeds the Release section's status strip and recent-releases table on
 * the workspace config page. Data comes from tasks.releaseResult (DB), not from
 * the GitHub API — so it represents what actually ran, not what would run next.
 *
 * Auth: session user OR API key/OAuth token with workspace access.
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

    if (!apiAccount && !user && process.env.NODE_ENV !== 'development') {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        // Verify workspace exists and requester has access
        if (user && !apiAccount) {
            const access = await verifyWorkspaceAccess(user.id, id);
            if (!access) {
                return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
            }
        }
        if (apiAccount) {
            const ws = await db.query.workspaces.findFirst({
                where: eq(workspaces.id, id),
                columns: { teamId: true, accessMode: true },
            });
            if (!ws || (ws.teamId !== apiAccount.teamId && ws.accessMode !== 'open')) {
                return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
            }
        }

        // Fetch recent tasks with a releaseResult, ordered by updatedAt DESC.
        // updatedAt is set when a task transitions to completed/failed, so it
        // approximates completion time without requiring a worker join.
        const recentReleases = await db.query.tasks.findMany({
            where: and(
                eq(tasks.workspaceId, id),
                isNotNull(tasks.releaseResult),
            ),
            columns: {
                id: true,
                title: true,
                missionId: true,
                releaseResult: true,
                updatedAt: true,
                result: true,
            },
            orderBy: [desc(tasks.updatedAt)],
            limit: 5,
        });

        const lastRelease = recentReleases[0] ?? null;

        return NextResponse.json({
            lastRelease: lastRelease
                ? {
                    taskId: lastRelease.id,
                    taskTitle: lastRelease.title,
                    missionId: lastRelease.missionId,
                    completedAt: lastRelease.updatedAt,
                    releaseResult: lastRelease.releaseResult,
                    // Surface the short commit SHA from the task result if available
                    sha: (lastRelease.result as any)?.sha ?? null,
                }
                : null,
            recentReleases: recentReleases.map(t => ({
                taskId: t.id,
                taskTitle: t.title,
                missionId: t.missionId,
                completedAt: t.updatedAt,
                deployState: (t.releaseResult as any)?.deployState ?? null,
                deployUrl: (t.releaseResult as any)?.deployUrl ?? null,
                status: (t.releaseResult as any)?.status ?? null,
                sha: (t.result as any)?.sha ?? null,
            })),
        });
    } catch (error) {
        console.error('Get last-release error:', error);
        return NextResponse.json({ error: 'Failed to get release status' }, { status: 500 });
    }
}

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts, workers, workspaces, accountWorkspaces } from '@buildd/core/db/schema';
import { eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';

/**
 * GET /api/workers/active
 *
 * Returns active local-ui instances with capacity for the current user.
 * These are workers that:
 * - Have a localUiUrl set (indicating they're running local-ui)
 * - Have status in (running, starting, waiting_input, idle)
 * - Belong to workspaces the user has access to
 *
 * Response includes:
 * - localUiUrl: The URL to access the local-ui
 * - activeWorkers: Number of currently active workers
 * - maxConcurrent: Maximum concurrent workers allowed
 * - capacity: Remaining capacity (maxConcurrent - activeWorkers)
 * - workspaceIds: Workspaces this local-ui can work on
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Get user's workspace IDs
    const userWorkspaces = await db.query.workspaces.findMany({
      where: eq(workspaces.ownerId, user.id),
      columns: { id: true },
    });
    const workspaceIds = userWorkspaces.map(w => w.id);

    if (workspaceIds.length === 0) {
      return NextResponse.json({ activeLocalUis: [] });
    }

    // Find workers with localUiUrl in user's workspaces
    // Group by localUiUrl and accountId to find unique local-ui instances
    const activeWorkers = await db.query.workers.findMany({
      where: (w, { and, inArray: inArr, isNotNull: notNull, or }) =>
        and(
          inArr(w.workspaceId, workspaceIds),
          notNull(w.localUiUrl),
          or(
            eq(w.status, 'running'),
            eq(w.status, 'starting'),
            eq(w.status, 'waiting_input'),
            eq(w.status, 'idle')
          )
        ),
      with: {
        account: {
          columns: {
            id: true,
            name: true,
            maxConcurrentWorkers: true,
          },
        },
        workspace: {
          columns: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: (w, { desc }) => [desc(w.updatedAt)],
    });

    // Group by localUiUrl
    const localUiMap = new Map<string, {
      localUiUrl: string;
      accountId: string;
      accountName: string;
      maxConcurrent: number;
      activeWorkers: number;
      workspaceIds: Set<string>;
      workspaceNames: Set<string>;
      lastUpdated: Date;
    }>();

    for (const worker of activeWorkers) {
      const url = worker.localUiUrl!;
      const existing = localUiMap.get(url);

      if (existing) {
        // Count active workers (running, starting, waiting_input count against capacity)
        if (['running', 'starting', 'waiting_input'].includes(worker.status)) {
          existing.activeWorkers++;
        }
        if (worker.workspace) {
          existing.workspaceIds.add(worker.workspace.id);
          existing.workspaceNames.add(worker.workspace.name);
        }
      } else {
        localUiMap.set(url, {
          localUiUrl: url,
          accountId: worker.accountId || '',
          accountName: worker.account?.name || 'Unknown',
          maxConcurrent: worker.account?.maxConcurrentWorkers || 3,
          activeWorkers: ['running', 'starting', 'waiting_input'].includes(worker.status) ? 1 : 0,
          workspaceIds: new Set(worker.workspace ? [worker.workspace.id] : []),
          workspaceNames: new Set(worker.workspace ? [worker.workspace.name] : []),
          lastUpdated: worker.updatedAt,
        });
      }
    }

    // Convert to response format
    const activeLocalUis = Array.from(localUiMap.values()).map(ui => ({
      localUiUrl: ui.localUiUrl,
      accountId: ui.accountId,
      accountName: ui.accountName,
      maxConcurrent: ui.maxConcurrent,
      activeWorkers: ui.activeWorkers,
      capacity: Math.max(0, ui.maxConcurrent - ui.activeWorkers),
      workspaceIds: Array.from(ui.workspaceIds),
      workspaceNames: Array.from(ui.workspaceNames),
      lastUpdated: ui.lastUpdated,
    }));

    // Sort by capacity (most available first)
    activeLocalUis.sort((a, b) => b.capacity - a.capacity);

    return NextResponse.json({ activeLocalUis });
  } catch (error) {
    console.error('Get active workers error:', error);
    return NextResponse.json({ error: 'Failed to get active workers' }, { status: 500 });
  }
}

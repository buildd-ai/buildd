import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts, accountWorkspaces, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { eq, and, or, isNull, sql, inArray, lt } from 'drizzle-orm';
import type { ClaimTasksInput, ClaimTasksResponse } from '@buildd/shared';
import { authenticateApiKey } from '@/lib/api-auth';

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  const account = await authenticateApiKey(apiKey);
  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  const body: ClaimTasksInput = await req.json();
  const { workspaceId, capabilities = [], maxTasks = 3, runner } = body;

  if (!runner) {
    return NextResponse.json({ error: 'runner is required' }, { status: 400 });
  }

  // Check current active workers
  const activeWorkers = await db.query.workers.findMany({
    where: and(
      eq(workers.accountId, account.id),
      inArray(workers.status, ['running', 'starting', 'waiting_input'])
    ),
  });

  if (activeWorkers.length >= account.maxConcurrentWorkers) {
    return NextResponse.json(
      {
        error: 'Max concurrent workers limit reached',
        limit: account.maxConcurrentWorkers,
        current: activeWorkers.length,
      },
      { status: 429 }
    );
  }

  // Auth-type specific checks
  if (account.authType === 'api') {
    if (
      account.maxCostPerDay &&
      parseFloat(account.totalCost.toString()) >= parseFloat(account.maxCostPerDay.toString())
    ) {
      return NextResponse.json(
        {
          error: 'Daily cost limit exceeded',
          limit: account.maxCostPerDay,
          current: account.totalCost,
        },
        { status: 429 }
      );
    }
  } else if (account.authType === 'oauth') {
    if (account.maxConcurrentSessions && account.activeSessions >= account.maxConcurrentSessions) {
      return NextResponse.json(
        {
          error: 'Max concurrent sessions limit reached',
          limit: account.maxConcurrentSessions,
          current: account.activeSessions,
        },
        { status: 429 }
      );
    }
  }

  const availableSlots = Math.min(maxTasks, account.maxConcurrentWorkers - activeWorkers.length);

  if (availableSlots === 0) {
    return NextResponse.json({ workers: [] });
  }

  // Get workspaces this account can claim from
  // 1. Open workspaces (any account can claim)
  // 2. Restricted workspaces where account has canClaim permission
  const openWorkspaces = await db.query.workspaces.findMany({
    where: and(
      eq(workspaces.accessMode, 'open'),
      workspaceId ? eq(workspaces.id, workspaceId) : undefined
    ),
  });

  const restrictedPermissions = await db.query.accountWorkspaces.findMany({
    where: and(
      eq(accountWorkspaces.accountId, account.id),
      eq(accountWorkspaces.canClaim, true),
      workspaceId ? eq(accountWorkspaces.workspaceId, workspaceId) : undefined
    ),
    with: { workspace: true },
  });

  // Combine: open workspace IDs + restricted workspaces with permission
  const openIds = openWorkspaces.map((ws) => ws.id);
  const restrictedIds = restrictedPermissions
    .filter((p) => p.workspace?.accessMode === 'restricted')
    .map((p) => p.workspaceId);

  const workspaceIds = [...new Set([...openIds, ...restrictedIds])];
  if (workspaceIds.length === 0) {
    return NextResponse.json({ workers: [] });
  }

  // Find claimable tasks
  const now = new Date();
  const claimableConditions = [
    inArray(tasks.workspaceId, workspaceIds),
    eq(tasks.status, 'pending'),
    or(isNull(tasks.claimedBy), lt(tasks.expiresAt, now)),
  ];

  if (account.type !== 'user') {
    claimableConditions.push(
      or(eq(tasks.runnerPreference, 'any'), eq(tasks.runnerPreference, account.type))
    );
  }

  const claimableTasks = await db.query.tasks.findMany({
    where: and(...claimableConditions),
    orderBy: (tasks, { desc, asc }) => [desc(tasks.priority), asc(tasks.createdAt)],
    limit: availableSlots,
    with: { workspace: true },
  });

  // Filter by capabilities
  const filteredTasks = claimableTasks.filter((task) => {
    if (capabilities.length === 0) return true;
    const reqCaps = task.requiredCapabilities || [];
    if (reqCaps.length === 0) return true;
    return reqCaps.every((cap) => capabilities.includes(cap));
  });

  // Claim tasks and create workers inside a transaction to prevent double-assignment
  const claimedWorkers: ClaimTasksResponse['workers'] = await db.transaction(async (tx) => {
    const claimed: ClaimTasksResponse['workers'] = [];

    for (const task of filteredTasks) {
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

      // Only claim if still pending (prevents race with concurrent requests)
      const updated = await tx
        .update(tasks)
        .set({
          claimedBy: account.id,
          claimedAt: now,
          expiresAt,
          status: 'assigned',
        })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, 'pending')))
        .returning({ id: tasks.id });

      if (updated.length === 0) continue; // Already claimed by another request

      // Generate branch name based on workspace gitConfig
      const gitConfig = task.workspace?.gitConfig as {
        branchingStrategy?: 'none' | 'trunk' | 'gitflow' | 'feature' | 'custom';
        branchPrefix?: string;
        useBuildBranch?: boolean;
        defaultBranch?: string;
      } | null;

      const sanitizedTitle = task.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .substring(0, 30);
      const taskIdShort = task.id.substring(0, 8);

      let branch: string;
      if (gitConfig?.branchingStrategy === 'none') {
        branch = `task-${taskIdShort}`;
      } else if (gitConfig?.useBuildBranch) {
        branch = `buildd/${taskIdShort}-${sanitizedTitle}`;
      } else if (gitConfig?.branchPrefix) {
        branch = `${gitConfig.branchPrefix}${taskIdShort}-${sanitizedTitle}`;
      } else {
        branch = `buildd/${taskIdShort}-${sanitizedTitle}`;
      }

      const [worker] = await tx
        .insert(workers)
        .values({
          taskId: task.id,
          workspaceId: task.workspaceId,
          accountId: account.id,
          name: `${account.name}-${task.id.substring(0, 8)}`,
          runner,
          branch,
          status: 'idle',
        })
        .returning();

      claimed.push({
        id: worker.id,
        taskId: task.id,
        branch,
        task: task as any,
      });
    }

    // Increment active sessions for OAuth accounts
    if (account.authType === 'oauth' && claimed.length > 0) {
      await tx
        .update(accounts)
        .set({
          activeSessions: sql`${accounts.activeSessions} + ${claimed.length}`,
        })
        .where(eq(accounts.id, account.id));
    }

    return claimed;
  });

  return NextResponse.json({ workers: claimedWorkers });
}

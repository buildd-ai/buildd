import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts, accountWorkspaces, tasks, workers } from '@buildd/core/db/schema';
import { eq, and, or, isNull, sql, inArray, lt } from 'drizzle-orm';
import type { ClaimTasksInput, ClaimTasksResponse } from '@buildd/shared';

async function authenticateApiKey(apiKey: string | null) {
  if (!apiKey) return null;

  const account = await db.query.accounts.findFirst({
    where: eq(accounts.apiKey, apiKey),
  });

  return account || null;
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  const account = await authenticateApiKey(apiKey);
  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  const body: ClaimTasksInput = await req.json();
  const { workspaceId, capabilities = [], maxTasks = 3 } = body;

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
  const allowedWorkspaces = await db.query.accountWorkspaces.findMany({
    where: and(
      eq(accountWorkspaces.accountId, account.id),
      eq(accountWorkspaces.canClaim, true),
      workspaceId ? eq(accountWorkspaces.workspaceId, workspaceId) : undefined
    ),
  });

  const workspaceIds = allowedWorkspaces.map((aw) => aw.workspaceId);
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

  // Claim tasks and create workers
  const claimedWorkers: ClaimTasksResponse['workers'] = [];

  for (const task of filteredTasks) {
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await db
      .update(tasks)
      .set({
        claimedBy: account.id,
        claimedAt: now,
        expiresAt,
        status: 'assigned',
      })
      .where(eq(tasks.id, task.id));

    const branch = `buildd/${task.id.substring(0, 8)}-${task.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .substring(0, 30)}`;

    const [worker] = await db
      .insert(workers)
      .values({
        taskId: task.id,
        workspaceId: task.workspaceId,
        accountId: account.id,
        name: `${account.name}-${task.id.substring(0, 8)}`,
        branch,
        status: 'idle',
      })
      .returning();

    claimedWorkers.push({
      id: worker.id,
      taskId: task.id,
      branch,
      task: task as any,
    });
  }

  // Increment active sessions for OAuth accounts
  if (account.authType === 'oauth' && claimedWorkers.length > 0) {
    await db
      .update(accounts)
      .set({
        activeSessions: sql`${accounts.activeSessions} + ${claimedWorkers.length}`,
      })
      .where(eq(accounts.id, account.id));
  }

  return NextResponse.json({ workers: claimedWorkers });
}

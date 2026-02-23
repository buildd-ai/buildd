import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts, accountWorkspaces, tasks, workers, workerHeartbeats, workspaces, workspaceSkills, skills, secrets } from '@buildd/core/db/schema';
import { eq, and, or, not, isNull, sql, inArray, lt, gt } from 'drizzle-orm';
import type { ClaimTasksInput, ClaimTasksResponse, SkillBundle } from '@buildd/shared';
import { authenticateApiKey } from '@/lib/api-auth';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { isStorageConfigured, generateDownloadUrl } from '@/lib/storage';
import { resolveCompletedTask } from '@/lib/task-dependencies';
import { getSecretsProvider } from '@buildd/core/secrets';

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  const account = await authenticateApiKey(apiKey);
  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  const body: ClaimTasksInput = await req.json();
  let { workspaceId, capabilities = [], maxTasks = 3, runner, taskId } = body;

  if (!runner) {
    return NextResponse.json({ error: 'runner is required' }, { status: 400 });
  }

  // Auto-derive capabilities from environment when none are explicitly provided
  if (capabilities.length === 0 && body.environment) {
    const env = body.environment;
    capabilities = [
      ...env.tools.map(t => t.name),
      ...env.envKeys,
      ...env.mcp.map(m => `mcp:${m}`),
    ];
  }

  // Auto-expire stale workers (no update in 15+ minutes)
  const STALE_THRESHOLD_MS = 15 * 60 * 1000;
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);

  const staleWorkers = await db.query.workers.findMany({
    where: and(
      eq(workers.accountId, account.id),
      inArray(workers.status, ['running', 'starting', 'waiting_input']),
      lt(workers.updatedAt, staleThreshold)
    ),
    columns: { id: true, taskId: true },
  });

  if (staleWorkers.length > 0) {
    const staleWorkerIds = staleWorkers.map(w => w.id);
    const staleTaskIds = staleWorkers.map(w => w.taskId).filter(Boolean) as string[];

    await db
      .update(workers)
      .set({
        status: 'failed',
        error: 'Stale worker expired (no update for 15+ minutes)',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(inArray(workers.id, staleWorkerIds));

    if (staleTaskIds.length > 0) {
      // Fetch workspace IDs before updating, for dependency resolution
      const staleTasks = await db.query.tasks.findMany({
        where: inArray(tasks.id, staleTaskIds),
        columns: { id: true, workspaceId: true },
      });

      await db
        .update(tasks)
        .set({
          status: 'pending',
          claimedBy: null,
          claimedAt: null,
          updatedAt: new Date(),
        })
        .where(inArray(tasks.id, staleTaskIds));

      // Resolve dependencies for expired tasks
      for (const t of staleTasks) {
        await resolveCompletedTask(t.id, t.workspaceId);
      }
    }
  }

  // Also fail active workers when their runner's heartbeat is stale (machine went offline)
  const HEARTBEAT_STALE_MS = 10 * 60 * 1000; // 10 minutes
  const heartbeatCutoff = new Date(Date.now() - HEARTBEAT_STALE_MS);

  // Check if this account has any fresh heartbeat
  const freshHeartbeat = await db.query.workerHeartbeats.findFirst({
    where: and(
      eq(workerHeartbeats.accountId, account.id),
      gt(workerHeartbeats.lastHeartbeatAt, heartbeatCutoff),
    ),
    columns: { id: true },
  });

  // If no fresh heartbeat, fail any active workers for this account
  if (!freshHeartbeat) {
    const orphanedByHeartbeat = await db.query.workers.findMany({
      where: and(
        eq(workers.accountId, account.id),
        inArray(workers.status, ['running', 'starting', 'idle', 'waiting_input']),
        lt(workers.updatedAt, heartbeatCutoff),
      ),
      columns: { id: true, taskId: true },
    });

    if (orphanedByHeartbeat.length > 0) {
      const orphanIds = orphanedByHeartbeat.map(w => w.id);
      const orphanTaskIds = orphanedByHeartbeat.map(w => w.taskId).filter(Boolean) as string[];

      await db
        .update(workers)
        .set({
          status: 'failed',
          error: 'Worker runner went offline (heartbeat expired)',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(inArray(workers.id, orphanIds));

      if (orphanTaskIds.length > 0) {
        await db
          .update(tasks)
          .set({
            status: 'pending',
            claimedBy: null,
            claimedAt: null,
            updatedAt: new Date(),
          })
          .where(inArray(tasks.id, orphanTaskIds));
      }
    }
  }

  // Check current active workers (after expiring stale ones)
  const activeWorkers = await db.query.workers.findMany({
    where: and(
      eq(workers.accountId, account.id),
      inArray(workers.status, ['idle', 'running', 'starting', 'waiting_input'])
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

  // If a specific taskId was requested, only claim that task
  if (taskId) {
    claimableConditions.push(eq(tasks.id, taskId));
  }

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

  // Claim tasks and create workers with optimistic locking to prevent double-assignment.
  // Note: neon-http driver does not support interactive transactions (where intermediate
  // results inform subsequent queries). Instead, we use atomic UPDATE...WHERE status='pending'
  // which is inherently safe against concurrent claims at the SQL level.
  const claimedWorkers: ClaimTasksResponse['workers'] = [];

  for (const task of filteredTasks) {
    // Re-check concurrency limit before each claim to prevent race condition bypass
    const currentActive = await db.query.workers.findMany({
      where: and(
        eq(workers.accountId, account.id),
        inArray(workers.status, ['idle', 'running', 'starting', 'waiting_input'])
      ),
      columns: { id: true },
    });

    if (currentActive.length >= account.maxConcurrentWorkers) {
      // Limit reached during claim loop - stop claiming more tasks
      break;
    }

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    // Atomic claim: only succeeds if task is still pending (optimistic lock)
    const updated = await db
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

    const [worker] = await db
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

    claimedWorkers.push({
      id: worker.id,
      taskId: task.id,
      branch,
      task: task as any,
    });
  }

  // Broadcast claim events so dashboard updates in real-time
  for (const cw of claimedWorkers) {
    const claimedTask = filteredTasks.find(t => t.id === cw.taskId);
    if (claimedTask) {
      await triggerEvent(
        channels.workspace(claimedTask.workspaceId),
        events.TASK_CLAIMED,
        {
          task: { id: claimedTask.id, title: claimedTask.title, status: 'assigned', workspaceId: claimedTask.workspaceId },
          worker: { id: cw.id, name: account.name, status: 'idle' },
        }
      );
    }
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

  // Resolve R2 storage keys to presigned download URLs for attachments
  if (isStorageConfigured()) {
    for (const cw of claimedWorkers) {
      const ctx = (cw.task as any)?.context as { attachments?: any[] } | undefined;
      if (ctx?.attachments) {
        ctx.attachments = await Promise.all(
          ctx.attachments.map(async (att: any) => {
            if (att.storageKey) {
              const url = await generateDownloadUrl(att.storageKey);
              return { filename: att.filename, mimeType: att.mimeType, url };
            }
            return att; // legacy base64 passes through
          })
        );
      }
    }
  }

  // Resolve skill bundles for claimed workers
  for (const cw of claimedWorkers) {
    const ctx = (cw.task as any)?.context as { skillSlugs?: string[] } | undefined;
    if (!ctx?.skillSlugs || ctx.skillSlugs.length === 0) continue;

    const taskObj = filteredTasks.find(t => t.id === cw.taskId);
    const wsId = taskObj?.workspaceId;
    const teamId = taskObj?.workspace?.teamId as string | undefined;
    if (!wsId) continue;

    const slugs = ctx.skillSlugs;
    const bundles: SkillBundle[] = [];
    const unmatchedSlugs: string[] = [];

    // 1. Check workspace-level skills (enabled only)
    if (slugs.length > 0) {
      const wsSkills = await db.query.workspaceSkills.findMany({
        where: and(
          eq(workspaceSkills.workspaceId, wsId),
          inArray(workspaceSkills.slug, slugs),
          eq(workspaceSkills.enabled, true),
        ),
      });

      const foundSlugs = new Set(wsSkills.map(s => s.slug));
      for (const ws of wsSkills) {
        const meta = ws.metadata as { referenceFiles?: Record<string, string> } | null;
        bundles.push({
          slug: ws.slug,
          name: ws.name,
          description: ws.description || undefined,
          content: ws.content,
          ...(meta?.referenceFiles ? { referenceFiles: meta.referenceFiles } : {}),
        });
      }

      for (const slug of slugs) {
        if (!foundSlugs.has(slug)) unmatchedSlugs.push(slug);
      }
    }

    // 2. For unmatched slugs, fall back to team-level skills
    if (unmatchedSlugs.length > 0 && teamId) {
      const teamSkills = await db.query.skills.findMany({
        where: and(
          eq(skills.teamId, teamId),
          inArray(skills.slug, unmatchedSlugs),
        ),
      });

      for (const ts of teamSkills) {
        if (ts.content) {
          bundles.push({
            slug: ts.slug,
            name: ts.name,
            description: ts.description || undefined,
            content: ts.content,
          });
        }
      }
    }

    if (bundles.length > 0) {
      (cw as any).skillBundles = bundles;
    }
  }

  // Enrich rollup tasks with sibling results (for tasks that have a parentTaskId)
  for (const cw of claimedWorkers) {
    const task = filteredTasks.find(t => t.id === cw.taskId);
    if (!task?.parentTaskId) continue;

    const siblings = await db.query.tasks.findMany({
      where: and(
        eq(tasks.parentTaskId, task.parentTaskId),
        not(eq(tasks.id, task.id))
      ),
      columns: { id: true, title: true, status: true, result: true },
    });

    if (siblings.length > 0) {
      (cw as any).childResults = siblings;
    }
  }

  // Attach secretRef for server-managed credentials (if account has an anthropic_api_key secret)
  if (claimedWorkers.length > 0 && process.env.ENCRYPTION_KEY) {
    try {
      const accountSecret = await db.query.secrets.findFirst({
        where: and(
          eq(secrets.accountId, account.id),
          eq(secrets.purpose, 'anthropic_api_key'),
        ),
        columns: { id: true },
      });

      if (accountSecret) {
        const provider = getSecretsProvider();
        for (const cw of claimedWorkers) {
          const ref = await provider.createRef(accountSecret.id, cw.id, 300);
          (cw as any).secretRef = ref;
        }
      }
    } catch (err) {
      // Non-fatal: worker can still use local credentials
      console.warn('Failed to create secret refs:', err);
    }
  }

  // Piggyback: clean up expired secret refs
  if (process.env.ENCRYPTION_KEY) {
    try {
      const provider = getSecretsProvider();
      await provider.cleanupExpiredRefs();
    } catch {
      // Non-fatal cleanup
    }
  }

  return NextResponse.json({ workers: claimedWorkers });
}

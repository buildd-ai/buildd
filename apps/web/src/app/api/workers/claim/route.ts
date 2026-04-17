import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts, accountWorkspaces, tasks, workers, workspaces, workspaceSkills, secrets, tenantBudgets } from '@buildd/core/db/schema';
import { eq, and, or, not, isNull, sql, inArray, lt, gte } from 'drizzle-orm';
import type { ClaimTasksInput, ClaimTasksResponse, ClaimDiagnostics, SkillBundle } from '@buildd/shared';
import { authenticateApiKey } from '@/lib/api-auth';
import { getAccountWorkspacePermissions } from '@/lib/account-workspace-cache';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { isStorageConfigured, generateDownloadUrl } from '@/lib/storage';
import { cleanupStaleWorkers } from '@/lib/stale-workers';
import { getSecretsProvider } from '@buildd/core/secrets';
import { jsonResponse } from '@/lib/api-response';
import { notify } from '@/lib/pushover';
import { resolveEffectiveModel, type Tier } from '@buildd/core/model-router';

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  const account = await authenticateApiKey(apiKey);
  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  // Trigger-level tokens cannot claim tasks
  if (account.level === 'trigger') {
    return NextResponse.json({ error: 'Trigger tokens cannot claim tasks. Use a worker or admin token.' }, { status: 403 });
  }

  const body: ClaimTasksInput = await req.json();
  let { workspaceId, capabilities = [], maxTasks = 3, runner, taskId, availableSkills = [] } = body;

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

  // Clean up stale workers before checking capacity
  // TODO: Consider calling attemptStaleRecovery() from a periodic cron instead of claim
  // Recovery is async and shouldn't block claiming
  await cleanupStaleWorkers(account.id);

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

    // Budget exhaustion check: soft flag instead of hard 429.
    // Tenant tasks (with their own API keys) should still be claimable,
    // so we filter non-tenant tasks in the claim loop below.
    if (account.budgetExhaustedAt) {
      if (account.budgetResetsAt && new Date() >= new Date(account.budgetResetsAt)) {
        // Budget has reset — auto-clear the flag
        await db
          .update(accounts)
          .set({ budgetExhaustedAt: null, budgetResetsAt: null })
          .where(eq(accounts.id, account.id));
      }
    }
  }

  // Track whether account's own OAuth budget is exhausted (tenant tasks can still proceed)
  const accountBudgetExhausted = account.authType === 'oauth'
    && !!account.budgetExhaustedAt
    && (!account.budgetResetsAt || new Date() < new Date(account.budgetResetsAt));

  const availableSlots = Math.min(maxTasks, account.maxConcurrentWorkers - activeWorkers.length);

  if (availableSlots === 0) {
    return NextResponse.json({
      workers: [],
      diagnostics: {
        reason: 'no_slots',
        activeWorkers: activeWorkers.length,
        maxConcurrent: account.maxConcurrentWorkers,
      } satisfies ClaimDiagnostics,
    });
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

  // Get cached account→workspace permissions (avoids DB hit on every claim)
  const allPermissions = await getAccountWorkspacePermissions(account.id);
  const claimablePermissions = allPermissions
    .filter((p) => p.canClaim)
    .filter((p) => !workspaceId || p.workspaceId === workspaceId);

  // Resolve which restricted workspaces this account can access
  const restrictedWsIds = claimablePermissions.map((p) => p.workspaceId);
  let restrictedIds: string[] = [];
  if (restrictedWsIds.length > 0) {
    const restrictedWorkspaces = await db.query.workspaces.findMany({
      where: and(
        inArray(workspaces.id, restrictedWsIds),
        eq(workspaces.accessMode, 'restricted'),
      ),
      columns: { id: true },
    });
    restrictedIds = restrictedWorkspaces.map((ws) => ws.id);
  }

  // Combine: open workspace IDs + restricted workspaces with permission
  const openIds = openWorkspaces.map((ws) => ws.id);

  const workspaceIds = [...new Set([...openIds, ...restrictedIds])];
  if (workspaceIds.length === 0) {
    return NextResponse.json({
      workers: [],
      diagnostics: { reason: 'no_workspaces' } satisfies ClaimDiagnostics,
    });
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

  // Exclude tasks that already have an active worker (prevents duplicate claims
  // when stale cleanup resets a task to pending while another worker is still active)
  claimableConditions.push(
    sql`NOT EXISTS (
      SELECT 1 FROM ${workers} w
      WHERE w.task_id = ${tasks.id}
      AND w.status IN ('running', 'starting', 'waiting_input', 'idle')
    )`
  );

  // Exclude tasks whose dependencies haven't completed yet.
  // We filter with a SQL subquery so the LIMIT applies to actually-claimable tasks.
  claimableConditions.push(
    or(
      // No dependencies
      isNull(tasks.dependsOn),
      sql`${tasks.dependsOn}::jsonb = '[]'::jsonb`,
      // All dependencies must be completed (failed deps block downstream tasks)
      sql`NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(${tasks.dependsOn}::jsonb) AS dep_id
        WHERE NOT EXISTS (
          SELECT 1 FROM ${tasks} t2
          WHERE t2.id = dep_id::uuid
          AND t2.status = 'completed'
        )
      )`
    )
  );

  // Prevent parallel workers on the same repo — if another task in the same
  // workspace already has an active worker, skip this task. This avoids the
  // "N parallel branches on the same repo" problem that causes merge conflicts.
  // Only applies to workspaces with a repo (not coordination workspaces).
  claimableConditions.push(
    sql`NOT EXISTS (
      SELECT 1 FROM ${workers} w2
      JOIN ${tasks} t3 ON t3.id = w2.task_id
      WHERE t3.workspace_id = ${tasks.workspaceId}
      AND w2.status IN ('running', 'starting', 'idle')
      AND t3.id != ${tasks.id}
      AND EXISTS (
        SELECT 1 FROM ${workspaces} ws
        WHERE ws.id = t3.workspace_id
        AND ws.repo IS NOT NULL
      )
    )`
  );

  // Filter by roleSlug: tasks with a role_slug are only claimable by runners
  // that advertise that slug in availableSkills.
  // If availableSkills is not provided, the runner can claim any task (backward compat).
  if (availableSkills.length > 0) {
    claimableConditions.push(
      or(isNull(tasks.roleSlug), inArray(tasks.roleSlug, availableSkills))
    );
  }

  const claimableTasks = await db.query.tasks.findMany({
    where: and(...claimableConditions),
    orderBy: (tasks, { desc, asc }) => [desc(tasks.priority), asc(tasks.createdAt)],
    limit: availableSlots,
    with: { workspace: true },
  });

  if (claimableTasks.length === 0) {
    return NextResponse.json({
      workers: [],
      diagnostics: {
        reason: 'no_pending_tasks',
        availableSlots,
      } satisfies ClaimDiagnostics,
    });
  }

  // Filter by capabilities
  const filteredTasks = claimableTasks.filter((task) => {
    if (capabilities.length === 0) return true;
    const reqCaps = task.requiredCapabilities || [];
    if (reqCaps.length === 0) return true;
    return reqCaps.every((cap) => capabilities.includes(cap));
  });

  if (filteredTasks.length === 0) {
    return NextResponse.json({
      workers: [],
      diagnostics: {
        reason: 'capability_mismatch',
        pendingTasks: claimableTasks.length,
        matchedTasks: 0,
      } satisfies ClaimDiagnostics,
    });
  }

  // Compute router inputs once per claim request. The router is pure; the
  // signals below feed its budget-pressure and spike-detection gates.
  const dailyBudgetPct = account.authType === 'api' && account.maxCostPerDay
    ? Math.min(1, parseFloat(account.totalCost.toString()) / parseFloat(account.maxCostPerDay.toString()))
    : 0;

  const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000);
  const recentClaims = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(eq(tasks.claimedBy, account.id), gte(tasks.claimedAt, tenMinAgo)));
  const recentClaimCount = recentClaims[0]?.count ?? 0;

  // Pre-fetch role floors for every unique roleSlug referenced by the filtered tasks.
  // We look up workspace-level roles first, then fall back to account-level; matches
  // the later roleConfig enrichment pattern but deduped up front.
  const uniqueRoleSlugs = [...new Set(
    filteredTasks.map(t => (t as any).roleSlug as string | null).filter(Boolean) as string[],
  )];
  const roleFloorMap = new Map<string, Tier | 'inherit'>();
  if (uniqueRoleSlugs.length > 0) {
    const wsRoles = await db.query.workspaceSkills.findMany({
      where: and(
        inArray(workspaceSkills.slug, uniqueRoleSlugs),
        eq(workspaceSkills.isRole, true),
        eq(workspaceSkills.enabled, true),
        or(
          inArray(workspaceSkills.workspaceId, workspaceIds),
          eq(workspaceSkills.accountId, account.id),
        ),
      ),
      columns: { slug: true, model: true, workspaceId: true },
    });
    for (const r of wsRoles) {
      // Prefer the most-specific (workspace-scoped) entry if both exist.
      if (!roleFloorMap.has(r.slug) || r.workspaceId) {
        roleFloorMap.set(r.slug, r.model as Tier | 'inherit');
      }
    }
  }

  // Claim tasks and create workers with optimistic locking to prevent double-assignment.
  // Note: neon-http driver does not support interactive transactions (where intermediate
  // results inform subsequent queries). Instead, we use atomic UPDATE...WHERE status='pending'
  // which is inherently safe against concurrent claims at the SQL level.
  const claimedWorkers: ClaimTasksResponse['workers'] = [];

  for (const task of filteredTasks) {
    // Allow tasks to declare a longer timeout via context.timeoutMinutes (max 240 min / 4 hours)
    const taskContext = task.context as Record<string, unknown> | null;

    // Account budget exhausted: skip non-tenant tasks (they'd use the account's own OAuth token)
    const tenantCtx = (taskContext?.tenantContext as { tenantId?: string }) || null;
    if (accountBudgetExhausted && !tenantCtx?.tenantId) {
      continue;
    }

    // Tenant budget check: skip tasks whose tenant's budget is exhausted
    if (tenantCtx?.tenantId) {
      const workspaceTeamId = (task as any).workspace?.teamId as string | undefined;
      if (workspaceTeamId) {
        const tenantBudget = await db.query.tenantBudgets.findFirst({
          where: and(
            eq(tenantBudgets.tenantId, tenantCtx.tenantId),
            eq(tenantBudgets.teamId, workspaceTeamId),
          ),
        });
        if (tenantBudget) {
          if (new Date() >= new Date(tenantBudget.budgetResetsAt)) {
            // Budget has reset — clean up the record
            await db.delete(tenantBudgets).where(eq(tenantBudgets.id, tenantBudget.id));
          } else {
            // Budget still exhausted — skip this task
            continue;
          }
        }
      }
    }

    const timeoutMinutes = Math.min(
      typeof taskContext?.timeoutMinutes === 'number' ? taskContext.timeoutMinutes : 15,
      240,
    );
    const expiresAt = new Date(Date.now() + timeoutMinutes * 60 * 1000);

    // Smart-routing decision — maps task kind/complexity + budget pressure +
    // spike signal + role floor → effective model (haiku/sonnet/opus) or
    // 'paused'. The resulting model is written to task.predictedModel and
    // injected into task.context.model so worker-runner picks it up.
    const roleSlug = (task as any).roleSlug as string | null;
    const explicit = (taskContext?.model as string | undefined) || null;
    const routingDecision = resolveEffectiveModel({
      explicitModel: explicit,
      kind: (task as any).kind || null,
      complexity: (task as any).complexity || null,
      roleFloor: roleSlug ? roleFloorMap.get(roleSlug) || null : null,
      dailyBudgetPct,
      recentClaimCount,
      priority: task.priority ?? 0,
    });

    if (routingDecision.model === 'paused') {
      // Budget-pressure pause — leave the task pending for next cycle.
      continue;
    }

    // Persist the routing decision in task context so the runner consumes it
    // without extra lookups. We also write predictedModel for analytics.
    const patchedContext = {
      ...(taskContext || {}),
      model: routingDecision.model,
    };

    // Atomic claim: only succeeds if task is still pending (optimistic lock)
    const updated = await db
      .update(tasks)
      .set({
        claimedBy: account.id,
        claimedAt: now,
        expiresAt,
        status: 'assigned',
        predictedModel: routingDecision.model,
        context: patchedContext,
      })
      .where(and(eq(tasks.id, task.id), eq(tasks.status, 'pending')))
      .returning({ id: tasks.id });

    if (updated.length === 0) continue; // Already claimed by another request

    // Keep the in-memory task copy in sync so downstream enrichment and the
    // returned worker payload see the patched context.
    (task as any).context = patchedContext;
    (task as any).predictedModel = routingDecision.model;

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

    // Atomic conditional insert: only creates worker if under concurrency limit.
    // This prevents the TOCTOU race where multiple requests pass the count check
    // but then all insert, exceeding the limit.
    const insertResult = await db.execute(sql`
      INSERT INTO ${workers} (task_id, workspace_id, account_id, name, runner, branch, status)
      SELECT ${task.id}, ${task.workspaceId}, ${account.id}, ${`${account.name}-${task.id.substring(0, 8)}`}, ${runner}, ${branch}, 'idle'
      WHERE (
        SELECT count(*) FROM ${workers}
        WHERE account_id = ${account.id}
        AND status IN ('idle', 'running', 'starting', 'waiting_input')
      ) < ${account.maxConcurrentWorkers}
      RETURNING *
    `);

    const worker = insertResult.rows?.[0] as any;

    if (!worker) {
      // Concurrency limit reached — roll back the task claim
      await db
        .update(tasks)
        .set({ claimedBy: null, claimedAt: null, expiresAt: null, status: 'pending' })
        .where(eq(tasks.id, task.id));
      break;
    }

    claimedWorkers.push({
      id: worker.id,
      taskId: task.id,
      branch,
      task: task as any,
    });
  }

  if (claimedWorkers.length === 0) {
    return NextResponse.json({
      workers: [],
      diagnostics: {
        reason: 'race_lost',
        pendingTasks: claimableTasks.length,
        matchedTasks: filteredTasks.length,
      } satisfies ClaimDiagnostics,
    });
  }

  // Attach open PR context from other workers in the same workspace
  if (claimedWorkers.length > 0) {
    const claimedWorkerIds = claimedWorkers.map(cw => cw.id);
    // Group claimed workers by workspace
    const workspaceIds = [...new Set(claimedWorkers.map(cw => {
      const task = filteredTasks.find(t => t.id === cw.taskId);
      return task?.workspaceId;
    }).filter(Boolean))] as string[];

    if (workspaceIds.length > 0) {
      const openPRWorkers = await db.query.workers.findMany({
        where: and(
          inArray(workers.workspaceId, workspaceIds),
          not(isNull(workers.prUrl)),
          inArray(workers.status, ['running', 'idle', 'starting', 'waiting_input', 'completed']),
          not(inArray(workers.id, claimedWorkerIds)),
        ),
        columns: { id: true, branch: true, prUrl: true, prNumber: true, taskId: true, workspaceId: true },
        orderBy: (workers, { desc }) => [desc(workers.createdAt)],
        limit: 10,
      });

      if (openPRWorkers.length > 0) {
        // Fetch task titles for PR context
        const prTaskIds = openPRWorkers.map(w => w.taskId).filter(Boolean) as string[];
        const prTasks = prTaskIds.length > 0
          ? await db.query.tasks.findMany({
              where: inArray(tasks.id, prTaskIds),
              columns: { id: true, title: true },
            })
          : [];
        const taskTitleMap = new Map(prTasks.map(t => [t.id, t.title]));

        const openPRs = openPRWorkers.map(w => ({
          branch: w.branch,
          prUrl: w.prUrl,
          prNumber: w.prNumber,
          taskTitle: w.taskId ? taskTitleMap.get(w.taskId) || null : null,
          workspaceId: w.workspaceId,
        }));

        for (const cw of claimedWorkers) {
          const task = filteredTasks.find(t => t.id === cw.taskId);
          const wsOpenPRs = openPRs.filter(pr => pr.workspaceId === task?.workspaceId);
          if (wsOpenPRs.length > 0) {
            (cw as any).openPRs = wsOpenPRs;
          }
        }
      }
    }
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
            return att;
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
    if (!wsId) continue;

    const slugs = ctx.skillSlugs;
    const bundles: SkillBundle[] = [];

    // Look up workspace-level skills (enabled only)
    if (slugs.length > 0) {
      const wsSkills = await db.query.workspaceSkills.findMany({
        where: and(
          eq(workspaceSkills.workspaceId, wsId),
          inArray(workspaceSkills.slug, slugs),
          eq(workspaceSkills.enabled, true),
        ),
      });

      const foundSlugs = new Set<string>();
      for (const ws of wsSkills) {
        foundSlugs.add(ws.slug);
        const meta = ws.metadata as { referenceFiles?: Record<string, string> } | null;
        bundles.push({
          slug: ws.slug,
          name: ws.name,
          description: ws.description || undefined,
          content: ws.content,
          ...(meta?.referenceFiles ? { referenceFiles: meta.referenceFiles } : {}),
          model: ws.model as 'sonnet' | 'opus' | 'haiku' | 'inherit',
          allowedTools: (ws.allowedTools as string[]) || [],
          canDelegateTo: (ws.canDelegateTo as string[]) || [],
          background: ws.background ?? false,
          maxTurns: ws.maxTurns ?? null,
          mcpServers: (ws.mcpServers as string[]) || [],
          requiredEnvVars: (ws.requiredEnvVars as Record<string, string>) || {},
        });
      }

      // Fallback: account-level skills for slugs not found at workspace level
      const missingSlugs = slugs.filter(s => !foundSlugs.has(s));
      if (missingSlugs.length > 0) {
        const acctSkills = await db.query.workspaceSkills.findMany({
          where: and(
            eq(workspaceSkills.accountId, account.id),
            inArray(workspaceSkills.slug, missingSlugs),
            eq(workspaceSkills.enabled, true),
          ),
        });
        for (const ws of acctSkills) {
          const meta = ws.metadata as { referenceFiles?: Record<string, string> } | null;
          bundles.push({
            slug: ws.slug,
            name: ws.name,
            description: ws.description || undefined,
            content: ws.content,
            ...(meta?.referenceFiles ? { referenceFiles: meta.referenceFiles } : {}),
            model: ws.model as 'sonnet' | 'opus' | 'haiku' | 'inherit',
            allowedTools: (ws.allowedTools as string[]) || [],
            canDelegateTo: (ws.canDelegateTo as string[]) || [],
            background: ws.background ?? false,
            maxTurns: ws.maxTurns ?? null,
            mcpServers: (ws.mcpServers as string[]) || [],
            requiredEnvVars: (ws.requiredEnvVars as Record<string, string>) || {},
          });
        }
      }
    }

    if (bundles.length > 0) {
      (cw as any).skillBundles = bundles;
    }
  }

  // Enrich claimed workers with role config (for role-based task routing)
  if (isStorageConfigured()) {
    for (const cw of claimedWorkers) {
      const task = filteredTasks.find(t => t.id === cw.taskId);
      const roleSlug = (task as any)?.roleSlug as string | null;
      if (!roleSlug) continue;

      const wsId = task?.workspaceId;
      if (!wsId) continue;

      // Look up the role: workspace-level first, then account-level fallback
      let role = await db.query.workspaceSkills.findFirst({
        where: and(
          eq(workspaceSkills.workspaceId, wsId),
          eq(workspaceSkills.slug, roleSlug),
          eq(workspaceSkills.enabled, true),
          eq(workspaceSkills.isRole, true),
        ),
      });

      // Fallback: account-level role
      if (!role) {
        role = await db.query.workspaceSkills.findFirst({
          where: and(
            eq(workspaceSkills.accountId, account.id),
            eq(workspaceSkills.slug, roleSlug),
            eq(workspaceSkills.enabled, true),
            eq(workspaceSkills.isRole, true),
          ),
        });
      }

      if (role?.configStorageKey && role?.configHash) {
        const configUrl = await generateDownloadUrl(role.configStorageKey);
        (cw as any).roleConfig = {
          slug: role.slug,
          configHash: role.configHash,
          configUrl,
          type: role.repoUrl ? 'builder' : 'service',
          repoUrl: role.repoUrl || undefined,
          model: role.model,
          allowedTools: (role.allowedTools as string[]) || [],
          canDelegateTo: (role.canDelegateTo as string[]) || [],
          background: role.background ?? false,
          maxTurns: role.maxTurns ?? null,
        };
      }
    }
  }

  // Resolve context providers — fetch external context at claim time for prompt injection
  for (const cw of claimedWorkers) {
    const task = filteredTasks.find(t => t.id === cw.taskId);
    const ctx = (task as any)?.context as { contextProviders?: Array<{ url: string; headers?: Record<string, string>; label?: string }> } | undefined;
    if (!ctx?.contextProviders?.length) continue;

    const results = await Promise.allSettled(
      ctx.contextProviders.map(async (provider) => {
        const res = await fetch(provider.url, {
          headers: { ...provider.headers, "Accept": "text/markdown, text/plain" },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`Context provider ${provider.url} returned ${res.status}`);
        const body = await res.text();
        return provider.label ? `## ${provider.label}\n\n${body}` : body;
      }),
    );
    const resolved = results
      .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
      .map(r => r.value);

    if (resolved.length > 0) {
      (cw as any).resolvedContextProviders = resolved;
      // Also merge into task context so runner can read it from task.context
      const taskObj = cw.task as any;
      if (taskObj?.context) {
        taskObj.context.resolvedContextProviders = resolved;
      }
    }

    // Log failures for debugging
    for (const r of results) {
      if (r.status === "rejected") {
        console.warn("[claim] context provider failed:", r.reason?.message || r.reason);
      }
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

  // Attach inline decrypted secrets for server-managed credentials (API key and/or OAuth token)
  // Secrets are scoped by the task's workspace team to prevent cross-team leakage.
  if (claimedWorkers.length > 0 && process.env.ENCRYPTION_KEY) {
    try {
      const provider = getSecretsProvider();

      for (const cw of claimedWorkers) {
        const task = cw.task as any;
        const workspaceTeamId = task?.workspace?.teamId;

        if (!workspaceTeamId) continue;

        const workerSecrets = await db.query.secrets.findMany({
          where: and(
            eq(secrets.teamId, workspaceTeamId),
            inArray(secrets.purpose, ['anthropic_api_key', 'oauth_token', 'mcp_credential']),
            or(
              isNull(secrets.accountId),
              eq(secrets.accountId, account.id),
            ),
            or(
              isNull(secrets.workspaceId),
              eq(secrets.workspaceId, task.workspaceId),
            ),
          ),
          columns: { id: true, purpose: true, label: true },
        });

        if (workerSecrets.length === 0) continue;

        const apiKeySecret = workerSecrets.find(s => s.purpose === 'anthropic_api_key');
        const oauthSecret = workerSecrets.find(s => s.purpose === 'oauth_token');
        const mcpSecrets = workerSecrets.filter(s => s.purpose === 'mcp_credential' && s.label);

        const [decryptedApiKey, decryptedOauthToken, ...decryptedMcpValues] = await Promise.all([
          apiKeySecret ? provider.get(apiKeySecret.id) : null,
          oauthSecret ? provider.get(oauthSecret.id) : null,
          ...mcpSecrets.map(s => provider.get(s.id)),
        ]);

        if (decryptedApiKey) {
          (cw as any).serverApiKey = decryptedApiKey;
        }
        if (decryptedOauthToken) {
          (cw as any).serverOauthToken = decryptedOauthToken;
        }

        // Build MCP secrets map: label (env var name) → decrypted value
        const mcpSecretsMap: Record<string, string> = {};
        mcpSecrets.forEach((s, i) => {
          const val = decryptedMcpValues[i];
          if (val && s.label) {
            mcpSecretsMap[s.label] = val;
          }
        });

        if (Object.keys(mcpSecretsMap).length > 0) {
          (cw as any).mcpSecrets = mcpSecretsMap;
        }
      }
    } catch (err) {
      // Non-fatal: worker can still use local credentials
      console.warn('Failed to decrypt server-managed secrets:', err);
    }
  }

  // Notify on task claims
  for (const cw of claimedWorkers) {
    const task = cw.task as any;
    notify({
      title: `Task claimed`,
      message: `${task?.title || cw.taskId}\n${task?.workspace?.name || 'unknown workspace'}`,
      url: `https://buildd.dev/app/tasks/${cw.taskId}`,
      urlTitle: 'View task',
    });
  }

  return jsonResponse({
    workers: claimedWorkers,
    ...(accountBudgetExhausted && {
      budgetResetsAt: account.budgetResetsAt,
      diagnostics: { reason: 'budget_exhausted_partial' } satisfies ClaimDiagnostics,
    }),
  });
}

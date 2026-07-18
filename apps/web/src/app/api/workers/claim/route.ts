import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts, accountWorkspaces, tasks, workers, workspaces, workspaceSkills, secrets, tenantBudgets, teams, connectors, connectorShares, connectorWorkspaces } from '@buildd/core/db/schema';
import { eq, and, or, not, isNull, isNotNull, sql, inArray, lt, gte } from 'drizzle-orm';
import type { ClaimTasksInput, ClaimTasksResponse, ClaimDiagnostics, SkillBundle } from '@buildd/shared';
import { authenticateApiKey } from '@/lib/api-auth';
import { getAccountWorkspacePermissions } from '@/lib/account-workspace-cache';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { isStorageConfigured, generateDownloadUrl } from '@/lib/storage';
import { cleanupStaleWorkers } from '@/lib/stale-workers';
import { getSecretsProvider } from '@buildd/core/secrets';
import { jsonResponse } from '@/lib/api-response';
import { notifyTeam } from '@/lib/notify';
import { hasCodexCredential, resolveCodexCredential, refreshCodexCredential, getCodexSecretId } from '@/lib/codex-credential';
import { resolveEffectiveModel, type Tier } from '@buildd/core/model-router';
import { buildKnowledgeContext, buildEntityCatalogContext } from '@/lib/knowledge-context';
import { maskBackend, type AgentBackend } from '@buildd/core/backend-policy';
import { findBlockingPr } from '@buildd/core/path-overlap';
import { refreshMcpConnectorCredential } from '@/lib/mcp-connector-refresh';

// Slugify a connector name into the MCP server key used in queryOptions.mcpServers.
// Connector names are already slug-shaped (uniqueness is on (teamId, name)), but we
// normalize defensively so the runner-side key is deterministic.
function slugifyConnectorName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || name.toLowerCase();
}

// A single MCP connector entry resolved at claim time. Superset of the http-only
// shared type — the runner keys behaviour off `transport`.
type ResolvedMcpConnector = {
  id?: string;
  name: string;
  transport: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
  // assertion-mode exchange metadata (assertionMode=true → runner performs mint+exchange)
  assertionMode?: true;
  mintApiUrl?: string;
  audience?: string;
  tokenEndpoint?: string;
};

// Per-runner claim cooldown after a worker error. Matches the typical
// client-side breaker minimum (5m for generic errors, 60s default here since
// the dominant burn-loop cause is fast-fail budget/auth errors that bounce in
// <1s). Scoped per-runner so healthy runners keep picking up tasks.
const CLAIM_COOLDOWN_MS = 60_000;

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
  let { workspaceId, capabilities = [], maxTasks = 3, runner, taskId, availableSkills = [], claimAcrossAccessible = false } = body;

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

  // Defense-in-depth for the 2026-05-25 misroute incident. The MCP-layer guard
  // (packages/core/mcp-tools.ts requireExplicitWorkspace) catches this for
  // MCP-originated claims, but anything else calling /api/workers/claim with
  // an OAuth multi-workspace token and no workspaceId would still trigger the
  // ambiguous-routing bug. Reject at the API boundary too.
  //
  // claimAcrossAccessible is an explicit opt-in for the legitimate case: a
  // single runner that serves N workspaces and deliberately wants the next
  // pending task across all of them (ranked/picked below). That is declared
  // intent, not the accidental ambiguity the guard targets — so allow it while
  // still rejecting silent multi-workspace claims (e.g. a misconfigured MCP).
  if (account.authType === 'oauth' && !workspaceId && !claimAcrossAccessible) {
    const permissions = await getAccountWorkspacePermissions(account.id);
    const accessibleWorkspaceIds = new Set(permissions.filter((p) => p.canClaim).map((p) => p.workspaceId));
    // Also count open workspaces — those are claimable by any account
    const openCount = await db.query.workspaces.findMany({
      where: eq(workspaces.accessMode, 'open'),
      columns: { id: true },
    });
    for (const w of openCount) accessibleWorkspaceIds.add(w.id);

    if (accessibleWorkspaceIds.size > 1) {
      return NextResponse.json(
        {
          error: 'workspaceId required for OAuth tokens with access to multiple workspaces',
          accessibleWorkspaces: accessibleWorkspaceIds.size,
          hint: 'Pass workspaceId in the request body. With multiple accessible workspaces, the claim route refuses to pick one to avoid the 2026-05-25 misroute class.',
        },
        { status: 400 },
      );
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
  // "Done" = task.status='completed' AND (no PR opened, OR PR is merged).
  // This prevents downstream tasks from starting while an upstream PR is still open —
  // which was the root cause of the 6-overlapping-PR burst (PRs #1044-1049).
  // The mergedAt column on workers is set by the GitHub webhook when the PR merges.
  // Exception: bypassDepsGate=true in task context lets a human override the gate
  // (set by /api/tasks/[id]/start when forceOverride=true).
  claimableConditions.push(
    or(
      // No dependencies
      isNull(tasks.dependsOn),
      sql`${tasks.dependsOn}::jsonb = '[]'::jsonb`,
      // Human override: task was manually force-started, skip the dep-PR gate
      sql`${tasks.context}->>'bypassDepsGate' = 'true'`,
      // All dependencies must be completed AND their PRs merged (if any were opened)
      sql`NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(${tasks.dependsOn}::jsonb) AS dep_id
        WHERE NOT EXISTS (
          SELECT 1 FROM ${tasks} t2
          WHERE t2.id = dep_id::uuid
          AND t2.status = 'completed'
          AND NOT EXISTS (
            -- Block if the dep task has any worker with an open (unmerged) PR
            SELECT 1 FROM ${workers} w
            WHERE w.task_id = t2.id
            AND w.pr_url IS NOT NULL
            AND w.merged_at IS NULL
          )
        )
      )`
    )
  );

  // Cap parallel workers per repo-backed workspace. Each task runs in its own git
  // worktree+branch, so parallel work is safe on disk; the cap bounds merge-conflict
  // surface from many branches on one repo. Skip this task if the count of active
  // workers on OTHER tasks in the same workspace has reached the workspace's
  // maxConcurrentTasks (default 3). Repo-less workspaces (coordination, etc.) never
  // have a repo so the inner EXISTS is false → count 0 → never serialized.
  claimableConditions.push(
    sql`(
      SELECT COUNT(*) FROM ${workers} w2
      JOIN ${tasks} t3 ON t3.id = w2.task_id
      WHERE t3.workspace_id = ${tasks.workspaceId}
      AND w2.status IN ('running', 'starting', 'idle')
      AND t3.id != ${tasks.id}
      AND EXISTS (
        SELECT 1 FROM ${workspaces} ws
        WHERE ws.id = t3.workspace_id
        AND ws.repo IS NOT NULL
      )
    ) < (
      SELECT COALESCE(ws2.max_concurrent_tasks, 3) FROM ${workspaces} ws2
      WHERE ws2.id = ${tasks.workspaceId}
    )`
  );

  // Per-runner cooldown: skip tasks where this runner recently had a worker
  // error. Prevents Pusher-driven burn loops (2026-04-16 incident: one runner
  // re-claimed the same task ~12x in 52s after OAuth budget exhaustion).
  // Scoped by runner so a healthy runner can still pick up the task.
  const cooldownCutoff = new Date(Date.now() - CLAIM_COOLDOWN_MS);
  // Per-runner cooldown covers both 'error' AND 'failed' — budget/session workers
  // land in 'failed' (PATCH body sends status:'failed'), so the original 'error'
  // only check missed them entirely and left the burn-loop gap that caused the
  // 2026-06-25 session-limit storm.
  claimableConditions.push(
    sql`NOT EXISTS (
      SELECT 1 FROM ${workers} w_cd
      WHERE w_cd.task_id = ${tasks.id}
      AND w_cd.runner = ${runner}
      AND w_cd.status IN ('error', 'failed')
      AND w_cd.updated_at > ${cooldownCutoff}
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

  // Memoized team provider-enablement mask (the reversible toggle). NULL = all enabled.
  const teamBackendMask = new Map<string, AgentBackend[] | null>();
  const teamEnabledBackends = async (teamId?: string): Promise<AgentBackend[] | null> => {
    if (!teamId) return null;
    if (teamBackendMask.has(teamId)) return teamBackendMask.get(teamId)!;
    let enabled: AgentBackend[] | null = null;
    try {
      const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId), columns: { enabledBackends: true } });
      enabled = (team?.enabledBackends as AgentBackend[] | null) ?? null;
    } catch (err) {
      console.warn(`[claim] team backend mask lookup failed for ${teamId}:`, err);
    }
    teamBackendMask.set(teamId, enabled);
    return enabled;
  };

  // Apply the team toggle's SAFE direction up front: if a task's backend is
  // disabled team-wide and the fallback is Claude, rewrite it to Claude now —
  // before the capability filter — so a Codex task with Codex disabled isn't
  // dropped for lacking Codex capability. (The Claude→Codex direction needs a
  // credential + the per-workspace slot, so it stays in the dispatch loop below.)
  for (const task of claimableTasks) {
    const enabled = await teamEnabledBackends((task as any).workspace?.teamId);
    if (maskBackend((task as any).backend as AgentBackend, enabled) === 'claude' && (task as any).backend !== 'claude') {
      (task as any).backend = 'claude';
    }
  }

  const runnerHasCodexBackend = capabilities.includes('backend:codex');
  const runnerHasLocalCodexAuth = capabilities.includes('OPENAI_API_KEY') || capabilities.includes('CODEX_HOME');
  const serverCredentialTaskIds = new Set<string>();
  if (runnerHasCodexBackend && !runnerHasLocalCodexAuth && process.env.ENCRYPTION_KEY) {
    await Promise.all(claimableTasks.map(async (task) => {
      if ((task as any).backend !== 'codex') return;
      const teamId = (task as any).workspace?.teamId;
      if (!teamId) return;
      try {
        if (await hasCodexCredential({ teamId, accountId: account.id, workspaceId: task.workspaceId })) {
          serverCredentialTaskIds.add(task.id);
        }
      } catch (err) {
        console.warn(`[claim] Failed to check Codex credential for task ${task.id}:`, err);
      }
    }));
  }

  // Filter by capabilities
  const filteredTasks = claimableTasks.filter((task) => {
    if ((task as any).backend === 'codex') {
      if (!runnerHasCodexBackend) return false;
      if (!runnerHasLocalCodexAuth && !serverCredentialTaskIds.has(task.id)) return false;
    }
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
  // Resolution: workspace override > team default > account-level (legacy).
  const uniqueRoleSlugs = [...new Set(
    filteredTasks.map(t => (t as any).roleSlug as string | null).filter(Boolean) as string[],
  )];
  const roleFloorMap = new Map<string, string>();
  if (uniqueRoleSlugs.length > 0) {
    const taskTeamIds = [...new Set(
      filteredTasks.map(t => (t as any).workspace?.teamId as string | undefined).filter(Boolean) as string[],
    )];
    const wsRoles = await db.query.workspaceSkills.findMany({
      where: and(
        inArray(workspaceSkills.slug, uniqueRoleSlugs),
        eq(workspaceSkills.isRole, true),
        eq(workspaceSkills.enabled, true),
        or(
          // Workspace override rows
          inArray(workspaceSkills.workspaceId, workspaceIds),
          // Team-level default rows
          taskTeamIds.length > 0
            ? and(isNull(workspaceSkills.workspaceId), inArray(workspaceSkills.teamId, taskTeamIds))
            : undefined,
          // Legacy account-level fallback
          eq(workspaceSkills.accountId, account.id),
        ),
      ),
      columns: { slug: true, model: true, workspaceId: true },
    });
    for (const r of wsRoles) {
      // Prefer the most-specific (workspace-scoped) entry if both exist.
      if (!roleFloorMap.has(r.slug) || r.workspaceId) {
        roleFloorMap.set(r.slug, r.model ?? 'inherit');
      }
    }
  }

  // Claim tasks and create workers with optimistic locking to prevent double-assignment.
  // Note: neon-http driver does not support interactive transactions (where intermediate
  // results inform subsequent queries). Instead, we use atomic UPDATE...WHERE status='pending'
  // which is inherently safe against concurrent claims at the SQL level.
  const claimedWorkers: ClaimTasksResponse['workers'] = [];

  // Per-workspace concurrency cap enforced within this batch. The SQL guard above
  // filtered candidates against *existing* active workers, but a single batch could
  // still claim several same-repo tasks at once (they all passed when the count was
  // below the cap). Seed the running tally with this account's existing active
  // workers per workspace and stop claiming once a repo workspace reaches its cap.
  const DEFAULT_MAX_CONCURRENT_TASKS = 3;
  const activeByWorkspace = new Map<string, number>();
  for (const w of activeWorkers) {
    if (!['running', 'starting', 'idle'].includes(w.status)) continue;
    activeByWorkspace.set(w.workspaceId, (activeByWorkspace.get(w.workspaceId) || 0) + 1);
  }

  // Budget failover throttling: Codex shares one 5-hour plan window, so at most
  // one Codex worker may run per workspace (the runner defers extras). Derive the
  // workspaces that already have an active Codex worker so we never route a second
  // budget-failover task into a busy workspace. `codexFlippedWorkspaces` tracks
  // flips made within this claim so a single claim can't over-funnel either.
  const codexBusyWorkspaces = new Set<string>();
  const codexFlippedWorkspaces = new Set<string>();
  const codexAvailability = new Map<string, boolean>();
  const activeTaskIds = activeWorkers.map(w => w.taskId).filter(Boolean) as string[];
  if (activeTaskIds.length > 0) {
    const activeCodexTasks = await db.query.tasks.findMany({
      where: and(inArray(tasks.id, activeTaskIds), eq(tasks.backend, 'codex')),
      columns: { workspaceId: true },
    });
    for (const t of activeCodexTasks) {
      if (t.workspaceId) codexBusyWorkspaces.add(t.workspaceId);
    }
  }
  // Memoized per-workspace Codex-credential check (scope-aware: team-wide, account, or workspace).
  const workspaceHasCodex = async (scope: { teamId: string; accountId?: string | null; workspaceId: string }): Promise<boolean> => {
    const wsId = scope.workspaceId;
    if (codexAvailability.has(wsId)) return codexAvailability.get(wsId)!;
    let available = false;
    try {
      available = await hasCodexCredential(scope);
    } catch (err) {
      console.warn(`[claim] Codex credential check failed for workspace ${wsId}:`, err);
    }
    codexAvailability.set(wsId, available);
    return available;
  };

  // Flip a task to Codex in-memory, respecting credential availability and the
  // ≤1-Codex-per-workspace throttle. Shared by the provider toggle and budget
  // failover. Returns true if the flip happened.
  const tryFlipToCodex = async (task: any, teamId?: string, wsId?: string): Promise<boolean> => {
    const codexFree = !!wsId && !codexBusyWorkspaces.has(wsId) && !codexFlippedWorkspaces.has(wsId);
    if (wsId && teamId && codexFree && await workspaceHasCodex({ teamId, accountId: account.id, workspaceId: wsId })) {
      task.backend = 'codex';
      codexFlippedWorkspaces.add(wsId);
      return true;
    }
    return false;
  };

  // Pre-fetch tasks with open PRs per workspace, keyed by workspaceId.
  // Used by the path-overlap claim guard below. Fetched once outside the loop
  // so we don't repeat the query for every candidate task.
  const openPrTasksByWorkspace = new Map<string, Array<{
    pathManifest: string[] | null;
    prNumber: number | null;
    prUrl: string | null;
  }>>();
  const openPrWorkspaceIds = [...new Set(filteredTasks.map(t => t.workspaceId))];
  if (openPrWorkspaceIds.length > 0) {
    const openPrWorkers = await db.query.workers.findMany({
      where: and(
        inArray(workers.workspaceId, openPrWorkspaceIds),
        not(isNull(workers.prUrl)),
        isNull(workers.mergedAt),
        inArray(workers.status, ['running', 'idle', 'starting', 'waiting_input', 'completed']),
      ),
      columns: { workspaceId: true, taskId: true, prNumber: true, prUrl: true },
    });
    if (openPrWorkers.length > 0) {
      const prTaskIds = openPrWorkers.map(w => w.taskId).filter(Boolean) as string[];
      const prTasks = prTaskIds.length > 0
        ? (await db.query.tasks.findMany({
            where: inArray(tasks.id, prTaskIds),
            columns: { id: true, pathManifest: true },
          })) ?? []
        : [];
      const prTaskManifestMap = new Map(prTasks.map(t => [t.id, t.pathManifest as string[] | null]));

      for (const w of openPrWorkers) {
        const manifest = w.taskId ? (prTaskManifestMap.get(w.taskId) ?? null) : null;
        const entry = { pathManifest: manifest, prNumber: w.prNumber, prUrl: w.prUrl };
        const list = openPrTasksByWorkspace.get(w.workspaceId) ?? [];
        list.push(entry);
        openPrTasksByWorkspace.set(w.workspaceId, list);
      }
    }
  }

  for (const task of filteredTasks) {
    // Allow tasks to declare a longer timeout via context.timeoutMinutes (max 240 min / 4 hours)
    const taskContext = task.context as Record<string, unknown> | null;

    // Path-overlap backstop: if this task declares a pathManifest and any open PR
    // in the same workspace comes from a task with an overlapping manifest, defer
    // this claim. Prevents two tasks from editing the same file in parallel when
    // the orchestrator forgot to serialize them with dependsOn edges.
    // (Regression guard for the PRs #1126/#1129 incident.)
    const taskManifest = (task as any).pathManifest as string[] | null;
    if (taskManifest?.length) {
      const openPrTasks = openPrTasksByWorkspace.get(task.workspaceId) ?? [];
      const blocking = findBlockingPr(taskManifest, openPrTasks);
      if (blocking) {
        console.log(`[claim] path_overlap_blocked: task ${task.id} deferred (manifest overlaps PR #${blocking.prNumber ?? blocking.prUrl})`);
        continue;
      }
    }

    // Per-repo concurrency cap (repo-backed workspaces only — repo-less ones are not
    // serialized). Each task is worktree-isolated, so the cap only bounds how many
    // branches run in parallel on one repo.
    const taskWorkspace = (task as any).workspace as { repo?: string | null; maxConcurrentTasks?: number | null } | undefined;
    if (taskWorkspace?.repo) {
      const cap = taskWorkspace.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS;
      if ((activeByWorkspace.get(task.workspaceId) || 0) >= cap) {
        continue;
      }
    }

    // Team provider toggle (reversible mask) — applied BEFORE budget logic so the
    // rest sees the effective backend. Disabling a provider here redirects matching
    // jobs to an enabled one at dispatch time, without touching stored settings;
    // re-enabling restores them automatically. See packages/core/backend-policy.ts.
    const taskTeamId = (task as any).workspace?.teamId as string | undefined;
    const enabledBackends = await teamEnabledBackends(taskTeamId);
    const codexEnabledForTeam = !enabledBackends || enabledBackends.includes('codex');
    const maskedBackend = maskBackend((task as any).backend as AgentBackend, enabledBackends);
    if (maskedBackend !== (task as any).backend) {
      if (maskedBackend === 'codex') {
        // Claude disabled team-wide → must run on Codex. Skip (leave pending) if
        // Codex has no credential or its single per-workspace slot is taken.
        if (!(await tryFlipToCodex(task, taskTeamId, task.workspaceId))) continue;
        console.log(`[claim] Provider toggle: task ${task.id} → Codex (Claude disabled for team ${taskTeamId})`);
      } else {
        // Codex disabled team-wide → run on Claude.
        (task as any).backend = 'claude';
        console.log(`[claim] Provider toggle: task ${task.id} → Claude (Codex disabled for team ${taskTeamId})`);
      }
    }

    // Determine whether this task is currently blocked by Claude budget/session
    // exhaustion (Codex-backend tasks are never blocked — separate credit pool).
    const tenantCtx = (taskContext?.tenantContext as { tenantId?: string }) || null;
    const isCodexTask = (task as any).backend === 'codex';
    let claudeBudgetBlocked = false;

    if (!isCodexTask) {
      if (accountBudgetExhausted && !tenantCtx?.tenantId) {
        // Account's own OAuth session/budget is exhausted.
        claudeBudgetBlocked = true;
      } else if (tenantCtx?.tenantId) {
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
              claudeBudgetBlocked = true;
            }
          }
        }
      }
    }

    // Proactive budget failover: rather than skip a Claude task until the session/
    // budget resets, route it to Codex *now* when (a) the workspace has a Codex
    // credential and (b) no Codex worker is already active there (≤1 per workspace).
    // The flip is in-memory only — scoped to this run, not a permanent backend change.
    // Tasks we can't fail over are left pending and retried on reset / when Codex frees.
    if (claudeBudgetBlocked) {
      // Only fail over to Codex if the team toggle allows it; otherwise leave the
      // task pending until the Claude budget resets.
      if (codexEnabledForTeam && await tryFlipToCodex(task, taskTeamId, task.workspaceId)) {
        console.log(`[claim] Budget failover: routing task ${task.id} to Codex (workspace ${task.workspaceId} Claude budget exhausted)`);
      } else {
        continue;
      }
    }

    // Workspace/project mismatch guard. If a task is pinned to a project name
    // (set by MCP at task creation), require that project to exist on the
    // workspace. Without this, a misrouted task — e.g. MCP connected to
    // workspace A but the task references a repo only present in workspace B —
    // gets claimed, the agent flails on a path that doesn't exist in the
    // worktree, stuck-detector kills the session, cleanup re-queues, repeat.
    const taskProject = (task as any).project as string | null;
    const workspaceProjects = ((task.workspace as any)?.projects || []) as Array<{ name: string }>;
    if (taskProject && workspaceProjects.length > 0 && !workspaceProjects.some((p) => p.name === taskProject)) {
      await db
        .update(tasks)
        .set({
          status: 'failed',
          claimedBy: null,
          claimedAt: null,
          expiresAt: null,
          updatedAt: now,
          context: {
            ...(taskContext || {}),
            terminalError: 'workspace_mismatch',
            terminalReason: `Task pinned to project "${taskProject}" but workspace ${task.workspaceId} has no project with that name. Check that MCP is connected to the workspace that owns this repo.`,
          },
        })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, 'pending')));
      continue;
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
    const TIER_ALIASES = new Set(['haiku', 'sonnet', 'opus', 'inherit']);
    const roleModel = roleSlug ? (roleFloorMap.get(roleSlug) ?? null) : null;
    const roleIsFullId = roleModel !== null && !TIER_ALIASES.has(roleModel);
    const routingDecision = resolveEffectiveModel({
      explicitModel: explicit ?? (roleIsFullId ? roleModel : null),
      kind: (task as any).kind || null,
      complexity: (task as any).complexity || null,
      roleFloor: roleIsFullId ? null : (roleModel as Tier | 'inherit' | null),
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

    // Count this claim toward the per-workspace cap for the rest of the batch.
    activeByWorkspace.set(task.workspaceId, (activeByWorkspace.get(task.workspaceId) || 0) + 1);

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

    // Shared mission branch (set by runMission) takes precedence — all mission
    // tasks push to the same branch so a single PR tracks the mission's work.
    const sharedHeadBranch = (patchedContext as Record<string, unknown> | null)?.headBranch;

    let branch: string;
    if (typeof sharedHeadBranch === 'string' && sharedHeadBranch.length > 0) {
      branch = sharedHeadBranch;
    } else if (gitConfig?.branchingStrategy === 'none') {
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
    // When the account's OAuth budget is exhausted, every non-tenant Claude task
    // above was skipped by the budget gate (and none could fail over to Codex).
    // That is NOT lock contention — returning a bare `race_lost` here hid the
    // real cause and, critically, omitted `budgetResetsAt`, so the runner had no
    // idea budget was blocking it or when it would clear. It then sat on its
    // hourly fallback poll instead of resuming at reset time. (Root cause of the
    // 2026-07-11 "work not picked up after budget is back" stall: 10 pending
    // Claude tasks idle for the full 5h window + up to another hour.)
    // Surface the reset time so the runner can schedule a resume poll for it.
    if (accountBudgetExhausted) {
      return NextResponse.json({
        workers: [],
        budgetResetsAt: account.budgetResetsAt,
        diagnostics: { reason: 'budget_exhausted' } satisfies ClaimDiagnostics,
      });
    }
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
        // Fetch task titles and manifests for PR context
        const prTaskIds = openPRWorkers.map(w => w.taskId).filter(Boolean) as string[];
        const prTasks = prTaskIds.length > 0
          ? (await db.query.tasks.findMany({
              where: inArray(tasks.id, prTaskIds),
              columns: { id: true, title: true, pathManifest: true },
            })) ?? []
          : [];
        const taskTitleMap = new Map(prTasks.map(t => [t.id, t.title]));
        const taskManifestMap = new Map(prTasks.map(t => [t.id, t.pathManifest as string[] | null]));

        const openPRs = openPRWorkers.map(w => ({
          branch: w.branch,
          prUrl: w.prUrl,
          prNumber: w.prNumber,
          taskTitle: w.taskId ? taskTitleMap.get(w.taskId) || null : null,
          pathManifest: w.taskId ? (taskManifestMap.get(w.taskId) ?? null) : null,
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

      // Inject sibling task manifests so agents can check whether a file they're about
      // to create is already owned by a pending/active sibling task.
      // (Agent doctrine: never re-implement another task's declared deliverable.)
      const siblingManifestTasks = (await db.query.tasks.findMany({
        where: and(
          inArray(tasks.workspaceId, workspaceIds),
          inArray(tasks.status, ['pending', 'assigned', 'in_progress']),
          isNotNull(tasks.pathManifest),
          not(inArray(tasks.id, claimedWorkers.map(cw => cw.taskId))),
        ),
        columns: { id: true, title: true, pathManifest: true, workspaceId: true },
      })) ?? [];

      if (siblingManifestTasks.length > 0) {
        for (const cw of claimedWorkers) {
          const task = filteredTasks.find(t => t.id === cw.taskId);
          const siblings = siblingManifestTasks
            .filter(s => s.workspaceId === task?.workspaceId)
            .map(s => ({ id: s.id, title: s.title, pathManifest: s.pathManifest as string[] }));
          if (siblings.length > 0) {
            (cw as any).siblingTaskManifests = siblings;
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
          model: (ws.model ?? 'inherit') as string,
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
            model: (ws.model ?? 'inherit') as string,
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

      // Look up the role: workspace override > team default (§C.2 precedence).
      const teamId = (task as any).workspace?.teamId as string | undefined;
      let role;

      if (teamId) {
        const rows = await db.select()
          .from(workspaceSkills)
          .where(and(
            eq(workspaceSkills.teamId, teamId),
            eq(workspaceSkills.slug, roleSlug),
            eq(workspaceSkills.enabled, true),
            eq(workspaceSkills.isRole, true),
            or(
              isNull(workspaceSkills.workspaceId),
              eq(workspaceSkills.workspaceId, wsId),
            ),
          ))
          .orderBy(sql`(${workspaceSkills.workspaceId} IS NOT NULL) DESC`)
          .limit(1);
        role = rows[0];
      }

      // Legacy account-level fallback
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

  // Inject related prior work into the agent's prompt at claim time — the worker
  // analog of the orchestrator's plan-time injection. Retrieved knowledge rides
  // the existing resolvedContextProviders rail into buildPrompt (no runner
  // change). Best-effort: buildKnowledgeContext returns [] on any failure.
  for (const cw of claimedWorkers) {
    const task = filteredTasks.find(t => t.id === cw.taskId);
    if (!task) continue;
    const goal = [task.title, (task as any).description].filter(Boolean).join('\n');
    const teamId = (task as any).workspace?.teamId;
    const parts = await buildKnowledgeContext(goal, task.workspaceId, teamId);
    // Known-entities catalog (§8.4): canonical entity names for the task's
    // likely files so agents don't invent loose refs. Best-effort — returns ''
    // on any failure; the extra .catch is belt-and-braces (claim must not 500).
    const entityCatalog = await buildEntityCatalogContext(goal, task.workspaceId).catch(() => '');
    if (entityCatalog) parts.push(entityCatalog);
    if (parts.length === 0) continue;

    const block = parts.join('\n');
    (cw as any).resolvedContextProviders = [...((cw as any).resolvedContextProviders ?? []), block];
    const taskObj = cw.task as any;
    if (taskObj) {
      taskObj.context = taskObj.context ?? {};
      taskObj.context.resolvedContextProviders = [...(taskObj.context.resolvedContextProviders ?? []), block];
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
            inArray(secrets.purpose, ['anthropic_api_key', 'oauth_token']),
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

        const [decryptedApiKey, decryptedOauthToken] = await Promise.all([
          apiKeySecret ? provider.get(apiKeySecret.id) : null,
          oauthSecret ? provider.get(oauthSecret.id) : null,
        ]);

        // TEMP diagnostic (value-free) — pin why serverOauthToken is empty in prod
        console.warn(`[claim-diag] task=${task.id} wsTeam=${workspaceTeamId} secrets=${workerSecrets.length} purposes=${workerSecrets.map(s => s.purpose).join('|')} oauthFound=${!!oauthSecret} oauthLen=${decryptedOauthToken?.length ?? 0} apiKeyLen=${decryptedApiKey?.length ?? 0}`);

        if (decryptedApiKey) {
          (cw as any).serverApiKey = decryptedApiKey;
        }
        if (decryptedOauthToken) {
          (cw as any).serverOauthToken = decryptedOauthToken;
        }
        // NOTE: mcp_credential secrets are no longer injected as a flat `mcpSecrets`
        // env map here. MCP servers now flow exclusively through connectors (below);
        // stdio-connector env vars are resolved from mcp_credential secrets there.
      }
    } catch (err) {
      // Non-fatal: worker can still use local credentials
      console.warn('Failed to decrypt server-managed secrets:', err);
    }
  }

  // Inject active MCP connectors (spec: docs/specs/mcp-connectors-and-roles.md §2/§3).
  //
  // Connectors are the single source of truth for MCP servers. A connector reaches
  // the agent for a task iff:
  //   role.connectorRefs  ∩  enabledForWorkspace  ∩  teamConnectors
  // where the role is resolved from the task's roleSlug (workspace override > team
  // default). No role or empty connectorRefs → mount nothing (least-privilege).
  //
  // Credentials are resolved by the connector's OWNER team (connector.teamId), not
  // the task's workspace team. Today they are equal; keying on the owner makes the
  // Phase-2 cross-team sharing a pure visibility widening (no injection rewrite).
  //
  // Separate block from the credential decryption above so connector injection is
  // not gated on workspace anthropic/oauth secrets being present.
  if (claimedWorkers.length > 0 && process.env.ENCRYPTION_KEY) {
    try {
      const connectorProvider = getSecretsProvider();

      for (const cw of claimedWorkers) {
        const task = cw.task as any;
        const workspaceTeamId = task?.workspace?.teamId as string | undefined;
        if (!workspaceTeamId) continue;

        // Resolve the task's role → connectorRefs. No role slug → no opt-in (§2 AC-3).
        const roleSlug = task?.roleSlug as string | null;
        if (!roleSlug) continue;

        const roleRows = await db.query.workspaceSkills.findMany({
          where: and(
            eq(workspaceSkills.slug, roleSlug),
            eq(workspaceSkills.isRole, true),
            eq(workspaceSkills.enabled, true),
            eq(workspaceSkills.teamId, workspaceTeamId),
            or(
              isNull(workspaceSkills.workspaceId),
              eq(workspaceSkills.workspaceId, task.workspaceId),
            ),
          ),
          columns: { connectorRefs: true, workspaceId: true },
        });
        if (roleRows.length === 0) continue;

        // Workspace-scoped override wins over the team-default row.
        const role = roleRows.find(r => (r as any).workspaceId) ?? roleRows[0];
        const connectorRefs = ((role as any).connectorRefs as string[] | null) ?? [];
        if (connectorRefs.length === 0) continue;

        // Cross-team sharing (§1b): visibility = owned ∪ shared-in. Fetch the
        // share grants for this team first, then keep only referenced connectors
        // that are owned by the task's team OR shared to it. A revoked share
        // (row absent) drops the connector here — no orphaned injection (§1b AC-5).
        // A dangling ref (deleted / invisible connector) simply drops out (§2 AC-4).
        const shareRows = await db.query.connectorShares.findMany({
          where: and(
            eq(connectorShares.sharedWithTeamId, workspaceTeamId),
            inArray(connectorShares.connectorId, connectorRefs),
          ),
          columns: { connectorId: true },
        });
        const sharedIdSet = new Set(shareRows.map(r => r.connectorId));

        const referencedRows = await db.query.connectors.findMany({
          where: inArray(connectors.id, connectorRefs),
        });
        const referencedConnectors = referencedRows.filter(
          c => c.teamId === workspaceTeamId || sharedIdSet.has(c.id),
        );
        if (referencedConnectors.length === 0) continue;

        // Filter to connectors enabled for this workspace (enabled !== false; a
        // missing connector_workspaces row is treated as enabled).
        const cwRows = await db.query.connectorWorkspaces.findMany({
          where: and(
            eq(connectorWorkspaces.workspaceId, task.workspaceId),
            inArray(connectorWorkspaces.connectorId, referencedConnectors.map(c => c.id)),
          ),
        });
        const cwMap = new Map(cwRows.map(r => [r.connectorId, r.enabled]));
        const activeConnectors = referencedConnectors.filter(c => cwMap.get(c.id) !== false);
        if (activeConnectors.length === 0) continue;

        const ownerTeamIds = [...new Set(activeConnectors.map(c => c.teamId))];

        // header/oauth credentials — keyed on the OWNER team (secrets.teamId = connector.teamId).
        const authConnectorIds = activeConnectors
          .filter(c => c.authMode === 'header' || c.authMode === 'oauth')
          .map(c => c.id);
        const connectorSecretMap = new Map<string, { id: string; tokenExpiresAt: Date | null }>();
        if (authConnectorIds.length > 0) {
          const connectorSecretRows = await db.query.secrets.findMany({
            where: and(
              inArray(secrets.teamId, ownerTeamIds),
              eq(secrets.purpose, 'mcp_connector_credential'),
              inArray(secrets.label, authConnectorIds),
            ),
            columns: { id: true, label: true, tokenExpiresAt: true },
          });
          for (const s of connectorSecretRows) {
            if (s.label) connectorSecretMap.set(s.label, { id: s.id, tokenExpiresAt: s.tokenExpiresAt ?? null });
          }
        }

        // stdio env-var credentials — mcp_credential secrets referenced by envMapping,
        // keyed on the owner team + secret label.
        const envLabels = [...new Set(
          activeConnectors
            .filter(c => c.transport === 'stdio')
            .flatMap(c => Object.values((c.envMapping as Record<string, string> | null) ?? {})),
        )];
        // Keyed by `${ownerTeamId}\0${label}` — the same label can exist in
        // several owner teams (§1b), and each connector must only ever see its
        // OWN team's secret value.
        const envSecretMap = new Map<string, string>();
        if (envLabels.length > 0) {
          const envSecretRows = await db.query.secrets.findMany({
            where: and(
              inArray(secrets.teamId, ownerTeamIds),
              eq(secrets.purpose, 'mcp_credential'),
              inArray(secrets.label, envLabels),
            ),
            columns: { id: true, label: true, teamId: true },
          });
          await Promise.all(envSecretRows.map(async (s) => {
            if (!s.label || !s.teamId) return;
            const val = await connectorProvider.get(s.id);
            if (val) envSecretMap.set(`${s.teamId}\0${s.label}`, val);
          }));
        }

        const mcpConnectors: ResolvedMcpConnector[] = [];

        // Slug-collision precedence (§1b): if an owned and a shared-in connector
        // slugify to the same MCP key, the OWNED one wins — process owned
        // connectors first and drop any later connector whose key is already
        // claimed (deterministic, no double-mount).
        const orderedConnectors = [
          ...activeConnectors.filter(c => c.teamId === workspaceTeamId),
          ...activeConnectors.filter(c => c.teamId !== workspaceTeamId),
        ];
        const claimedNames = new Set<string>();

        for (const connector of orderedConnectors) {
          const name = slugifyConnectorName(connector.name);
          if (claimedNames.has(name)) continue;
          claimedNames.add(name);

          // stdio transport: spawn a local process; env resolved from envMapping.
          // No headers, no url. Omit if a mapped secret is missing (AC-4 parity).
          if (connector.transport === 'stdio') {
            if (!connector.command) continue;
            const mapping = (connector.envMapping as Record<string, string> | null) ?? {};
            const env: Record<string, string> = {};
            let missing = false;
            for (const [envVar, label] of Object.entries(mapping)) {
              const val = envSecretMap.get(`${connector.teamId}\0${label}`);
              if (!val) { missing = true; break; }
              env[envVar] = val;
            }
            if (missing) continue;
            mcpConnectors.push({
              name,
              transport: 'stdio',
              command: connector.command,
              args: (connector.args as string[] | null) ?? [],
              ...(Object.keys(env).length > 0 ? { env } : {}),
            });
            continue;
          }

          // http transport.
          if (!connector.url) continue;

          if (connector.authMode === 'none') {
            mcpConnectors.push({ id: connector.id, name, transport: 'http', url: connector.url });
            continue;
          }

          // assertion-mode: return exchange metadata so the runner can mint+exchange
          if (connector.authMode === 'assertion') {
            if (!connector.assertionAudience || !connector.assertionTokenEndpoint) continue;
            mcpConnectors.push({
              id: connector.id,
              name,
              transport: 'http',
              url: connector.url,
              assertionMode: true,
              mintApiUrl: `https://buildd.dev/api/connectors/${connector.id}/assertion`,
              audience: connector.assertionAudience,
              tokenEndpoint: connector.assertionTokenEndpoint,
            });
            continue;
          }

          const secretInfo = connectorSecretMap.get(connector.id);
          if (!secretInfo) continue; // missing credential → omit (AC-4)

          if (connector.authMode === 'oauth') {
            // Refresh an expired access token at claim time; omit on unrecoverable failure (AC-3).
            if (secretInfo.tokenExpiresAt && new Date(secretInfo.tokenExpiresAt) < now) {
              const result = await refreshMcpConnectorCredential(secretInfo.id);
              if (result !== 'refreshed' && result !== 'locked') continue;
            }
            const decryptedValue = await connectorProvider.get(secretInfo.id);
            if (!decryptedValue) continue;
            try {
              const tokenBlob = JSON.parse(decryptedValue) as Record<string, unknown>;
              const accessToken = tokenBlob.access_token as string | undefined;
              if (!accessToken) continue;
              mcpConnectors.push({
                id: connector.id,
                name,
                transport: 'http',
                url: connector.url,
                headers: { Authorization: `Bearer ${accessToken}` },
              });
            } catch {
              // Malformed JSON blob — skip
            }
          } else if (connector.authMode === 'header') {
            const decryptedValue = await connectorProvider.get(secretInfo.id);
            if (!decryptedValue) continue;
            mcpConnectors.push({
              id: connector.id,
              name,
              transport: 'http',
              url: connector.url,
              headers: { [connector.headerName!]: decryptedValue },
            });
          }
        }

        if (mcpConnectors.length > 0) {
          (cw as any).mcpConnectors = mcpConnectors;
        }
      }
    } catch (err) {
      console.warn('Failed to inject MCP connector configs:', err);
    }
  }

  // Attach Codex credential for codex-backend tasks.
  // Fetched and decrypted at claim time so the runner never needs DB access.
  // Never included for non-codex tasks to limit token exposure.
  //
  // Runner trust model: access is gated on the same API key auth used for all
  // claim requests (authenticateApiKey above). Any account-level API key can
  // receive decrypted Codex tokens for tasks in workspaces it can claim.
  // There is no concept of "public-repo runner" in this architecture — runners
  // are private processes that present a buildd API key. If an API key is
  // compromised, the attacker gains the same access as the key holder (including
  // Codex tokens on codex-backend tasks). Protect API keys accordingly.
  if (process.env.ENCRYPTION_KEY) {
    for (const cw of claimedWorkers) {
      const task = filteredTasks.find(t => t.id === cw.taskId);
      if ((task as any)?.backend !== 'codex') continue;

      const wsId = task?.workspaceId;
      const teamId = (task as any)?.workspace?.teamId;
      if (!wsId || !teamId) continue;

      try {
        // Resolve the most-specific credential: workspace > account > team-wide.
        let cred = await resolveCodexCredential({ teamId, accountId: account.id, workspaceId: wsId });
        if (cred) {
          // D: Claim-gate refresh. If an OAuth credential is expired, attempt a
          // server-side refresh before sending it to the runner. A fresh token means
          // the runner starts immediately; an unrecoverable failure causes the
          // credential to be omitted, so the runner fast-fails with a clear error
          // instead of burning ~5 min on codex-binary retries.
          if (
            cred.credentialType === 'oauth' &&
            cred.tokenExpiresAt &&
            new Date(cred.tokenExpiresAt) < new Date()
          ) {
            const secretId = await getCodexSecretId({ teamId, accountId: account.id, workspaceId: wsId });
            if (secretId) {
              const refreshResult = await refreshCodexCredential(secretId);
              if (refreshResult === 'refreshed') {
                // Re-fetch the now-fresh credential
                const refreshed = await resolveCodexCredential({ teamId, accountId: account.id, workspaceId: wsId });
                if (refreshed) cred = refreshed;
                console.log(`[claim] Codex credential refreshed at claim time for workspace ${wsId}`);
              } else if (refreshResult === 'error') {
                // Refresh failed (e.g. refresh_token itself expired) — omit the
                // credential so the worker errors immediately with a clear message.
                console.warn(`[claim] Codex credential refresh failed for workspace ${wsId} — omitting credential`);
                cred = null;
              }
              // 'locked' means another refresh is in progress — proceed with the
              // existing (potentially just-refreshed) credential.
            }
          }
        }
        if (cred) {
          (cw as any).codexCredential = {
            credentialType: cred.credentialType,
            // OAuth fields (only set for OAuth credentials)
            ...(cred.credentialType === 'oauth'
              ? {
                  accessToken: cred.accessToken,
                  refreshToken: cred.refreshToken,
                  accountId: cred.accountId,
                }
              : {}),
            // API key (only set for api_key credentials)
            ...(cred.credentialType === 'api_key' ? { apiKey: cred.apiKey } : {}),
            expiresAt: cred.tokenExpiresAt,
          };
        }
      } catch (err) {
        console.warn(`[claim] Failed to fetch Codex credential for workspace ${wsId}:`, err);
      }
    }
  }

  // Notify on task claims — routed to the OWNING team's channel (not a global one).
  for (const cw of claimedWorkers) {
    const task = cw.task as any;
    const teamId = task?.workspace?.teamId as string | undefined;
    if (!teamId) continue;
    void notifyTeam(teamId, 'taskClaimed', {
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

import { BACKEND_PINNED_KEY } from '@buildd/core/backend-policy';
import { TERMINAL_TASK_STATUSES, isTerminalTaskStatus, type TaskStatusValue } from '@buildd/shared';
import { NextRequest, NextResponse, after } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workspaces, accountWorkspaces, workspaceSkills, missions, workers, missionNotes } from '@buildd/core/db/schema';
import { desc, asc, eq, and, or, not, gt, inArray, notInArray, gte, isNotNull, isNull, like, sql } from 'drizzle-orm';
import { MISSION_PR_TASK_PREFIX, missionIntegrationBase } from '@buildd/core/mission-integration';
import { isMissionLinkable } from '@/lib/mission-link-scope';
import { jsonResponse } from '@/lib/api-response';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveCreatorContext } from '@/lib/task-service';
import { validateRequiredConnectors } from '@/lib/required-connectors';
import { authenticateTaskScopedCaller, isDelegatedReach, taskScopeAllowsDelegated, taskScopeAllowsMission, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { emit } from '@/lib/core-emit';
import { withDispatchHint } from '@buildd/core/dispatch-outbox';
import { ensureMissionSurfaceAudit } from '@/lib/mission-surface-audit';
import { verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { isOwnedStorageKey } from '@/lib/storage-keys';
import { classifyTask } from '@/lib/task-category';
import { kindDefaultCandidates, kindDefaultRole, kindDefaultStamp, scheduleTaskRoleRouting } from '@/lib/task-role-apply';
import { scheduleCreationManifestShadow } from '@/lib/task-manifest-prediction';
import { heuristicTaskLabel, normalizeTaskLabel } from '@buildd/core/task-label';
import { TaskCategory, type TaskCategoryValue } from '@buildd/shared';
import { autoResolveAccountWorkspace } from '@/lib/workspace-resolver';
import { listReachableWorkspaceIds, resolveWorkspaceAccess } from '@/lib/workspace-access';
import { isAdvisoryManifest, hasConcretePathManifest, partitionOverlapEdges, type SoftOverlapEdge } from '@buildd/core/path-overlap';
import { inferFrictionManifest } from '@buildd/core/friction-manifest';
import { overlapTouchesSerializedSurface, resolveAnchorInjections } from '@/lib/change-intent';
import { recordPathDeclaration, manifestShape } from '@/lib/path-declaration-ledger';
import { laterStartAt, resolveDeferredStart } from '@/lib/deferred-start';
import { parseLoopConfig } from '@buildd/core/loop-config';
import { refreshStaleWorkersForWorkspaces } from '@/lib/pr-state-refresh';
import {
  prepareSubjectFiling,
  recordSubjectMatchObserved,
} from '@/lib/subject-anchor-observer';
import type { SubjectFilingOrigin } from '@buildd/core/subject-anchor-observe';
import { resolveSubjectPolicy, isIdentifyingSubjectKeyType } from '@buildd/core/subject-anchor-observe';
import { extractSubjectAnchor } from '@buildd/core/subject-anchor-extractor';
import { intakeSubject } from '@/lib/subject-intake';
import { createSubjectIntakeRepository } from '@/lib/subject-intake-db';
import { detectProseGate } from '@buildd/core/prose-gate';
import { findIntakeWarnings } from '@buildd/core/spec-discrepancy-intake';
import { isUuid } from '@/lib/uuid';
import {
  GATE_SLUGS,
  fireGateEvent,
  fireGateEventForWorkspaceRef,
  gateCallerOrigin,
} from '@/lib/gate-ledger';
// From `model-tier-defaults`, not `model-tier-registry`: the registry imports
// the db client, and this route only needs the tier vocabulary. Pulling the
// registry in here would add a DB dependency to task creation for a constant.
import { TIERS, type Tier } from '@buildd/core/model-tier-defaults';
import { inferRouting, computeRoutingPreview } from '@buildd/core/task-routing-preview';
import { pickRoleRowForTask, countRoleInferenceCandidates } from '@buildd/core/role-model-routing';
import { terminalAuditFields } from './audit-fields';

// Routing vocabulary for tasks.kind / tasks.complexity — the two inputs the
// claim-time router's kind×complexity matrix reads (see packages/core/model-router.ts).
// Mirrors the unions declared on the `tasks` table and the values the schedules
// path writes via classifyScheduleCadence.
const TASK_KINDS = [
  'coordination', 'engineering', 'research', 'writing', 'design', 'analysis', 'observation',
] as const;
const TASK_COMPLEXITIES = ['simple', 'normal', 'complex'] as const;
type TaskKind = (typeof TASK_KINDS)[number];
type TaskComplexity = (typeof TASK_COMPLEXITIES)[number];

// Field names that must never appear as string properties in outputSchemas for
// sensitive workspaces. These names are characteristic of content-bearing email
// fields that would route real data through the structured-output carve-out.
// Pointer fields (messageId, threadId, correlationKey, objectId) are fine.
// TODO: extend list as new content patterns are identified.
const OUTPUT_SCHEMA_CONTENT_DENYLIST = new Set([
  'subject', 'body', 'snippet', 'sender', 'from', 'to', 'email', 'address',
]);

/**
 * Returns property names from a JSON Schema that are both in the content denylist
 * and typed as plain strings. Checks top-level properties only — sufficient for
 * the cheap heuristic described in the sensitive-workspace spec.
 */
function detectContentBearingSchemaFields(schema: Record<string, unknown>): string[] {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return [];
  return Object.entries(properties)
    .filter(([name, def]) => OUTPUT_SCHEMA_CONTENT_DENYLIST.has(name.toLowerCase()) && def.type === 'string')
    .map(([name]) => name);
}

export async function GET(req: NextRequest) {
  // Dev mode returns empty
  if (process.env.NODE_ENV === 'development' && (!process.env.DATABASE_URL || !process.env.DEV_USER_EMAIL)) {
    return NextResponse.json({ tasks: [] });
  }

  // Check API key auth first
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  // A per-task token lists tasks only in its own task's workspace.
  const apiAccount = await authenticateTaskScopedCaller(apiKey, req);

  // Fall back to session auth
  const user = await getCurrentUser();

  if (!apiAccount && !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Same reach rule as workspace listing and task/mission creation
    // (lib/workspace-access.ts): an account sees its own team's open
    // workspaces plus its explicit links; a user sees their teams' workspaces.
    let workspaceIds: string[] = await listReachableWorkspaceIds(
      apiAccount ? { account: apiAccount } : { userId: user!.id },
    );
    if (apiAccount) workspaceIds = workspaceIds.filter(id => taskScopeAllowsWorkspace(apiAccount, id));

    // Optional query filters to scope the list and shrink the payload.
    //   ?workspaceId=<id>  — restrict to a single accessible workspace
    //   ?status=active     — only non-terminal tasks (drops the 24h terminal window)
    //   ?status=completed|failed|cancelled — audit mode: ALL matching tasks, fully
    //     paginated, no 24h window. Row shape gains updatedAt/summarySource/prNumber/
    //     hasArtifact so a caller can tell a real deliverable from a fallback summary
    //     with nothing shipped. Requires ?limit — this mode only exists on the lean path.
    //   ?limit=N&offset=M  — OPT-IN pagination; returns lean row shape + total/pendingCount/hasMore
    // Both workspaceId and status are used by the dependency picker so it stops
    // fetching every workspace's task and filtering client-side (see DependencySelector).
    //   ?missionId=<uuid>  — only tasks linked to that mission (400 on a malformed id:
    //     a filter that cannot be applied must never widen the result)
    const requestedWorkspaceId = req.nextUrl.searchParams.get('workspaceId');
    const statusFilter = req.nextUrl.searchParams.get('status');
    const missionIdFilter = req.nextUrl.searchParams.get('missionId');
    const limitParam = req.nextUrl.searchParams.get('limit');
    const offsetParam = req.nextUrl.searchParams.get('offset');

    // An unrecognised status used to fall through to the unfiltered default
    // branch, so a typo read as "all tasks" instead of an error.
    if (statusFilter !== null && statusFilter !== 'active' && !isTerminalTaskStatus(statusFilter)) {
      return NextResponse.json(
        { error: `status must be one of: active, ${TERMINAL_TASK_STATUSES.join(', ')} — received "${statusFilter}".` },
        { status: 400 },
      );
    }
    if (missionIdFilter !== null && !isUuid(missionIdFilter)) {
      return NextResponse.json(
        { error: `missionId must be a full mission UUID — received "${missionIdFilter}".` },
        { status: 400 },
      );
    }
    const missionScope = missionIdFilter ? eq(tasks.missionId, missionIdFilter) : undefined;

    // Intersect the requested workspace with the caller's accessible set.
    // If it isn't accessible, workspaceIds becomes empty → returns [] below
    // without leaking whether the workspace exists.
    if (requestedWorkspaceId) {
      workspaceIds = workspaceIds.filter(id => id === requestedWorkspaceId);
    }

    const terminalStatuses = [...TERMINAL_TASK_STATUSES];
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const activeOnly = statusFilter === 'active';
    const isTerminalAudit = isTerminalTaskStatus(statusFilter);

    // ── Paginated lean path (OPT-IN when ?limit=N is present) ──────────────
    // Returns only the columns list consumers need, sorted pending-first /
    // priority-desc (server-side), with total + pendingCount + hasMore so
    // callers never have to fetch all rows just to render a header line.
    if (limitParam !== null) {
      const limit = Math.min(Math.max(parseInt(limitParam, 10) || 0, 1), 200);
      const offset = Math.max(parseInt(offsetParam ?? '0', 10) || 0, 0);

      if (workspaceIds.length === 0) {
        return jsonResponse({ tasks: [], total: 0, pendingCount: 0, hasMore: false }, undefined, { route: req.nextUrl.pathname });
      }

      const where = and(
        inArray(tasks.workspaceId, workspaceIds),
        missionScope,
        activeOnly
          ? notInArray(tasks.status, terminalStatuses)
          : isTerminalAudit
            // Audit mode: exact status, no 24h cutoff — the whole terminal history,
            // paginated by the caller instead of silently windowed.
            ? eq(tasks.status, statusFilter as TaskStatusValue)
            : or(
                notInArray(tasks.status, terminalStatuses),
                and(
                  inArray(tasks.status, terminalStatuses),
                  gte(tasks.updatedAt, oneDayAgo),
                ),
              ),
      );

      const [countsResult, leanTasks] = await Promise.all([
        db.select({
          total: sql<number>`count(*)::int`,
          pendingCount: sql<number>`count(*) filter (where ${tasks.status} = 'pending')::int`,
        }).from(tasks).where(where),
        db.select({
          id: tasks.id,
          workspaceId: tasks.workspaceId,
          title: tasks.title,
          label: tasks.label,
          status: tasks.status,
          priority: tasks.priority,
          category: tasks.category,
          descriptionPreview: sql<string | null>`left(${tasks.description}, 150)`,
          // Deliverable attribution — only worth the extra columns/join in audit
          // mode, where the whole point is telling a real completion from a
          // fallback summary with nothing shipped.
          ...(isTerminalAudit ? terminalAuditFields : {}),
        })
        .from(tasks)
        .where(where)
        .orderBy(
          ...(isTerminalAudit
            ? [desc(tasks.updatedAt), asc(tasks.id)]
            : [
                // Claimable (pending) first, then running, then other active
                sql`CASE WHEN ${tasks.status} = 'pending' THEN 0 WHEN ${tasks.status} = 'assigned' THEN 1 WHEN ${tasks.status} = 'in_progress' THEN 2 ELSE 3 END`,
                desc(tasks.priority),
                asc(tasks.id),
              ]),
        )
        .limit(limit)
        .offset(offset),
      ]);

      const total = countsResult[0]?.total ?? 0;
      const pendingCount = countsResult[0]?.pendingCount ?? 0;

      try {
        after(() =>
          refreshStaleWorkersForWorkspaces(workspaceIds).catch(err =>
            console.error('[pr-state-refresh] task list refresh failed:', err)
          )
        );
      } catch {
        // after() unavailable outside request scope (tests/build)
      }

      return jsonResponse({
        tasks: leanTasks,
        total,
        pendingCount,
        hasMore: offset + limit < total,
      }, undefined, { route: req.nextUrl.pathname });
    }

    // ── Full (un-paginated) path — existing behaviour, dashboard-safe ───────
    // Returns all active tasks + completed/failed from the last 24h, with the
    // wide column set the dashboard reads. budgetWindows is included for MCP
    // callers that need budget-reset info alongside the task list.
    const allTasks = workspaceIds.length > 0
      ? await db.query.tasks.findMany({
          where: and(
            inArray(tasks.workspaceId, workspaceIds),
            missionScope,
            activeOnly
              ? // Only active (non-terminal) tasks
                notInArray(tasks.status, terminalStatuses)
              : or(
                  // Active tasks (pending, assigned, in_progress, etc.)
                  notInArray(tasks.status, terminalStatuses),
                  // Terminal tasks from the last 24h
                  and(
                    inArray(tasks.status, terminalStatuses),
                    gte(tasks.updatedAt, oneDayAgo),
                  ),
                ),
          ),
          orderBy: desc(tasks.createdAt),
          limit: 200,
          columns: {
            id: true,
            workspaceId: true,
            externalId: true,
            externalUrl: true,
            title: true,
            status: true,
            priority: true,
            mode: true,
            runnerPreference: true,
            requiredCapabilities: true,
            claimedBy: true,
            claimedAt: true,
            expiresAt: true,
            startAt: true,
            createdByAccountId: true,
            createdByWorkerId: true,
            creationSource: true,
            parentTaskId: true,
            category: true,
            label: true,
            project: true,
            outputRequirement: true,
            missionId: true,
            dependsOn: true,
            createdAt: true,
            updatedAt: true,
          },
          with: {
            workspace: {
              columns: {
                id: true,
                name: true,
                repo: true,
              },
            },
          },
        })
      : [];

    // Stale-while-revalidate: refresh stale PR state for workers in these
    // workspaces after the response is sent, pushing updates via WORKER_PROGRESS.
    if (workspaceIds.length > 0) {
      try {
        after(() =>
          refreshStaleWorkersForWorkspaces(workspaceIds).catch(err =>
            console.error('[pr-state-refresh] task list refresh failed:', err)
          )
        );
      } catch {
        // after() unavailable outside request scope (tests/build)
      }
    }

    return jsonResponse({
      tasks: allTasks,
      budgetWindows: apiAccount ? {
        claude: {
          resetAt: apiAccount.budgetResetsAt?.toISOString?.() ?? apiAccount.budgetResetsAt ?? null,
          resolution: apiAccount.budgetResetsAt ? 'known_budget_reset' : 'default_budget_window',
        },
        codex: {
          resetAt: null,
          resolution: 'default_budget_window',
        },
      } : undefined,
    }, undefined, { route: req.nextUrl.pathname });
  } catch (error) {
    // Audit mode (a terminal ?status) reaches a workspace's entire history with
    // no 24h window — the one query path where an unusual row shape or a slow
    // scan is most likely to surface. A bare "Failed to get tasks" discarded
    // exactly the detail needed to tell those apart, forcing every prior
    // diagnosis of this endpoint to start from a live repro instead of the log.
    const detail = error instanceof Error ? error.message : String(error);
    console.error('Get tasks error:', error);
    return NextResponse.json({ error: 'Failed to get tasks', detail }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  // Dev mode returns mock
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ id: 'dev-task', title: 'Dev Task' });
  }

  // Check API key auth first
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  // A per-task token may file tasks (follow-ups, friction) only in its own
  // task's workspace, which is also where an unspecified workspace resolves.
  const apiAccount = await authenticateTaskScopedCaller(apiKey, req);

  // Fall back to session auth
  const user = await getCurrentUser();

  if (!apiAccount && !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Declared outside the try block so the catch below can reference it in the
  // file_anyway_not_allowed error — it's assigned partway through the try body.
  let subjectOriginForError: SubjectFilingOrigin | undefined;
  // Same reason, for the gate-ledger rows the catch block writes: by the time
  // a fileAnyway refusal surfaces as a thrown sentinel, the resolved workspace
  // is no longer in scope.
  let gateWorkspaceId: string | null = null;
  let gateCaller = gateCallerOrigin({ apiAccount, user });

  try {
    const body = await req.json();
    const {
      workspaceId: rawWorkspaceId,
      title,
      // Short 2–4 word display label; the classifier below fills it when omitted.
      label: rawLabel,
      description,
      priority,
      runnerPreference,
      requiredCapabilities,
      attachments,
      // New creator tracking fields
      createdByWorkerId,
      parentTaskId,
      creationSource: requestedSource,
      // Direct assignment to a specific runner instance
      assignToLocalUiUrl,
      // Skill slugs
      skillSlugs: rawSkillSlugs,
      // JSON Schema for structured output
      outputSchema,
      // Task category
      category: rawCategory,
      // Output requirement — what deliverables are enforced on completion
      outputRequirement: rawOutputRequirement,
      // Project scoping
      project,
      // Mission linking (reassigned below only to drop an inherited link on a delegated follow-up)
      missionId: requestedMissionId,
      // Workflow DAG: task IDs that must complete before this task is claimable
      dependsOn,
      // Role routing — only runners with this skill can claim the task
      roleSlug,
      // Connector IDs (subset of role's connectorRefs) this task requires at claim time.
      requiredConnectors: rawRequiredConnectors,
      // Incoming context (from MCP or API callers — baseBranch, iteration, failureContext, etc.)
      context: incomingContext,
      // Release override: 'true' | 'false' | 'inherit' (default inherit)
      release: rawRelease,
      // Agent backend that executes this task: 'claude' | 'codex'
      backend: rawBackend,
      // Whether this task requires human review before auto-merge
      requiresReview: rawRequiresReview,
      // Declared file paths/globs this task expects to create or modify.
      // Used to auto-add dependsOn edges between tasks that touch the same files.
      pathManifest: rawPathManifest,
      // Intelligence tier — resolved to a concrete model at claim time via the team's registry.
      tier: rawTier,
      // Routing inputs — the claim-time router's kind×complexity matrix reads these.
      kind: rawKind,
      complexity: rawComplexity,
      // Spec-to-build opt-in: forces mode: 'planning' + context.requiresPlanApproval,
      // both non-overridable by the caller. See the emitsPlan gate below.
      emitsPlan: rawEmitsPlan,
      startAt: rawStartAt,
      startIn: rawStartIn,
      startAfter: rawStartAfter,
      loopConfig: rawLoopConfig,
      subjectAnchor: rawSubjectAnchor,
      fileAnywayReason,
    } = body;
    let missionId: string | undefined = requestedMissionId;

    gateCaller = gateCallerOrigin({ apiAccount, user, workerId: createdByWorkerId });

    // Spec-to-build opt-in — see docs/design/spec-to-build-pattern.md Proposal §1.
    // Never opens `mode` itself as a public parameter (that would let any task,
    // spec or not, mint a mode: 'planning' task the mission machinery doesn't
    // expect); this is the one narrow, explicit, server-validated entry point.
    const emitsPlan = rawEmitsPlan === true;

    if (!title) {
      return NextResponse.json({ error: 'Title is required' }, { status: 400 });
    }

    if (rawLabel !== undefined && rawLabel !== null && typeof rawLabel !== 'string') {
      return NextResponse.json({ error: 'label must be a string (2–4 words, max 48 chars)' }, { status: 400 });
    }

    // Routing inputs. Same vocabulary as tasks.kind / tasks.complexity in the
    // schema and as classifyScheduleCadence writes on the schedules path.
    // An out-of-vocabulary value is a 400, not a silent drop — a hint the caller
    // believes was applied but wasn't is worse than an error.
    //
    // These two fire ABOVE the workspace lookup, so the ledger resolves the raw
    // reference in the background rather than reordering the validation (which
    // would change which error a doubly-invalid request gets back).
    if (rawKind !== undefined && !TASK_KINDS.includes(rawKind)) {
      const error = `kind must be one of: ${TASK_KINDS.join(', ')}`;
      const frictionSignature = fireGateEventForWorkspaceRef(rawWorkspaceId, {
        gate: GATE_SLUGS.TASK_PARAM_VOCABULARY,
        surface: 'POST /api/tasks',
        outcome: 'rejected',
        reason: error,
        callerOrigin: gateCaller,
        detail: { param: 'kind', value: String(rawKind).slice(0, 80) },
      });
      return NextResponse.json({ error, frictionSignature }, { status: 400 });
    }
    if (rawComplexity !== undefined && !TASK_COMPLEXITIES.includes(rawComplexity)) {
      const error = `complexity must be one of: ${TASK_COMPLEXITIES.join(', ')}`;
      const frictionSignature = fireGateEventForWorkspaceRef(rawWorkspaceId, {
        gate: GATE_SLUGS.TASK_PARAM_VOCABULARY,
        surface: 'POST /api/tasks',
        outcome: 'rejected',
        reason: error,
        callerOrigin: gateCaller,
        detail: { param: 'complexity', value: String(rawComplexity).slice(0, 80) },
      });
      return NextResponse.json({ error, frictionSignature }, { status: 400 });
    }

    // Prose-gate lint: advisory only. If description declares a dependency gate in prose
    // (e.g., "Gated on task X merging") but dependsOn is empty, surface a warning suggestion
    // to the response. The lint is informational, not a rejection — task descriptions
    // naturally contain gate/merge/task/PR language since they describe coordination.
    let proseGateWarning: { phrase: string; taskIds: string[] } | null = null;
    if (description) {
      const gate = detectProseGate(description);
      if (gate.phrase !== null && (!Array.isArray(dependsOn) || dependsOn.length === 0)) {
        proseGateWarning = { phrase: gate.phrase, taskIds: gate.taskIds };
      }
    }

    const verificationCommand = typeof incomingContext?.verificationCommand === 'string'
      ? incomingContext.verificationCommand
      : undefined;
    let loopConfig;
    try {
      loopConfig = parseLoopConfig(rawLoopConfig, verificationCommand);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Invalid loopConfig' },
        { status: 400 },
      );
    }

    // Resolve workspace: explicit param → auto-resolve for API accounts
    let workspaceId: string | undefined;

    if (rawWorkspaceId) {
      // Resolve by UUID, repo name, or workspace name, and decide reach with
      // the shared rule (lib/workspace-access.ts) — the one workspace listing
      // and mission creation use. "Exists but not reachable" is a 403 that
      // says so, not a misleading "not found".
      const access = await resolveWorkspaceAccess(
        String(rawWorkspaceId),
        apiAccount ? { account: apiAccount } : { userId: user!.id },
        'canCreate',
      );
      if (!access.ok) {
        return NextResponse.json(
          { error: access.error },
          // Not-found keeps its historical 400 on this route.
          { status: access.reason === 'no_access' ? 403 : 400 },
        );
      }
      workspaceId = access.workspace.id;
    } else if (apiAccount?.taskScope) {
      workspaceId = apiAccount.taskScope.workspaceId;
    } else if (apiAccount) {
      // Auto-resolve: if account linked to exactly one workspace, use it
      const result = await autoResolveAccountWorkspace(apiAccount.id, apiAccount.name);
      if ('error' in result) {
        return NextResponse.json({ error: result.error }, { status: result.status });
      }
      workspaceId = result.workspaceId;
    }

    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    // A task token files in its own workspace, or in one its schedule's
    // delegation grants tasks:create on (packages/core/token-delegation.ts).
    if (apiAccount && !taskScopeAllowsDelegated(apiAccount, workspaceId, 'tasks:create')) {
      return NextResponse.json({ error: 'A task token may create tasks only in its own workspace, or one its schedule delegates tasks:create on' }, { status: 403 });
    }
    // A delegated follow-up is a plain task: it never joins a mission or a
    // dependency graph in the other workspace, so it cannot steer work there.
    // Its parent is the filing task itself (derived from the worker), which
    // is the audit link back to the run that filed it.
    if (apiAccount?.taskScope && isDelegatedReach(apiAccount, workspaceId)) {
      // MCP create_task fills in the filing task's own mission by default;
      // that link stays home rather than refusing the follow-up.
      if (missionId && await taskScopeAllowsMission(apiAccount, missionId)) missionId = undefined;
      if (missionId || (Array.isArray(dependsOn) && dependsOn.length > 0)) {
        return NextResponse.json({ error: 'A delegated task cannot set missionId or dependsOn' }, { status: 400 });
      }
      if (parentTaskId && parentTaskId !== apiAccount.taskScope.taskId) {
        return NextResponse.json({ error: 'A delegated task can only name its filing task as parent' }, { status: 400 });
      }
    }
    gateWorkspaceId = workspaceId;

    // Validate workspace exists and fetch webhook config in one query
    const targetWorkspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
    });
    if (!targetWorkspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 400 });
    }
    // A mission link must stay inside the workspace's team (see isMissionLinkable).
    // Checked before any write, including the friction-dedupe append below.
    if (missionId && !(await isMissionLinkable(missionId, targetWorkspace.teamId))) {
      return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    }
    // A per-task token files work only onto its own task's mission, never
    // another mission on the team, whatever its level.
    if (missionId && apiAccount && !(await taskScopeAllowsMission(apiAccount, missionId))) {
      return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    }
    const subjectPolicy = resolveSubjectPolicy(targetWorkspace.gitConfig?.subjectPolicy);

    // Verify workspace access with actionable errors
    if (apiAccount) {
      const hasAccess = await verifyAccountWorkspaceAccess(apiAccount.id, workspaceId, 'canCreate');
      if (!hasAccess) {
        return NextResponse.json(
          { error: `Account "${apiAccount.name}" does not have permission to create tasks in this workspace.` },
          { status: 403 }
        );
      }
    }

    // Validate and normalize pathManifest
    let pathManifest: string[] | null =
      Array.isArray(rawPathManifest) && rawPathManifest.every((p: unknown) => typeof p === 'string')
        ? rawPathManifest
        : null;

    // emitsPlan gate: a spec task must name the document it authors so the
    // dispatch-time spec-discrepancy injection and approvePlan's specSource
    // traceability write (docs/design/spec-to-build-pattern.md §3) have an
    // anchor to key off. Reuses pathManifest verbatim — no new field.
    if (emitsPlan && (!pathManifest || pathManifest.length === 0)) {
      const error =
        "a spec task (emitsPlan: true) must declare pathManifest naming the spec document it authors";
      const frictionSignature = fireGateEvent({
        gate: GATE_SLUGS.EMITS_PLAN_MANIFEST_REQUIRED,
        surface: 'POST /api/tasks',
        outcome: 'rejected',
        reason: error,
        workspaceId,
        missionId,
        callerOrigin: gateCaller,
      });
      return NextResponse.json({ error, frictionSignature }, { status: 400 });
    }

    // Dedup gate for friction tasks.
    // When an agent provides context.frictionSignature (the error-pattern slug from
    // get_error_traces), we check for an open friction task with the same signature
    // in this workspace. On match: append the caller's report to the existing task
    // description and return it (deduplicated:true) without creating a new row.
    // On miss: fall through to normal creation — frictionSignature persists in context
    // via the incomingContext spread below.
    const frictionSignature = typeof incomingContext?.frictionSignature === 'string'
      ? incomingContext.frictionSignature
      : null;

    if (subjectPolicy.mode === 'observe' && title.startsWith('[friction] ') && frictionSignature) {
      const existing = await db.query.tasks.findFirst({
        where: and(
          eq(tasks.workspaceId, workspaceId),
          like(tasks.title, '[friction] %'),
          sql`${tasks.context}->>'frictionSignature' = ${frictionSignature}`,
          notInArray(tasks.status, ['completed', 'failed', 'cancelled']),
        ),
        columns: { id: true, title: true, description: true, creationSource: true },
      });

      if (existing) {
        const workerRef = createdByWorkerId ? `Worker ${createdByWorkerId}` : 'Another worker';
        const appendText = `\n\n---\n_${workerRef} also reported this error._\n${description || ''}`.trim();
        await db.update(tasks)
          .set({ description: sql`${tasks.description} || ${appendText}`, updatedAt: new Date() })
          .where(eq(tasks.id, existing.id));

        const observedAnchor = extractSubjectAnchor({
          context: incomingContext as Record<string, unknown>,
        }).anchor;
        if (observedAnchor) {
          await recordSubjectMatchObserved({
            workspaceId,
            origin: 'friction',
            reporterId: apiAccount?.id ?? null,
            anchor: observedAnchor,
            match: {
              taskId: existing.id,
              matchedOrigin: existing.creationSource ?? 'api',
              outcome: 'attach',
              keyType: 'error',
            },
          });
        }

        fireGateEvent({
          gate: GATE_SLUGS.FRICTION_DEDUPE,
          surface: 'POST /api/tasks',
          outcome: 'rejected',
          reason: 'friction report appended to an open task with the same signature',
          workspaceId,
          taskId: existing.id,
          callerOrigin: gateCaller,
          detail: { frictionSignature },
        });

        const { creationSource: _creationSource, ...existingResponse } = existing;
        return NextResponse.json({ ...existingResponse, deduplicated: true }, { status: 200 });
      }
    }

    // Infer pathManifest for friction tasks that don't supply one.
    // On the dedup-miss path (new friction task), extract repo-relative paths
    // from the error excerpt or fall back to the static component table.
    // The inferred manifest then flows into the auto-dependsOn block below
    // unchanged — no friction-specific handling downstream.
    if (title.startsWith('[friction] ') && frictionSignature && !pathManifest) {
      const excerpt = typeof incomingContext?.frictionExcerpt === 'string'
        ? incomingContext.frictionExcerpt
        : description || '';
      const inferred = inferFrictionManifest(frictionSignature, excerpt);
      if (inferred.length > 0) {
        pathManifest = inferred;
      }
    }

    // Conservative default for mission tasks without an explicit pathManifest:
    // record the repo-wide sentinel ['**'] to mark "scope undeclared".
    //
    // The sentinel is ADVISORY ONLY. It does NOT drive dependsOn serialization —
    // the auto-dependsOn pass below uses partitionOverlapEdges(), which
    // refuses to mint an edge when either side carries '**' (matching the
    // claim-time gates: findBlockingPr() and the path_claims layer-2 backstop
    // both skip the sentinel). Treating it as a hard dependency turned
    // creation-order FIFO into a permanent BLOCKED graph: manifest-less mission
    // tasks inherited an edge to every task alive in the workspace at creation.
    //
    // What the sentinel still buys: it is inherited by conflict-retry tasks, it
    // records that the filer never declared scope (visible to the organizer and
    // reviewer prompts), and workers can narrow it mid-task via check_path_claim
    // / POST /api/tasks/[id]/path-claim, which DO take real locks on concrete
    // paths. Concurrent same-file edits between two scope-undeclared tasks are
    // covered by those claim-time mutexes, not by stored edges.
    //
    // Callers that know exactly which files they'll touch should always pass
    // pathManifest explicitly — concrete manifests still auto-serialize.
    if (missionId && !pathManifest) {
      pathManifest = ['**'];
    }

    // Validate dependsOn references are valid UUIDs
    if (Array.isArray(dependsOn) && dependsOn.length > 0) {
      const invalidIds = dependsOn.filter((id: unknown) => !isUuid(id));
      if (invalidIds.length > 0) {
        return NextResponse.json(
          { error: `dependsOn contains invalid task IDs (must be valid UUIDs): ${invalidIds.join(', ')}` },
          { status: 400 }
        );
      }

      const depTasks = await db.query.tasks.findMany({
        where: and(inArray(tasks.id, dependsOn), eq(tasks.workspaceId, workspaceId)),
        columns: { id: true },
      });
      const foundIds = new Set(depTasks.map(t => t.id));
      const missing = dependsOn.filter((id: string) => !foundIds.has(id));
      if (missing.length > 0) {
        return NextResponse.json(
          { error: `dependsOn references unknown tasks in this workspace: ${missing.join(', ')}` },
          { status: 400 }
        );
      }
    }

    // Sequence-namespace anchor injection (see docs/design/change-intent.md §3).
    // If this task's pathManifest touches a sequenceNamespace directory (e.g. the
    // Drizzle migrations dir), auto-append the anchorFile so the overlap check
    // below can serialise on _journal.json — not on the individual migration filename,
    // which would be invisible because distinct filenames share the integer index.
    let anchorInjectedCount = 0;
    if (pathManifest && pathManifest.length > 0) {
      const injections = resolveAnchorInjections(pathManifest, targetWorkspace.gitConfig ?? undefined);
      if (injections.length > 0) {
        pathManifest = [...pathManifest, ...injections];
        anchorInjectedCount = injections.length;
      }
    }

    // Path-overlap serialization against in-flight tasks (regression: PRs
    // #1126/#1129), split into HARD and SOFT by `partitionOverlapEdges`:
    //  - hard (a stored dependsOn edge): a migration/schema path, a workspace
    //    serialized surface, or the same file when it is generated or an
    //    explicit hotspot (lib/hard-overlap-surfaces.ts);
    //  - soft (scheduling evidence on pathDeclaration.softOverlaps, never an
    //    edge): any other same-file or directory-prefix overlap. The claim route holds on it
    //    while the other task is in flight unless HOLD/START says START, and
    //    live path leases still stop simultaneous edits.
    // Turning every prefix overlap into an edge queued honest broad scope
    // (`scripts/`) behind every task under it, until each one merged.
    //
    // A repo-wide sentinel on either side produces nothing (advisory). Caller-
    // supplied dependsOn is copied in first and never modified.
    let resolvedDependsOn: string[] = Array.isArray(dependsOn) ? [...dependsOn] : [];
    // Recorded on pathDeclaration so a later narrowing can tell these apart
    // from caller-supplied edges, which must never be removed.
    const inferredDependsOn: string[] = [];
    let softOverlaps: SoftOverlapEdge[] = [];
    if (pathManifest && pathManifest.length > 0 && !isAdvisoryManifest(pathManifest)) {
      const existingDepsSet = new Set(resolvedDependsOn);
      const inFlightTasks = await db.query.tasks.findMany({
        where: and(
          eq(tasks.workspaceId, workspaceId),
          inArray(tasks.status, ['pending', 'assigned', 'in_progress']),
          isNotNull(tasks.pathManifest),
        ),
        columns: { id: true, pathManifest: true },
      });
      const overlapGitConfig = targetWorkspace.gitConfig ?? null;
      const split = partitionOverlapEdges(
        pathManifest,
        inFlightTasks.map(t => ({ id: t.id, pathManifest: t.pathManifest as string[] | null })),
        {
          skip: (id) => existingDepsSet.has(id),
          isSerialized: (paths, kind) => overlapTouchesSerializedSurface(paths, overlapGitConfig, kind),
        },
      );
      for (const id of split.hard) {
        resolvedDependsOn.push(id);
        inferredDependsOn.push(id);
        existingDepsSet.add(id);
      }
      softOverlaps = split.soft;
    }

    // Resolve creator context using the service
    const creatorContext = await resolveCreatorContext({
      apiAccount,
      userId: user?.id,
      createdByWorkerId,
      parentTaskId,
      creationSource: requestedSource,
    });
    const creationSource = creatorContext.creationSource ?? 'api';

    // Decomposition re-check gate. `runMission()` detects pre-filed sibling
    // tasks exactly ONCE, when the mission's planning task is created — but
    // `manage_missions create` calls it in the SAME request that creates the
    // mission, before a creator who files tasks right after create gets a
    // chance to. That leaves the organizer's prompt frozen on full
    // decomposition even though sibling tasks land moments later. Re-run the
    // same check here, at the point decomposition actually happens: when the
    // calling worker's own current task IS the mission's organizer/planning
    // task, and it tries to create a non-retry child (no explicit
    // `parentTaskId` — a retry names the failing task explicitly and stays
    // exempt), refuse if sibling tasks were filed after the organizer's
    // planning task started.
    if (missionId && !parentTaskId && createdByWorkerId) {
      const callingWorker = await db.query.workers.findFirst({
        where: eq(workers.id, createdByWorkerId),
        columns: { taskId: true },
      });
      const callingTask = callingWorker?.taskId
        ? await db.query.tasks.findFirst({
            where: eq(tasks.id, callingWorker.taskId),
            columns: { id: true, missionId: true, mode: true, creationSource: true, createdAt: true },
          })
        : null;
      if (
        callingTask
        && callingTask.missionId === missionId
        && callingTask.mode === 'planning'
        && callingTask.creationSource === 'orchestrator'
      ) {
        const missionRow = await db.query.missions.findFirst({
          where: eq(missions.id, missionId),
          columns: { decompositionSkipped: true, orchestrationMode: true },
        });
        // `orchestrationMode === 'manual'` is the one exemption, matching
        // runMission()'s own heuristic. An already-`decompositionSkipped`
        // mission is NOT exempt here — this same organizer task can still
        // call create_task several times in one decomposition pass (that is
        // the exact shape of the original incident: 3 sibling build tasks
        // created back to back), so every one of those calls must be
        // re-checked, not just the first. The flag only controls whether the
        // persist-and-note below is a no-op repeat.
        if (missionRow && missionRow.orchestrationMode !== 'manual') {
          const preFiled = await db.query.tasks.findMany({
            where: and(
              eq(tasks.missionId, missionId),
              not(eq(tasks.creationSource, 'orchestrator')),
              not(eq(tasks.mode, 'planning')),
              gt(tasks.createdAt, callingTask.createdAt),
              // Exclude the organizer's own earlier creates in this same
              // decomposition pass — those stamp creationSource 'mcp' and
              // mode 'execution' just like a creator-filed task, so without
              // this the organizer's 2nd/3rd create_task call would see its
              // own 1st call's task and wrongly refuse itself.
              not(eq(tasks.createdByWorkerId, createdByWorkerId)),
            ),
            columns: { id: true },
            limit: 20,
          });
          if (preFiled.length > 0) {
            const preFiledTaskIds = preFiled.map(t => t.id);
            if (!missionRow.decompositionSkipped) {
              await db.update(missions)
                .set({ decompositionSkipped: true, updatedAt: new Date() })
                .where(eq(missions.id, missionId));
              await db.insert(missionNotes).values({
                missionId,
                authorType: 'system',
                type: 'decision',
                title: 'Decomposition skipped — pre-filed tasks detected',
                body: `Found ${preFiled.length} pre-filed task(s) linked to this mission after the organizer's planning task started. Refused a decomposition create and switched to coordinate-only mode: the organizer should coordinate the existing tasks (${preFiledTaskIds.join(', ')}) rather than create new ones, except retry children of failed tasks.`,
                status: 'open',
              });
            }
            const error =
              `Decomposition refused: ${preFiled.length} task(s) were already filed against this mission after your planning task started (${preFiledTaskIds.join(', ')}). ` +
              'Switch to coordinate-only mode: coordinate/retry the existing tasks instead of creating new build tasks. ' +
              'A retry child is still allowed — pass parentTaskId naming the failing task explicitly.';
            const frictionSignature = fireGateEvent({
              gate: GATE_SLUGS.DECOMPOSITION_REFUSED,
              surface: 'POST /api/tasks',
              outcome: 'rejected',
              reason: error,
              workspaceId,
              missionId,
              callerOrigin: gateCaller,
              detail: { preFiledTaskIds, organizerTaskId: callingTask.id },
            });
            return NextResponse.json({ error, frictionSignature, decompositionSkipped: true, preFiledTaskIds }, { status: 409 });
          }
        }
      }
    }

    const knownSubjectOrigins = new Set<SubjectFilingOrigin>([
      'dashboard', 'api', 'mcp', 'organizer', 'watcher', 'webhook', 'friction', 'backfill',
    ]);
    const subjectOrigin: SubjectFilingOrigin = title.startsWith('[friction] ')
      ? 'friction'
      : knownSubjectOrigins.has(creationSource as SubjectFilingOrigin)
        ? creationSource as SubjectFilingOrigin
        : 'api';
    subjectOriginForError = subjectOrigin;
    const workspaceRepo = targetWorkspace.repo
      ?.replace(/^https?:\/\/github\.com\//, '')
      .replace(/\.git$/, '')
      .replace(/^\/|\/$/g, '');
    const subjectObservation = await prepareSubjectFiling({
      workspaceId,
      workspaceRepo,
      gitConfig: targetWorkspace.gitConfig,
      title,
      description,
      context: typeof incomingContext === 'object' && incomingContext !== null && !Array.isArray(incomingContext)
        ? incomingContext
        : undefined,
      subjectAnchor: rawSubjectAnchor,
      origin: subjectOrigin,
    });

    // ── Pre-dispatch dedupe ──────────────────────────────────────────────────
    //
    // prepareSubjectFiling has already resolved this filing's anchor against the
    // live tasks in this workspace and computed a verdict. Until this block the
    // route reported that verdict to telemetry and created the task anyway, so
    // an `attach` verdict still put a second agent on a fresh branch — the
    // detection worked and the prevention did not exist.
    //
    // Acting requires BOTH:
    //   - an identifying key type (see isIdentifyingSubjectKeyType — a bare
    //     mission id matches every sibling task and must never stop a filing);
    //   - an `attach` verdict, which wouldBeSubjectOutcome grants to agent
    //     origins only. A human filing is never silently swallowed; it gets the
    //     suggestion below instead.
    const fileAnywayText = typeof fileAnywayReason === 'string' ? fileAnywayReason.trim() : '';
    const attachEligible = Boolean(
      subjectObservation.match
      && subjectObservation.anchor
      && subjectObservation.match.outcome === 'attach'
      && isIdentifyingSubjectKeyType(subjectObservation.match.keyType),
    );
    const attachTarget = attachEligible && !fileAnywayText ? subjectObservation.match! : null;

    // The bypass is the measurement. A dedupe that keeps getting overridden is
    // matching things that are not the same thing, and this row is the only
    // place that shows up before someone gets annoyed enough to file friction.
    if (attachEligible && fileAnywayText) {
      fireGateEvent({
        gate: GATE_SLUGS.SUBJECT_DEDUPE,
        surface: 'POST /api/tasks',
        outcome: 'bypassed',
        reason: `subject dedupe overridden by fileAnywayReason on ${subjectObservation.match!.keyType}`,
        workspaceId,
        taskId: subjectObservation.match!.taskId,
        callerOrigin: gateCaller,
        detail: {
          keyType: subjectObservation.match!.keyType,
          origin: subjectOrigin,
          fileAnywayReason: fileAnywayText.slice(0, 500),
        },
      });
    }

    if (attachTarget) {
      await recordSubjectMatchObserved({
        workspaceId,
        origin: subjectOrigin,
        reporterId: apiAccount?.id ?? null,
        anchor: subjectObservation.anchor!,
        match: attachTarget,
        note: `subject_filing_attached:${attachTarget.keyType}`,
      });
      console.log(
        `[subject-dedupe] ${subjectOrigin} filing attached to live task ${attachTarget.taskId} on ${attachTarget.keyType}`,
      );
      fireGateEvent({
        gate: GATE_SLUGS.SUBJECT_DEDUPE,
        surface: 'POST /api/tasks',
        outcome: 'rejected',
        reason: `filing attached to a live task on ${attachTarget.keyType}`,
        workspaceId,
        taskId: attachTarget.taskId,
        callerOrigin: gateCaller,
        detail: { keyType: attachTarget.keyType, origin: subjectOrigin },
      });
      return NextResponse.json({
        id: attachTarget.taskId,
        title: attachTarget.title,
        description: attachTarget.description,
        deduplicated: true,
        duplicateOfTaskId: attachTarget.taskId,
        duplicateKeyType: attachTarget.keyType,
      }, { status: 200 });
    }

    // Not precise enough to stop the filing, but the caller should still know
    // that work is already in flight — the verdict used to be discarded.
    const duplicateSuggestion = subjectObservation.match
      ? {
          taskId: subjectObservation.match.taskId,
          title: subjectObservation.match.title,
          keyType: subjectObservation.match.keyType,
        }
      : null;

    const skillSlugs: string[] = Array.isArray(rawSkillSlugs) ? [...rawSkillSlugs] : [];

    // Resolve skill references if any slugs provided
    const resolvedSkillRefs: Array<{ skillId: string; slug: string; contentHash: string }> = [];

    if (skillSlugs.length > 0) {
      for (const slug of skillSlugs) {
        // Look up workspace-level skills (enabled only)
        const wsSkill = await db.query.workspaceSkills.findFirst({
          where: and(
            eq(workspaceSkills.workspaceId, workspaceId),
            eq(workspaceSkills.slug, slug),
            eq(workspaceSkills.enabled, true),
          ),
        });

        if (!wsSkill) {
          return NextResponse.json(
            { error: `Skill "${slug}" not registered in workspace` },
            { status: 400 }
          );
        }

        resolvedSkillRefs.push({
          skillId: wsSkill.id,
          slug: wsSkill.slug,
          contentHash: wsSkill.contentHash,
        });
      }
    }

    // Process attachments - R2 storage references only.
    // A stored key is later turned into a signed download URL for the claiming
    // worker, so each key must resolve inside this workspace's own prefix.
    const processedAttachments: Array<{ filename: string; mimeType: string; storageKey: string }> = [];
    if (attachments && Array.isArray(attachments)) {
      for (const att of attachments) {
        if (att.storageKey && att.mimeType && att.filename) {
          if (!isOwnedStorageKey(att.storageKey, workspaceId)) {
            return NextResponse.json(
              { error: 'attachment storageKey does not belong to this workspace' },
              { status: 400 }
            );
          }
          processedAttachments.push({
            filename: att.filename,
            mimeType: att.mimeType,
            storageKey: att.storageKey,
          });
        }
      }
    }

    // Validate outputSchema is a valid JSON Schema object if provided
    if (outputSchema && (typeof outputSchema !== 'object' || Array.isArray(outputSchema))) {
      return NextResponse.json({ error: 'outputSchema must be a JSON Schema object' }, { status: 400 });
    }

    // Denylist: reject content-bearing field names in sensitive-workspace schemas.
    // Sensitive workspaces (e.g. Cue email triage) use structured-only retention where
    // structuredOutput is the one field that flows through even after free-text is dropped.
    // An outputSchema with fields like `subject` or `body` would route real content through
    // that carve-out. Use pointer fields (messageId, threadId, correlationKey) instead.
    if (outputSchema && targetWorkspace.gitConfig?.dataClass === 'sensitive') {
      const violations = detectContentBearingSchemaFields(outputSchema as Record<string, unknown>);
      if (violations.length > 0) {
        return NextResponse.json(
          {
            error: `outputSchema contains content-bearing fields not permitted in sensitive workspaces: ${violations.join(', ')}. Replace with pointer fields (messageId, threadId, correlationKey, objectId).`,
          },
          { status: 400 }
        );
      }
    }

    // Resolve category: use provided value, or auto-classify
    type CategoryType = TaskCategoryValue;
    const validCategories = Object.values(TaskCategory) as string[];
    let category: CategoryType | null = null;
    if (rawCategory && validCategories.includes(rawCategory)) {
      category = rawCategory as CategoryType;
    } else if (!rawCategory) {
      category = classifyTask(title, description) as CategoryType | null;
    }
    // A caller-supplied category is the filer's own label: the decision model
    // records its look but never changes it.
    const categoryWasKeywordClassified = !rawCategory;

    // Short display label: whoever files the task may supply one; otherwise the
    // classifier derives it from the title. Pure and synchronous — never blocks
    // or fails creation.
    const label = normalizeTaskLabel(rawLabel) ?? heuristicTaskLabel(title).label;

    // Validate outputRequirement if provided
    const validOutputRequirements = ['pr_required', 'artifact_required', 'none', 'auto'];
    const explicitOutputRequirement = rawOutputRequirement && validOutputRequirements.includes(rawOutputRequirement)
      ? rawOutputRequirement as 'pr_required' | 'artifact_required' | 'none' | 'auto'
      : undefined;

    // Resolve agent backend. Precedence (most specific wins):
    //   task.backend → mission.defaultBackend → role.defaultBackend →
    //   workspace gitConfig.defaultBackend → schema default ('claude').
    let resolvedBackend: 'claude' | 'codex' | undefined =
      ['claude', 'codex'].includes(rawBackend) ? (rawBackend as 'claude' | 'codex') : undefined;
    // The caller named the backend itself (not inherited): budget failover must
    // not override it. tasks.backend alone can't say so — it defaults to 'claude'.
    const backendPinnedCtx = resolvedBackend ? { [BACKEND_PINNED_KEY]: true } : {};

    // Fields a mission task can inherit from its mission. Fetch once and reuse
    // for both outputRequirement and backend resolution.
    let outputRequirement = explicitOutputRequirement;
    let missionStartAt: Date | null = null;
    // Option A′: null unless this mission opted into an integration branch, in
    // which case it is the default PR base for the task being created.
    let missionIntegrationBaseBranch: string | null = null;
    if (missionId) {
      const mission = await db.query.missions.findFirst({
        where: eq(missions.id, missionId),
        columns: {
          defaultOutputRequirement: true,
          defaultBackend: true,
          startAt: true,
          workingBranch: true,
          integrationBranchEnabled: true,
          workspaceId: true,
        },
      });
      if (!outputRequirement) outputRequirement = mission?.defaultOutputRequirement ?? 'auto';
      // Mission backend (an intentional per-mission choice) outranks role/workspace defaults.
      if (!resolvedBackend && mission?.defaultBackend) resolvedBackend = mission.defaultBackend;
      missionStartAt = mission?.startAt ?? null;
      missionIntegrationBaseBranch = missionIntegrationBase(mission);

      // A mission with no workspace of its own cannot have its integration
      // branch cut at mission-create time (there is no repo to cut it in), so
      // the first task filed into a repo-linked workspace does it — before the
      // runner claims the task and tries to cut a worktree from a ref that
      // does not exist. Missions WITH a workspace had the branch ensured at
      // create/opt-in and by the organizer, so this costs them nothing.
      if (missionIntegrationBaseBranch && !mission?.workspaceId && workspaceId) {
        // Lazy: pulls in the GitHub client, which only this rare path needs.
        const { ensureMissionIntegrationBranch, reportMissionBranchUnresolved } =
          await import('@/lib/mission-integration-branch');
        const ensured = await ensureMissionIntegrationBranch(missionId, { workspaceId }).catch(err => ({
          ok: false as const,
          reason: 'api_error' as const,
          detail: err instanceof Error ? err.message : String(err),
        }));
        if (!ensured.ok) {
          await reportMissionBranchUnresolved({
            missionId,
            branch: missionIntegrationBaseBranch,
            where: 'task_create',
            surface: 'POST /api/tasks',
            cause: ensured.reason === 'not_opted_in' ? 'missing' : ensured.reason,
            // The task is still filed; its worktree and PR fall back to trunk.
            fallback: 'none',
            detail: ensured.detail ?? null,
            workspaceId,
          });
        }
      }
    }

    // Manifest gate: a mission task whose deliverable is EXPLICITLY declared
    // as a PR ('pr_required') must declare a concrete pathManifest.
    // shouldSerializeByManifest/computeOverlapEdges can only serialize
    // concrete manifests (see isAdvisoryManifest); an undeclared scope makes
    // a sibling task race instead of wait, which is the exact failure mode
    // #1759/#1763 hit. 'artifact_required' and 'none' mission tasks, and any
    // non-mission task, are exempt — they carry no PR-overlap risk.
    //
    // Deliberately does NOT fire on 'auto' (the default): auto has no
    // creation-time resolution — whether it ends up needing a PR is decided
    // at completion from actual worker behaviour (commit count + PR/artifact
    // presence), not at filing time. Gating on it made the manifest demand
    // fire for the common case of investigation/friction/bookkeeping-shaped
    // mission tasks that never intend to produce a PR (see the friction
    // report this comment accompanies). Callers that already know they'll
    // ship a PR should still declare outputRequirement: 'pr_required'
    // explicitly, which keeps this gate in effect for them.
    if (
      missionId &&
      outputRequirement === 'pr_required' &&
      !hasConcretePathManifest(pathManifest)
    ) {
      const error =
        'pathManifest is required for mission tasks that produce a PR — declare at least one concrete path, e.g. pathManifest: ["apps/web/src/lib/foo.ts"]. ' +
        "If this task won't produce a PR, set outputRequirement: 'none' instead.";
      const frictionSignature = fireGateEvent({
        gate: GATE_SLUGS.MANIFEST_REQUIRED,
        surface: 'POST /api/tasks',
        outcome: 'rejected',
        reason: error,
        workspaceId,
        missionId,
        callerOrigin: gateCaller,
        detail: {
          outputRequirement,
          // Distinguishes "declared nothing" from "declared the repo-wide
          // sentinel" — two different filer mistakes with the same 400.
          manifest: pathManifest ? 'wildcard' : 'absent',
        },
      });
      return NextResponse.json({ error, frictionSignature }, { status: 400 });
    }

    // Advisory kind gate: a mission task with no `kind` is unlabelled on every
    // surface for the rest of its life, and nothing infers one later from its
    // title. Deliberately NOT a 400 — see GATE_SLUGS.KIND_ABSENT. The lever that
    // actually moves the volume is `kind` being required in
    // `planningOutputSchema`, which the SDK enforces at generation time and so
    // can never reject a caller at runtime.
    if (missionId && rawKind === undefined) {
      fireGateEvent({
        gate: GATE_SLUGS.KIND_ABSENT,
        surface: 'POST /api/tasks',
        outcome: 'warned',
        reason: 'mission task created with no kind — it will render unlabelled on every surface',
        workspaceId,
        missionId,
        callerOrigin: gateCaller,
        detail: { hasRoleSlug: Boolean(roleSlug), outputRequirement },
      });
    }

    // enforceGreenCI: implicitly add a pr_checks_green loop when the workspace
    // requires it and the task targets pr_required without a caller-supplied loopConfig.
    if (
      !loopConfig &&
      targetWorkspace.gitConfig?.enforceGreenCI === true &&
      outputRequirement === 'pr_required'
    ) {
      loopConfig = parseLoopConfig({ exitCondition: { type: 'pr_checks_green' }, maxLoops: 3 }, undefined);
    }

    // Validate and resolve requiredConnectors (team-scoped role lookup).
    const requiredConnectorsCheck = await validateRequiredConnectors(rawRequiredConnectors, {
      roleSlug: typeof roleSlug === 'string' ? roleSlug : null,
      workspaceId,
      teamId: targetWorkspace.teamId ?? null,
    });
    if (!requiredConnectorsCheck.ok) {
      return NextResponse.json({ error: requiredConnectorsCheck.error }, { status: 400 });
    }
    const resolvedRequiredConnectors = requiredConnectorsCheck.value;

    // Fall back to the role's defaultBackend hint, then the workspace default.
    if (!resolvedBackend && roleSlug && typeof roleSlug === 'string') {
      const role = await db.query.workspaceSkills.findFirst({
        where: and(
          eq(workspaceSkills.workspaceId, workspaceId),
          eq(workspaceSkills.slug, roleSlug),
          eq(workspaceSkills.enabled, true),
        ),
        columns: { defaultBackend: true },
      });
      if (role?.defaultBackend) resolvedBackend = role.defaultBackend;
    }
    if (!resolvedBackend) {
      const ws = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId),
        columns: { gitConfig: true },
      });
      const wsDefault = ws?.gitConfig?.defaultBackend;
      if (wsDefault === 'claude' || wsDefault === 'codex') resolvedBackend = wsDefault;
    }

    let deferredStart;
    try {
      deferredStart = resolveDeferredStart({
        startAt: rawStartAt,
        startIn: rawStartIn,
        startAfter: rawStartAfter,
        knownBudgetResetAt: resolvedBackend === 'codex' ? null : apiAccount?.budgetResetsAt ?? null,
      });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid deferred start' }, { status: 400 });
    }
    const resolvedStartAt = laterStartAt(deferredStart.startAt, missionStartAt);

    // Routing preview + heuristic fill-in — see docs on task-routing-preview.ts.
    // Explicit kind/complexity/tier/model always win; the heuristic only fills
    // a blank, and only when a rule actually fires (an unclassified task stays
    // unclassified rather than being stamped with the router's own baseline).
    const pathManifestIsConcrete = hasConcretePathManifest(pathManifest);
    const routingInference = inferRouting({
      kind: rawKind ?? null,
      complexity: rawComplexity ?? null,
      title,
      description,
      pathManifest,
      pathManifestIsConcrete,
      emitsPlan,
    });
    const routingWasInferred = routingInference.kindInferred || routingInference.complexityInferred;
    const finalKind = rawKind !== undefined
      ? (rawKind as TaskKind)
      : routingInference.kindInferred ? routingInference.kind : undefined;
    const finalComplexity = rawComplexity !== undefined
      ? (rawComplexity as TaskComplexity)
      : routingInference.complexityInferred ? routingInference.complexity : undefined;
    const routingInferredReason = routingWasInferred
      ? [routingInference.kindReason, routingInference.complexityReason].filter(Boolean).join('; ')
      : null;
    const explicitPreviewModel = typeof incomingContext?.model === 'string' ? incomingContext.model : null;
    // The stated role's model effect, resolved like the claim route
    // (role-model-routing.ts). A lookup failure only costs the preview its
    // role line — it never blocks task creation.
    const previewRoleSlug = typeof roleSlug === 'string' && roleSlug ? roleSlug : null;
    let previewRoleModel: string | null = null;
    let roleMayBeInferred = false;
    // Same rule the insert below applies; computed here so the kind default
    // (task-role-default.ts) can tell a work row from bookkeeping.
    const isBookkeepingTitle =
      title.startsWith('[friction] ') ||
      title.startsWith('Aggregate results:') ||
      title.startsWith('Evaluate mission completion:') ||
      title.startsWith('Mission:') ||
      title.startsWith('Close mission') ||
      // Option A′: the row that owns a mission integration PR. The opener
      // sets `taskClass` directly, but a caller can create one through this
      // route, and as `work` it would become a deliverable of the very
      // mission whose completion it is waiting on.
      title.startsWith(MISSION_PR_TASK_PREFIX);
    // A task filed with no role gets its kind's default role when the
    // workspace has it (task-role-default.ts). Stamped as inferred, so the
    // decision model may still replace it and the claim keeps the task's model.
    let kindDefaultSlug: string | null = null;
    let kindDefaultCandidateCount = 0;
    if (targetWorkspace.teamId) {
      try {
        const roleRows = await db.query.workspaceSkills.findMany({
          where: and(
            eq(workspaceSkills.teamId, targetWorkspace.teamId),
            eq(workspaceSkills.isRole, true),
            eq(workspaceSkills.enabled, true),
            or(isNull(workspaceSkills.workspaceId), eq(workspaceSkills.workspaceId, workspaceId)),
            ...(previewRoleSlug ? [eq(workspaceSkills.slug, previewRoleSlug)] : []),
          ),
          columns: {
            slug: true, name: true, model: true, workspaceId: true, teamId: true, metadata: true,
            enabled: true, isRole: true, allowedTools: true, connectorRefs: true, defaultBackend: true,
          },
        });
        if (previewRoleSlug) {
          const row = pickRoleRowForTask(roleRows, {
            roleSlug: previewRoleSlug, workspaceId, teamId: targetWorkspace.teamId,
          });
          previewRoleModel = row ? (row.model ?? 'inherit') : null;
        } else {
          roleMayBeInferred = countRoleInferenceCandidates(roleRows, workspaceId) >= 2;
          const kindCandidates = kindDefaultCandidates(roleRows, {
            workspaceId,
            backend: resolvedBackend ?? null,
            outputRequirement: outputRequirement ?? null,
            pathManifestIsConcrete,
            emitsPlan: !!emitsPlan,
          });
          kindDefaultCandidateCount = kindCandidates.length;
          kindDefaultSlug = kindDefaultRole({
            statedRoleSlug: null,
            kind: finalKind ?? null,
            taskClass: isBookkeepingTitle ? 'bookkeeping' : 'work',
            candidates: kindCandidates,
          });
        }
      } catch (err) {
        console.warn('[tasks] role lookup for routing preview failed:', err);
      }
    }
    const routingPreview = computeRoutingPreview({
      roleSlug: previewRoleSlug,
      roleModel: previewRoleModel,
      roleMayBeInferred,
      kind: rawKind ?? null,
      complexity: rawComplexity ?? null,
      tier: TIERS.includes(rawTier as Tier) ? (rawTier as Tier) : null,
      model: explicitPreviewModel,
      title,
      description,
      pathManifest,
      pathManifestIsConcrete,
      emitsPlan,
    });

    const createTaskRow = async (subjectOverrides: {
      id: string;
      subjectDedupeScope: 'active' | 'none';
      subjectResolution?: 'filed_anyway';
    }) => {
      let created: typeof tasks.$inferSelect | undefined;
      try {
        const insert = db
          .insert(tasks)
          .values({
        id: subjectOverrides.id,
        workspaceId,
        title,
        label,
        description: description || null,
        priority: priority || 0,
        status: 'pending',
        mode: emitsPlan ? 'planning' : 'execution',
        taskClass: isBookkeepingTitle ? 'bookkeeping' : 'work',
        runnerPreference: runnerPreference || 'any',
        requiredCapabilities: requiredCapabilities || [],
        context: {
          // Option A′ default base, first so an explicit caller-supplied
          // `baseBranch` in the incoming context still wins: a caller naming a
          // predecessor branch is stacking deliberately, and A′ only fills in
          // the base for tasks that named none.
          ...(missionIntegrationBaseBranch ? { baseBranch: missionIntegrationBaseBranch } : {}),
          // Merge incoming context (MCP sends baseBranch, iteration, failureContext, model, effort, etc.)
          ...(typeof incomingContext === 'object' && incomingContext !== null && !Array.isArray(incomingContext) ? incomingContext : {}),
          // Route-computed fields take precedence
          ...(processedAttachments.length > 0 ? { attachments: processedAttachments } : {}),
          ...(skillSlugs.length > 0 ? { skillSlugs } : {}),
          ...(resolvedSkillRefs.length > 0 ? { skillRefs: resolvedSkillRefs } : {}),
          // Last so it wins over any caller-supplied context.requiresPlanApproval —
          // a spec task's plan is always gated; nobody authorizes their own breakdown.
          ...(emitsPlan ? { requiresPlanApproval: true } : {}),
          // Marks a kind/complexity that the heuristic filled in, not the caller —
          // see task-routing-preview.ts. Lets analytics and the model cell tell
          // "the filer said this" apart from "we guessed this".
          ...(routingWasInferred ? { routingInferred: true, routingInferredReason } : {}),
          ...(kindDefaultSlug ? { roleInferred: kindDefaultStamp(kindDefaultSlug, kindDefaultCandidateCount) } : {}),
          ...backendPinnedCtx,
        },
        ...(project ? { project } : {}),
        ...(category ? { category } : {}),
        ...(outputRequirement ? { outputRequirement } : {}),
        ...(outputSchema ? { outputSchema } : {}),
        ...(missionId ? { missionId } : {}),
        ...(resolvedDependsOn.length > 0 ? { dependsOn: resolvedDependsOn } : {}),
        ...(roleSlug && typeof roleSlug === 'string' ? { roleSlug } : kindDefaultSlug ? { roleSlug: kindDefaultSlug } : {}),
        ...(resolvedRequiredConnectors !== null ? { requiredConnectors: resolvedRequiredConnectors } : {}),
        ...(pathManifest ? {
          pathManifest,
          // The declaration as filed. pathManifest is the effective scope and
          // may later shrink (narrowPathClaims); this snapshot does not.
          pathDeclaration: {
            declared: pathManifest,
            source: 'creation' as const,
            snapshotAt: new Date().toISOString(),
            ...(inferredDependsOn.length > 0 ? { inferredDependsOn } : {}),
            overlapPolicy: 'v2' as const,
            ...(softOverlaps.length > 0 ? { softOverlaps } : {}),
          },
        } : {}),
        ...(TIERS.includes(rawTier as Tier) ? { tier: rawTier as Tier } : {}),
        ...(finalKind !== undefined ? { kind: finalKind } : {}),
        ...(finalComplexity !== undefined ? { complexity: finalComplexity } : {}),
        // Caller-supplied routing inputs are attributed to the user so routing
        // analytics can tell them apart from cadence/heuristic-derived values.
        ...(rawKind !== undefined || rawComplexity !== undefined
          ? { classifiedBy: 'user' as const }
          : routingWasInferred ? { classifiedBy: 'classifier' as const } : {}),
        ...(['true', 'false', 'inherit'].includes(rawRelease) ? { release: rawRelease as 'true' | 'false' | 'inherit' } : {}),
        ...(resolvedBackend ? { backend: resolvedBackend } : {}),
        ...(rawRequiresReview === true ? { requiresReview: true } : {}),
        ...(resolvedStartAt ? { startAt: resolvedStartAt } : {}),
        ...(loopConfig ? { loopConfig } : {}),
        ...subjectObservation.taskValues,
        ...(subjectObservation.anchor ? {
          subjectDedupeScope: subjectOverrides.subjectDedupeScope,
          ...(subjectOverrides.subjectResolution
            ? { subjectResolution: subjectOverrides.subjectResolution }
            : {}),
        } : {}),
        // Creator tracking (from service)
        ...creatorContext,
        ...(deferredStart.resolution ? {
          context: {
            ...(typeof incomingContext === 'object' && incomingContext !== null && !Array.isArray(incomingContext) ? incomingContext : {}),
            ...(processedAttachments.length > 0 ? { attachments: processedAttachments } : {}),
            ...(skillSlugs.length > 0 ? { skillSlugs } : {}),
            ...(resolvedSkillRefs.length > 0 ? { skillRefs: resolvedSkillRefs } : {}),
            ...(emitsPlan ? { requiresPlanApproval: true } : {}),
            ...(routingWasInferred ? { routingInferred: true, routingInferredReason } : {}),
            ...backendPinnedCtx,
            startResolution: deferredStart.resolution,
          },
        } : {}),
          })
          .returning();
        // A task created for one local runner carries that target from birth,
        // in the insert's own transaction: otherwise a drain running in another
        // request could broadcast the bare creation wake to every runner first.
        [created] = assignToLocalUiUrl
          ? await withDispatchHint({ metadata: { targetLocalUiUrl: assignToLocalUiUrl } }, insert)
          : await insert;
      } catch (error) {
        // The partial unique index tasks_active_planning_per_mission (one
        // active mode:'planning' task per mission) only ever collides on
        // the emitsPlan path — this is the only place this route sets
        // mode: 'planning'. Un-caught, the raw Postgres 23505 propagated
        // as an opaque "Failed query: insert into tasks..." 500,
        // indistinguishable from a genuine server error. Surface it as
        // the actionable conflict it actually is instead.
        const cause = (error as { cause?: { code?: string; constraint?: string } })?.cause;
        if (cause?.code === '23505' && cause?.constraint === 'tasks_active_planning_per_mission') {
          throw new Error('active_planning_task_conflict');
        }
        throw error;
      }
      if (!created) throw new Error('task_insert_failed');
      // Manifest provenance denominator (conflict-aware-orchestration.md §3):
      // one row per created task, including the ones filed with no manifest.
      recordPathDeclaration({
        result: 'succeeded',
        provenance: 'creation',
        surface: 'POST /api/tasks',
        workspaceId,
        missionId: missionId ?? null,
        taskId: created.id,
        callerOrigin: gateCaller,
        pathCount: pathManifest?.length ?? 0,
        detail: { shape: manifestShape(pathManifest), anchorInjected: anchorInjectedCount, inferredDependsOn: inferredDependsOn.length },
      });
      return created;
    };

    const intake = await intakeSubject({
      workspaceId,
      policy: subjectPolicy,
      anchor: subjectObservation.anchor,
      origin: subjectOrigin,
      reporterId: creatorContext.createdByAccountId,
      parentTaskId: creatorContext.parentTaskId,
      fileAnywayReason,
      normalizedIntentId: typeof incomingContext?.normalizedIntentId === 'string'
        ? incomingContext.normalizedIntentId
        : null,
      note: description || title,
      repository: createSubjectIntakeRepository(createTaskRow),
    });
    const task = intake.task;

    if (
      subjectPolicy.mode === 'observe'
      && subjectObservation.anchor
      && subjectObservation.match
    ) {
      await recordSubjectMatchObserved({
        workspaceId,
        origin: subjectOrigin,
        reportingTaskId: task.id,
        reporterId: creatorContext.createdByAccountId,
        anchor: subjectObservation.anchor,
        match: subjectObservation.match,
      });
    }

    // The enforcing-policy counterpart to the observe-mode bypass above:
    // intakeSubject found a canonical task and the filer overrode it anyway.
    if (intake.outcome.action === 'filed_anyway') {
      fireGateEvent({
        gate: GATE_SLUGS.SUBJECT_DEDUPE,
        surface: 'POST /api/tasks',
        outcome: 'bypassed',
        reason: 'subject intake overridden by fileAnywayReason',
        workspaceId,
        taskId: task.id,
        callerOrigin: gateCaller,
        detail: {
          origin: subjectOrigin,
          relatedTaskId: intake.outcome.relatedTaskId,
          fileAnywayReason: String(intake.outcome.reason ?? '').slice(0, 500),
        },
      });
    }

    if (intake.outcome.action !== 'attached') {
      await announceTaskCreated(task, targetWorkspace);
      await wakeTask(task.id, 'task.created', { targetLocalUiUrl: assignToLocalUiUrl });
    }

    // Who reacts to a committed filing is the modules' business (the
    // composition root, apps/web/src/modules.ts): the decision model's category
    // look, and for a mission task the feed post, reopen and escalation resolve.
    // Every subscriber is fire-and-forget past its first await and isolated, so
    // none can delay or fail creation.
    await emit({
      type: 'task.created',
      taskId: task.id,
      workspaceId,
      teamId: targetWorkspace.teamId,
      missionId: task.missionId ?? null,
      title: task.title,
      description: description ?? null,
      attached: intake.outcome.action === 'attached',
      category: { stored: category, callerSet: !categoryWasKeywordClassified },
      dataClass: targetWorkspace.gitConfig?.dataClass ?? null,
      creator: {
        accountId: creatorContext.createdByAccountId ?? null,
        user: user ?? null,
        apiAccount: apiAccount ?? null,
        workerId: createdByWorkerId ?? null,
      },
    });

    // Role routing (lib/task-role-decision.ts + lib/task-role-apply.ts,
    // role-routing.md §6(a)/(c)): which role the decision model would give this
    // task, logged; and, for a role-less task on a team that opted into
    // task_role_apply, written when confident and still unclaimed. After the
    // response, so it never delays or fails creation. Pipeline/bookkeeping rows
    // get their role from their parent, so only `work` rows are looked at.
    if (intake.outcome.action !== 'attached' && task.taskClass === 'work' && targetWorkspace.teamId) {
      try {
        scheduleTaskRoleRouting({
          taskId: task.id,
          teamId: targetWorkspace.teamId,
          workspaceId,
          accountId: creatorContext.createdByAccountId ?? null,
          // The caller's role only: a kind default is not stated, so the
          // decision model still runs and may replace it.
          statedRoleSlug: typeof roleSlug === 'string' && roleSlug ? roleSlug : null,
          title: task.title,
          label: task.label ?? null,
          kind: rawKind ?? null,
          kindHeuristic: routingInference.kindInferred ? routingInference.kind : null,
          description: task.description ?? null,
          pathManifest: task.pathManifest ?? null,
          pathManifestIsConcrete,
          creationSource: task.creationSource ?? null,
          inMission: !!task.missionId,
          outputRequirement: task.outputRequirement ?? null,
          backend: task.backend ?? null,
          emitsPlan: !!emitsPlan,
          dataClass: targetWorkspace.gitConfig?.dataClass ?? null,
        }, after);
      } catch (err) {
        console.error('[task-create] role shadow scheduling failed (non-fatal):', err);
      }
    }

    // The creation-manifest shadow (lib/task-manifest-prediction.ts, design
    // §5a): which files the decision model would declare for a missing-scope
    // task. Opt-in per team, after the response, record only — the manifest,
    // dependsOn and every rejection above are already final. The hook decides
    // eligibility: explicit (or deterministically inferred) concrete manifests
    // win, and only work rows of a file-shaped kind are predicted.
    if (intake.outcome.action !== 'attached') {
      try {
        scheduleCreationManifestShadow(task, {
          teamId: targetWorkspace.teamId,
          accountId: creatorContext.createdByAccountId ?? null,
        }, after);
      } catch (err) {
        console.error('[task-create] manifest shadow scheduling failed (non-fatal):', err);
      }
    }

    // UI missions auto-append a per-mission surface-audit task: when this
    // task's own pathManifest touches a UI surface directory, ensure the
    // mission has a `[surface audit]` task gated on all its builder tasks
    // (idempotent — extends dependsOn instead of duplicating). Never fails
    // task creation, which has already committed by this point.
    //
    // Skipped on an 'attached' intake outcome — there `task` is the
    // pre-existing canonical row (see intakeSubject), not a new filing, so
    // there is nothing new for the mission's audit to depend on.
    if (task.missionId && intake.outcome.action !== 'attached') {
      try {
        await ensureMissionSurfaceAudit({
          missionId: task.missionId,
          workspaceId,
          createdTask: {
            id: task.id,
            title: task.title,
            taskClass: task.taskClass,
            pathManifest: (task.pathManifest as string[] | null) ?? null,
          },
          targetWorkspace,
        });
      } catch (err) {
        console.error('[task-create] surface audit ensure failed:', err);
      }
    }

    // Intake check (§10) — warn, never block. A retrieval failure here must
    // never fail task creation, which has already committed by this point.
    let specWarnings: Awaited<ReturnType<typeof findIntakeWarnings>> = [];
    try {
      specWarnings = await findIntakeWarnings({ workspaceId, description, pathManifest });
    } catch (err) {
      console.error('[task-create] spec discrepancy intake check failed:', err);
    }

    // Recorded HERE, not where the lint runs: `detectProseGate` fires above the
    // workspace lookup, and an unattributable row is invisible to every scoped
    // aggregation — which is precisely how this lint stayed a mystery for three
    // weeks. The lint's own behaviour is untouched; only the bookkeeping moved.
    if (proseGateWarning) {
      fireGateEvent({
        gate: GATE_SLUGS.PROSE_GATE,
        surface: 'POST /api/tasks',
        outcome: 'warned',
        reason: `description declares a dependency gate ("${proseGateWarning.phrase}") with no dependsOn edges`,
        workspaceId,
        missionId: task.missionId,
        taskId: task.id,
        callerOrigin: gateCaller,
        detail: { phrase: proseGateWarning.phrase, taskIdsFound: proseGateWarning.taskIds.length },
      });
    }

    return NextResponse.json({
      ...task,
      subjectIntakeOutcome: intake.outcome,
      // Echoes what the claim-time router would do RIGHT NOW (budget pressure
      // and spike detection ignored — neither is known yet at creation time,
      // and both only ever downshift). See task-routing-preview.ts.
      routing: {
        tier: routingPreview.tier,
        model: routingPreview.model,
        reason: routingPreview.reason,
      },
      ...(proseGateWarning ? {
        proseGateWarning: {
          message: `Description mentions a gate ("${proseGateWarning.phrase}") near ${proseGateWarning.taskIds.length > 0 ? `task IDs: ${proseGateWarning.taskIds.join(', ')}` : 'potential dependencies'}; no dependsOn edges set. If this is a real dependency, add dependsOn.`,
          phrase: proseGateWarning.phrase,
          taskIds: proseGateWarning.taskIds,
        },
      } : {}),
      ...(duplicateSuggestion ? { duplicateSuggestion } : {}),
      ...(specWarnings.length > 0 ? { specWarnings } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'file_anyway_reason_required') {
      const message = 'fileAnywayReason must be nonblank';
      const frictionSignature = fireGateEvent({
        gate: GATE_SLUGS.FILE_ANYWAY,
        surface: 'POST /api/tasks',
        outcome: 'rejected',
        reason: message,
        workspaceId: gateWorkspaceId,
        callerOrigin: gateCaller,
        detail: { origin: subjectOriginForError ?? null },
      });
      return NextResponse.json({ error: message, frictionSignature }, { status: 400 });
    }
    if (error instanceof Error && error.message === 'file_anyway_not_allowed') {
      const message = `fileAnywayReason is not allowed for origin "${subjectOriginForError}" filings (only dashboard, api, mcp, and friction filings may bypass).`;
      const frictionSignature = fireGateEvent({
        gate: GATE_SLUGS.FILE_ANYWAY,
        surface: 'POST /api/tasks',
        outcome: 'rejected',
        reason: message,
        workspaceId: gateWorkspaceId,
        callerOrigin: gateCaller,
        detail: { origin: subjectOriginForError ?? null },
      });
      return NextResponse.json({ error: message, frictionSignature }, { status: 400 });
    }
    if (error instanceof Error && error.message === 'active_planning_task_conflict') {
      const message = 'This mission already has an active planning task in progress — wait for it to complete, or approve/reject it, before creating another.';
      return NextResponse.json({ error: message }, { status: 409 });
    }
    console.error('Create task error:', error);
    return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
  }
}

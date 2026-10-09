import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { tokenWorkspaceAllowed } from '@buildd/core/token-scopes';
import { NextRequest, NextResponse, after } from 'next/server';
import { withoutDispatchToken } from '@/lib/workspace-dispatch-token';
import { db } from '@buildd/core/db';
import { accounts, accountWorkspaces, tasks, workers, workspaces, workspaceSkills, secrets, tenantBudgets, oauthBudgetEpisodes, teams, connectors, connectorShares, connectorWorkspaces, missions, workerErrorTraces } from '@buildd/core/db/schema';
import { eq, and, or, not, isNull, isNotNull, sql, inArray, lt, lte, gte } from 'drizzle-orm';
import type { ClaimTasksInput, ClaimTasksResponse, ClaimDiagnostics, ClaimTaskExclusion } from '@buildd/shared';
import { CLOUD_EXECUTOR, ENTITLEMENT_BLOCK_CONTEXT_KEY, entitlementDeferralKey, isRunnerExecutor, stripClaimCredentials } from '@buildd/shared';
import { checkManagedRunnerEntitlement, stampEntitlementBlock } from '@/lib/entitlements/managed-runner';
import { checkHostedRunnerAllowance } from '@/lib/hosted-runner-usage-store';
import { authenticateTaskScopedCaller } from '@/lib/task-token-auth';
import { INTERACTIVE_SESSION_HEADER, resolveClaimRunner, verifyInteractiveSession } from '@/lib/interactive-session';
import { INTERACTIVE_CLAIM_SESSION_KEY, INTERACTIVE_CLAIM_USER_KEY } from '@/lib/interactive-worker-liveness';
import { getAccountWorkspacePermissions } from '@/lib/account-workspace-cache';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { isStorageConfigured, generateDownloadUrl } from '@/lib/storage';
import { cleanupStaleWorkers } from '@/lib/stale-workers';
import { LIVE_WORKER_STATUSES, isGateSatisfied } from '@/lib/task-presentation';
import { getSecretsProvider } from '@buildd/core/secrets';
import { jsonResponse } from '@/lib/api-response';
import { notifyTeam } from '@/lib/notify';
import { hasCodexCredential } from '@/lib/codex-credential';
import { hasOpenAiApiKey } from '@/lib/openai-credential';
import { hasOpenAiCompatibleAgentEndpoint } from '@buildd/core/agent-endpoint';
import { resolveEffectiveModel } from '@buildd/core/model-router';
import { pickRoleRowForTask, resolveClaimModelInputs, type RoleModelRow } from '@buildd/core/role-model-routing';
import {
  describeOauthPressure,
  learnOauthCapacity,
  oauthBudgetPressure,
  oauthParallelismCap,
  readPacingConfig,
  windowEndsAt,
  type OauthBudgetPressure,
} from '@buildd/core/oauth-budget';
import { countLiveSeatWorkers, loadOauthEpisodes, measureOauthWindow, resolveSeatIdPeers } from '@/lib/oauth-budget-window';
import { resolveTierEntry, mapRouterAlias, type Tier as RegistryTier } from '@buildd/core/model-tier-registry';
import { readModelPin, shorthandPinTier } from '@buildd/core/model-pin';
import type { TierPolicyMeta } from '@buildd/core/model-policy';
import { checkModelClientCapability } from '@buildd/core/model-capability-requirements';
import { getCachedOpenRouterCatalog } from '@buildd/core/model-catalog-cache';
import { getModelCertifications } from '@buildd/core/model-certification-store';
import {
  checkDispatchModel, guardDispatchModel, describeDispatchModelRejection, tierForModelId,
  DISPATCH_MODEL_REJECTED_PATTERN,
  type DispatchModelRejection, type DispatchModelSource,
} from '@buildd/core/dispatch-model-guard';
import { drawModelRoutingArm, applyModelRoutingTreatment, recordModelRoutingAssignment } from '@buildd/core/model-routing-experiment-source';
import { drawAgentPoolArm, applyAgentPoolArm, recordAgentPoolAssignment, type AgentPoolDraw } from '@buildd/core/tier-pool-source';
import { BACKEND_ROUTING_KEY, claimedBackendOf, isBackendPinned, maskBackend, type AgentBackend, type ClaimBackendRouting, type ClaimRoutingReason } from '@buildd/core/backend-policy';
import { generateTaskBranchName } from '@buildd/core/branch-names';
import { getActiveBackendPauses, type ActivePause } from '@/lib/backend-failover';
import { findBlockingPr, pathsOverlap, declaresNoScope, intersectPaths, REPO_WIDE_SENTINEL } from '@buildd/core/path-overlap';
import { resolveCompletedTask } from '@/lib/task-dependencies';
import {
  BYPASS_MISSION_BUDGET_KEY,
  CAP_EXEMPT_KEY,
  hasBypassFlag,
} from '@/lib/bypass-flags';
import { getActiveClaimsByWorkspace, registerClaimDeferralWaiters, type ClaimDeferralWaiter } from '@buildd/core/path-claim';
import { withDispatchHint } from '@buildd/core/dispatch-outbox';
import { kickDispatch } from '@/lib/dispatch-authority';
import { isExpiredParkedHolder } from '@buildd/core/path-claim-ttl';
import { depsGate } from './deps-gate';
import { allowExplicitClaim, EXPLICIT_CLAIM_WINDOW_SEC } from './explicit-claim-rate-limit';
import { FORCE_CLAIM_CONTEXT_KEY, withoutForceClaim } from '@/lib/force-claim';
import { describeExplicitDeferral } from './explicit-deferral';
import { checkMissionPacingGate, checkMissionConcurrencyGate } from './pacing-gate';
import { missionNotHeld, missionNotLocal, taskNotHeld, checkTaskMissionLocal } from './held-gate';
import { diagnoseExplicitTaskExclusion, evaluateForcedGates, explicitExclusionGateEvent, stampLastClaimAttempt, type ExplicitTaskGates } from './explicit-task-exclusion';
import { roleSlugGate } from './role-gate';
// The workspace concurrency cap as a claim predicate (see the call site for the
// rules). A function so a force claim can evaluate it for the audit without
// applying it.
import { workspaceCapGate } from './workspace-cap-gate';
import { workspaceExecutorGate } from './workspace-executor-gate';
import { subjectLivenessCondition, subjectStillLive } from './subject-gate';
import { guardClaimedRetry } from '@/lib/supersession';
import { cancelSkippedTask, claimFix as claimKernelFix, isRepairRole } from '@/lib/workflow/seam';
import { notifyConnectorBlocked } from './connector-block-notify';
import { effectiveBudgetResetAt, isBudgetExhausted } from '@/lib/budget-errors';
import { attachMcpConnectors } from './mcp-connector-injection';
import { runConnectorPreFilter } from './connector-prefilter';
import { attachRoleConfig, attachSkillBundles } from './skill-and-role-injection';
import { attachQuestionGate } from './question-gate';
import { attachRoleEnvSecrets, runRoleEnvPreFilter } from './role-env-injection';
import { attachWorkspaceWorkContext } from './workspace-work-context';
import {
  attachExternalContextProviders,
  attachTaskAreaScope,
} from './context-injection';
import { runDependentContextInjections } from './prompt-context-pipeline';
import { dependentCountQuery } from '@/lib/dependent-count-query';
import {
  attachClaudeCredentials,
  attachCodexCredentials,
  attachPendingCredentialRefreshes,
  attachServerManagedSecrets,
  resolveAccountCredentialRefreshes,
} from './credential-injection';
import { attachAgentEndpoints, attachCloudToolSearchHint, runnerSupportsAgentEndpoint } from './agent-endpoint-injection';
import { resolveClaudeModelRoute, routeUsesOauthSeat, type ClaudeModelRoute } from './claude-model-route';
import { attachGitHubCredentialModes } from './github-credential-injection';
import { AGENT_GITHUB_TOKEN_ROLLOUT_ENV, parseAgentGitHubRollout } from '@buildd/core/agent-github-credentials';
import { fireDeferralEvent, fireGateEvent, fireRepeatGateEvent, GATE_SLUGS, gateCallerOrigin } from '@/lib/gate-ledger';
import { announceFixClaimed, announceReviewClaimed } from '@/lib/pr-activity-fix-claimed';
import { isDispatchedReview } from '@/lib/read-only-review';
import { planClaimBatch, type ClaimPlan, type PlannerThresholds } from '@buildd/core/claim-planner';
import {
  buildClaimPlanInput,
  EMPTY_PLANNER_SIGNALS,
  plannerScopedTaskIds,
  resolveClaimPlannerConfig,
  splitOwnOpenPrs,
  type ClaimPlannerMode,
  type MissionInFlightRow,
  type PlannerSignals,
} from './claim-plan-input';
import { candidateLandingBase, partitionOpenPrsByLandingBase, workspaceTrunk } from './open-pr-target-base';
import { effectiveBackendOf, fireClaimPlanRecord, fireOrderedBehind, loadPlannerSignals } from './claim-plan-store';
import {
  ClaimHoldCollector,
  acquireGatedStartPaths,
  gatedStartApplies,
  gatedStartReachable,
  isLiveHolderStatus,
  openPrStartVerdict,
  releaseGatedStartPaths,
  scheduleClaimHoldShadow,
  softOverlapStartVerdict,
  touchesHardOverlapSurface,
  type ClaimHoldTaskContext,
  type ClaimRiskEvidence,
} from './hold-start-shadow';
import { evaluateSoftOverlaps, softOverlapHolderIds, type SoftHolderRow } from './soft-overlap-gate';
import { loadSoftOverlapHolders } from './soft-overlap-store';
import { defaultPrDiffScopeDeps, prefetchPrDiffScopes } from '@/lib/claim-pr-diff-scope';
import { loadPairProbeEvidence } from '@/lib/sibling-pair-probe';

// Per-runner claim cooldown after a worker error. Matches the typical
// client-side breaker minimum (5m for generic errors, 60s default here since
// the dominant burn-loop cause is fast-fail budget/auth errors that bounce in
// <1s). Scoped per-runner so healthy runners keep picking up tasks.
const CLAIM_COOLDOWN_MS = 60_000;

// Candidate pages fetched past role-env-gapped tasks before the window is cut
// anyway (at most 4 × candidateLimit rows). See the candidate fetch.
const ROLE_ENV_WINDOW_MAX_PAGES = 4;


/**
 * True when the task's declared deliverable is not a code change
 * ('artifact_required' / 'none'), so it cannot conflict with another task's
 * files. Same exemption the task-create manifest gate grants these tasks.
 * 'auto' and 'pr_required' still count as file-editing.
 */
function producesNoFileEdits(outputRequirement: unknown): boolean {
  return outputRequirement === 'artifact_required' || outputRequirement === 'none';
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  // A per-task token (cloud container) may claim only its own task.
  const account = await authenticateTaskScopedCaller(apiKey, req);
  // Incident-responder health probes hit this route once a minute with an empty
  // body and mark themselves with `X-Probe: true`. They still get the normal
  // 4xx below, but must not land in the gate ledger — every probe otherwise
  // records a rejection and skews bypass/false-positive analytics.
  const isProbe = req.headers.get('x-probe') === 'true';
  if (!account) {
    // Mirrors the runner's local `claim_rejected` log (apps/runner/src/workers.ts)
    // server-side — see #1511. This is the one gate in this route the runner
    // itself already detects (a thrown non-2xx `API error:` in buildd.ts); every
    // other row this route fires below is a per-task deferral the runner never
    // sees at all.
    if (!isProbe) fireGateEvent({
      gate: GATE_SLUGS.CLAIM_LOOP_DEFERRAL,
      surface: 'POST /api/workers/claim',
      outcome: 'rejected',
      reason: 'invalid_api_key',
      callerOrigin: 'worker',
    });
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  // Trigger-level tokens cannot claim tasks
  if (account.level === 'trigger') {
    if (!isProbe) fireGateEvent({
      gate: GATE_SLUGS.CLAIM_LOOP_DEFERRAL,
      surface: 'POST /api/workers/claim',
      outcome: 'rejected',
      reason: 'trigger_token_cannot_claim',
      callerOrigin: gateCallerOrigin({ apiAccount: account }),
    });
    return NextResponse.json({ error: 'Trigger tokens cannot claim tasks. Use a worker or admin token.' }, { status: 403 });
  }

  const body: ClaimTasksInput = await req.json();
  let { workspaceId, capabilities = [], maxTasks = 3, runner, taskId, availableSkills = [], claimAcrossAccessible = false } = body;

  // A per-task token claims its own task and nothing else.
  if (account.taskScope) {
    if (taskId && taskId !== account.taskScope.taskId) {
      return NextResponse.json({ error: 'This token can only claim its own task.' }, { status: 403 });
    }
    taskId = account.taskScope.taskId;
    maxTasks = 1;
    claimAcrossAccessible = false;
  }

  // Cloud executor (packages/shared/src/executor.ts): a runner inside a cloud
  // container declares `executor: 'cloud'` and gets NO credential material in
  // this response. Explicit, never inferred: an unrecognised value is refused
  // here instead of being treated as a host runner and handed credentials.
  if (body.executor !== undefined && !isRunnerExecutor(body.executor)) {
    return NextResponse.json({ error: "executor must be 'host' or 'cloud'" }, { status: 400 });
  }
  // A per-task token is only ever minted for a cloud container, so its claim
  // gets the cloud treatment whatever the body declares.
  const cloudExecutor = body.executor === CLOUD_EXECUTOR || !!account.taskScope;

  // A person's interactive MCP session, proven by the marker the MCP routes
  // sign server-side (lib/interactive-session.ts). `runner: 'mcp'` alone is
  // client-supplied and proves nothing, so without the marker it is recorded
  // as a runner id and gets every runner rule (cooldown, reaper liveness).
  const interactiveSession = verifyInteractiveSession(req.headers.get(INTERACTIVE_SESSION_HEADER), account.id);

  // Admin force-claim of ONE named task: the MCP equivalent of the dashboard's
  // "Start with override" (friction cad81659). Only for an admin token, only
  // with a taskId, and only on a task in the admin's OWN team's workspace (a
  // canClaim link into another team grants claiming, not overriding that
  // team's gates); any other combination is an ordinary claim. It lifts the
  // gates a person may override (deps, held mission, dead subject, startAt,
  // mission concurrency/pacing, path overlap, workspace cap) and never the ones
  // that protect correctness, cost or capacity (live worker, a person's hold on
  // the task, the mission budget, scope-undeclared serialization, role/runner
  // routing, provider walls, account limits). Granted below, once the task's
  // team is known.
  const forceRequested = body.forceOverride === true && !!taskId && hasTokenRouteAdminAccess(account, req, 'admin');
  let forceClaim = false;
  // Gates a force claim actually lifted for its task, i.e. the ones that would
  // have excluded or deferred it. SQL-level ones are evaluated after the
  // candidate query (the claim query no longer applies them); in-loop ones are
  // appended as the loop passes them. Audited on the task and the gate ledger.
  const forceBypassed: string[] = [];

  // A client that omits `runner` usually does so on every poll, so this is
  // collapsed to one row per account per hour (detail.count climbs), and the
  // row carries what identifies the client: the account, its user-agent and
  // the body fields it did send.
  if (!runner) {
    if (!isProbe) fireRepeatGateEvent({
      gate: GATE_SLUGS.CLAIM_LOOP_DEFERRAL,
      surface: 'POST /api/workers/claim',
      outcome: 'rejected',
      reason: 'runner_field_missing',
      taskId: taskId ?? null,
      callerOrigin: gateCallerOrigin({ apiAccount: account }),
      detail: {
        accountId: account.id,
        userAgent: (req.headers.get('user-agent') ?? '').slice(0, 200) || null,
        bodyKeys: Object.keys(body ?? {}).sort(),
      },
    }, { key: { accountId: account.id }, windowMs: 60 * 60 * 1000 });
    return NextResponse.json({ error: 'runner is required' }, { status: 400 });
  }
  runner = resolveClaimRunner(runner, interactiveSession);

  // Workspaces this account can claim from. Memoized: the claim query needs it,
  // and so does the lastClaimAttempt stamp on an explicit claim, which can fire
  // from the no_slots exit before the query is built.
  let claimableWorkspaceIdsMemo: Promise<string[]> | null = null;
  const resolveClaimableWorkspaceIds = (): Promise<string[]> => {
    claimableWorkspaceIdsMemo ??= (async () => {
      // Get workspaces this account can claim from
      // 1. Open workspaces of the account's own team ("open" = open within the team)
      // 2. Any workspace where the account has an explicit canClaim link
      const openWorkspaces = await db.query.workspaces.findMany({
        where: and(
          eq(workspaces.accessMode, 'open'),
          eq(workspaces.teamId, account.teamId),
          workspaceId ? eq(workspaces.id, workspaceId) : undefined
        ),
      });

      // Get cached account→workspace permissions (avoids DB hit on every claim)
      const allPermissions = await getAccountWorkspacePermissions(account.id);
      const claimablePermissions = allPermissions
        .filter((p) => p.canClaim)
        .filter((p) => !workspaceId || p.workspaceId === workspaceId);

      // Resolve which linked workspaces still exist. An explicit canClaim link
      // grants access whatever the workspace's accessMode — it is how an account
      // outside the owning team is given access to an open workspace.
      const restrictedWsIds = claimablePermissions.map((p) => p.workspaceId);
      let restrictedIds: string[] = [];
      if (restrictedWsIds.length > 0) {
        const restrictedWorkspaces = await db.query.workspaces.findMany({
          where: inArray(workspaces.id, restrictedWsIds),
          columns: { id: true },
        });
        restrictedIds = restrictedWorkspaces.map((ws) => ws.id);
      }

      // Combine: open workspace IDs + restricted workspaces with permission
      const openIds = openWorkspaces.map((ws) => ws.id);

      // A workspace-restricted token claims only inside its own list, whatever
      // the team's open workspaces or canClaim links would otherwise allow.
      // Every candidate and taskId lookup below is bounded by this list.
      return [...new Set([...openIds, ...restrictedIds])]
        .filter((id) => tokenWorkspaceAllowed(account.workspaceIds, id));
    })();
    return claimableWorkspaceIdsMemo;
  };

  /**
   * Every zero-worker 200 goes through here.
   *
   * The claim call is the runner's heartbeat — it polls on a loop whether or not
   * work exists — so each of these polls is also the only chance an idle runner
   * gets to discover the credentials its broker is responsible for. Attaching
   * `pendingCredentialRefreshes` per claimed worker alone meant an online-but-idle
   * runner was told about nothing and refreshed nothing. Scope is the account's
   * own team; the payload is metadata, never token material. See
   * ./credential-injection → resolveAccountCredentialRefreshes.
   *
   * Non-200 exits (401/403/400/429/422) deliberately do NOT announce: those are
   * error bodies the runner throws on rather than parses as a claim response.
   */
  const emptyClaim = async (payload: {
    diagnostics: ClaimDiagnostics;
    budgetResetsAt?: string | null;
  }) => {
    // Stamp the reason onto the task itself for an explicit single-task claim
    // (the Pusher-triggered dispatch every new task gets within seconds of
    // creation, and the /start "Poke" button). Without this, a task excluded
    // here renders as an ordinary QUEUED row until queue-stall's 4h watchdog
    // eventually names the gate — and if the gate never lets a single attempt
    // through, that's 4h of a human guessing (the 2026-09-10 incident: the
    // Home feed's fallback text blamed "seat contention" while the real cause,
    // visible on no dashboard, was a claim-query predicate excluding the task
    // outright). Best-effort and non-blocking — a failed stamp must never
    // affect the claim response.
    //
    // Scoped to the caller's claimable workspaces (the claim query's own list),
    // so a claim naming a task elsewhere writes nothing.
    if (taskId && payload.diagnostics.reason !== 'race_lost') {
      const stampTaskId = taskId;
      const deferrals = payload.diagnostics.deferrals as Record<string, number> | undefined;
      const exclusion = payload.diagnostics.taskExclusion;
      resolveClaimableWorkspaceIds()
        .then((ids) => {
          // A WHERE-clause gate that dropped the named task (a runner's wake
          // claim) otherwise leaves no gate-ledger row — the task's gate
          // history stays empty and explain can only call it a wait.
          const event = exclusion
            ? explicitExclusionGateEvent({ taskId: stampTaskId, exclusion, workspaceId: ids.length === 1 ? ids[0] : null })
            : null;
          if (event) fireDeferralEvent(event);
          return stampLastClaimAttempt({
            taskId: stampTaskId,
            workspaceIds: ids,
            reason: payload.diagnostics.reason,
            ...(deferrals ? { deferrals } : {}),
            ...(exclusion ? { exclusion } : {}),
            browserProvider: body.environment?.browserProvider,
            runnerGroup: body.environment?.fleet?.group,
            now: new Date(),
          });
        })
        .catch((err) => console.warn(`[claim] failed to stamp lastClaimAttempt for task ${stampTaskId}:`, err));
    }
    // A cloud container has no credential broker and must not learn secret ids.
    const pendingCredentialRefreshes = cloudExecutor ? undefined : await resolveAccountCredentialRefreshes(account);
    return NextResponse.json({
      workers: [],
      ...payload,
      ...(pendingCredentialRefreshes ? { pendingCredentialRefreshes } : {}),
    });
  };

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
      inArray(workers.status, [...LIVE_WORKER_STATUSES]),
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
      // `isBudgetExhausted` derives a reset from the exhaustion time when
      // `budget_resets_at` is NULL. The clear used to require a non-null reset,
      // so a half-written row (the column has no notNull) was frozen forever.
      if (!isBudgetExhausted(account.budgetExhaustedAt, account.budgetResetsAt)) {
        // Budget has reset — auto-clear the flag for this account and all seatId siblings.
        const resetWhere = account.seatId && account.teamId
          ? and(
              eq(accounts.teamId, account.teamId),
              eq(accounts.seatId, account.seatId),
              eq(accounts.authType, 'oauth'),
            )
          : eq(accounts.id, account.id);
        await db
          .update(accounts)
          .set({ budgetExhaustedAt: null, budgetResetsAt: null })
          .where(resetWhere!);
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
    // Also count open workspaces of the account's own team — those are
    // claimable without an explicit link.
    const openCount = await db.query.workspaces.findMany({
      where: and(eq(workspaces.accessMode, 'open'), eq(workspaces.teamId, account.teamId)),
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
    && isBudgetExhausted(account.budgetExhaustedAt, account.budgetResetsAt);

  const availableSlots = Math.min(maxTasks, account.maxConcurrentWorkers - activeWorkers.length);

  if (availableSlots === 0) {
    return emptyClaim({
      diagnostics: {
        reason: 'no_slots',
        activeWorkers: activeWorkers.length,
        maxConcurrent: account.maxConcurrentWorkers,
      } satisfies ClaimDiagnostics,
    });
  }

  const workspaceIds = await resolveClaimableWorkspaceIds();
  if (workspaceIds.length === 0) {
    return emptyClaim({
      diagnostics: { reason: 'no_workspaces' } satisfies ClaimDiagnostics,
    });
  }

  // A person's explicit claims from an interactive session skip the per-runner
  // cooldown (below), so they get their own limit instead: one attempt per
  // (task, account) per EXPLICIT_CLAIM_WINDOW_SEC.
  //
  // Skipped for a task in an executor='local' mission: there the interactive
  // session IS the executor, and fanning subagents out over a mission's tasks
  // is the intended use. The window is armed by the attempt, not the outcome,
  // so it also turned a retry after a gate rejection (e.g. workspace_cap) into
  // a second, unrelated rate_limited failure.
  const localMissionClaim = !!(taskId && interactiveSession) && await checkTaskMissionLocal(taskId!);
  if (taskId && interactiveSession && !localMissionClaim && !(await allowExplicitClaim(taskId, account.id))) {
    return emptyClaim({
      diagnostics: {
        reason: 'rate_limited',
        taskExclusion: {
          code: 'rate_limited',
          detail: `This task was claimed from this account less than ${EXPLICIT_CLAIM_WINDOW_SEC}s ago. Retry shortly.`,
        },
      } satisfies ClaimDiagnostics,
    });
  }

  if (forceRequested) {
    const target = await db.query.tasks.findMany({
      where: and(eq(tasks.id, taskId!), inArray(tasks.workspaceId, workspaceIds)),
      columns: { id: true, workspaceId: true },
      with: { workspace: { columns: { teamId: true } } },
      limit: 1,
    });
    const targetTeamId = (target[0] as any)?.workspace?.teamId as string | undefined;
    forceClaim = !!targetTeamId && targetTeamId === account.teamId;
    if (!forceClaim && target[0]) {
      fireGateEvent({
        gate: GATE_SLUGS.CLAIM_LOOP_DEFERRAL,
        surface: 'POST /api/workers/claim',
        outcome: 'rejected',
        reason: 'force_claim_cross_team',
        taskId: taskId!,
        workspaceId: target[0].workspaceId,
        callerOrigin: gateCallerOrigin({ apiAccount: account }),
      });
    }
  }

  // Find claimable tasks
  const now = new Date();
  // CLAIMABILITY CONTRACT (all conditions must hold):
  //   • status = 'pending'   — terminal statuses (cancelled, completed, failed) are never
  //                            claimable. stale-worker cleanup and worker-PATCH guards
  //                            (not(eq(tasks.status,'cancelled'))) ensure cancelled tasks
  //                            are never silently reset to 'pending' by retry machinery.
  //   • startAt ≤ now        — deferred tasks stay inert until their floor passes.
  //   • dependsOn satisfied  — all upstream deps completed+merged (or cancelled).
  //
  // MISSION PAUSE SEMANTICS: pausing a mission is a scheduler-level signal — it stops
  // new task generation but does NOT block already-filed tasks from being claimed.
  // Tasks already in the queue when a mission is paused remain claimable so in-flight
  // work drains gracefully. Pause = stop producing new work, not abort existing work.
  const claimableConditions = [
    inArray(tasks.workspaceId, workspaceIds),
    eq(tasks.status, 'pending'),
    or(isNull(tasks.claimedBy), lt(tasks.expiresAt, now)),
    // A deferred task is inert until its concrete floor. This is deliberately
    // enforced in the atomic claim query, not only in dispatch/UI. A force
    // claim starts it now, as the dashboard override clears startAt.
    ...(forceClaim ? [] : [or(isNull(tasks.startAt), lte(tasks.startAt, now))]),
  ];

  // If a specific taskId was requested, only claim that task
  if (taskId) {
    claimableConditions.push(eq(tasks.id, taskId));
  }

  // Named handles on the WHERE-clause gates, so an explicit-taskId claim that
  // comes back empty can re-evaluate these exact predicates for that one task
  // and say which one excluded it (./explicit-task-exclusion). Only populated
  // for gates that are pushed below; each value is the predicate as pushed.
  const explicitTaskGates: ExplicitTaskGates = {};

  if (account.type !== 'user') {
    explicitTaskGates.runnerPreference = or(eq(tasks.runnerPreference, 'any'), eq(tasks.runnerPreference, account.type))!;
    claimableConditions.push(explicitTaskGates.runnerPreference);
  }

  // Exclude tasks that already have an active worker (prevents duplicate claims
  // when stale cleanup resets a task to pending while another worker is still active)
  explicitTaskGates.activeWorker = sql`NOT EXISTS (
      SELECT 1 FROM ${workers} w
      WHERE w.task_id = ${tasks.id}
      AND w.status IN ('running', 'starting', 'waiting_input', 'idle')
    )`;
  claimableConditions.push(explicitTaskGates.activeWorker);

  // Exclude tasks whose mission is held. A held mission gates ALL its tasks
  // until explicitly armed (mission.isHeld=false). Force-starting a single task
  // bypasses this via context.bypassHeldGate=true (set by /start with forceOverride).
  if (!forceClaim) {
    explicitTaskGates.missionHeld = missionNotHeld();
    claimableConditions.push(explicitTaskGates.missionHeld);
  }
  // A mission with executor='local' is run from a person's own session: runners
  // never auto-claim its tasks. A verified interactive session naming the task
  // (claim_task {taskId}) is exactly that session, so the gate is not applied to
  // it and it gets a normal tracked worker. The held gate above still applies to
  // it — held is the pause and wins over the executor. Force claims and the
  // dashboard force-start (context.bypassHeldGate) lift it.
  if (!forceClaim && !(taskId && interactiveSession)) {
    explicitTaskGates.missionLocal = missionNotLocal();
    claimableConditions.push(explicitTaskGates.missionLocal);
  }
  // A single task held by a person (PATCH { held: true }) waits for resume.
  explicitTaskGates.taskHeld = taskNotHeld();
  claimableConditions.push(explicitTaskGates.taskHeld);

  // Subject liveness gate (§6 of docs/design/task-subject-anchors.md):
  // exclude tasks whose subject PR has been reconciled (marked dead by the
  // reconciliation sweep) *and* whose anchor actually identifies the subject
  // (source ∈ system|context). A PR number merely scraped from prose is
  // advisory and never gates a claim — see lib/subject-gate-contract.ts.
  // Reads persisted task columns only — zero extra DB calls. Tasks with no
  // subject anchor are unaffected (backwards compat).
  // context.bypassSubjectGate=true (written by /start with forceOverride)
  // bypasses this gate for a single force-started task.
  if (!forceClaim) {
    explicitTaskGates.subject = subjectLivenessCondition();
    claimableConditions.push(explicitTaskGates.subject);
  }

  // Exclude tasks whose dependencies haven't been satisfied yet.
  // "Satisfied" = dep is completed (and any PR merged) OR cancelled. A completed
  // dep with an open PR keeps blocking (root cause of the 6-overlapping-PR burst,
  // PRs #1044-1049). A cancelled dep is intentionally non-blocking — cancelling a
  // dead/abandoned dependency deliberately unblocks its dependents. failed /
  // pending / in_progress deps still block. See dependenciesSatisfied().
  // Exception: bypassDepsGate=true in task context lets a human override the gate
  // (set by /api/tasks/[id]/start when forceOverride=true).
  // No deps, empty deps, the force-start bypass, or every dependency satisfied.
  // Two-valued (see depsGate) so the explicit-claim probe can name it.
  if (!forceClaim) {
    explicitTaskGates.deps = depsGate();
    claimableConditions.push(explicitTaskGates.deps);
  }

  // Cap parallel workers per repo-backed workspace. Each task runs in its own git
  // worktree+branch, so parallel work is safe on disk; the cap bounds merge-conflict
  // surface from many branches on one repo. Skip this task if the count of active
  // workers on OTHER tasks in the same workspace has reached the workspace's
  // maxConcurrentTasks (default 3). Repo-less workspaces (coordination, etc.) never
  // have a repo so the inner EXISTS is false → count 0 → never serialized.
  // Workspace concurrency cap. A mission may raise the effective cap above the
  // workspace default (e.g. a 6-task mission under a workspace cap of 3 gets
  // effective cap = 6). GREATEST ensures the mission value can only raise, never
  // lower, the workspace baseline — per-mission downward capping is handled by the
  // mission-level gate in the dispatch loop below.
  //
  // context.capExempt=true is the operator override (written by /start with
  // capExempt). It MUST be honoured here and not only in the dispatch loop:
  // without this clause the exempted task is filtered out of the candidate set
  // precisely when the workspace is at cap — i.e. every time the button is
  // actually used — so the in-loop check below never saw the task at all.
  // Same accepted value forms on both sides via lib/bypass-flags.ts.
  if (!forceClaim) explicitTaskGates.workspaceCap = workspaceCapGate();
  if (explicitTaskGates.workspaceCap) claimableConditions.push(explicitTaskGates.workspaceCap);

  // Workspace executor (gitConfig.executor, packages/shared/src/executor.ts):
  // a host claim skips workspaces whose work runs in the cloud, so a runner's
  // cross-workspace poll cannot beat the cold-starting container to the task;
  // a cloud claim skips host-only workspaces. Applies to a person's explicit
  // interactive claim_task {taskId} too (the container is already on its way
  // for that task); only an admin force claim lifts it.
  if (!forceClaim) {
    explicitTaskGates.workspaceExecutor = workspaceExecutorGate(cloudExecutor ? 'cloud' : 'host');
    claimableConditions.push(explicitTaskGates.workspaceExecutor);
  }

  // Per-runner cooldown: skip tasks where this runner recently had a worker
  // error. Prevents Pusher-driven burn loops (2026-04-16 incident: one runner
  // re-claimed the same task ~12x in 52s after OAuth budget exhaustion).
  // Scoped by runner so a healthy runner can still pick up the task.
  const cooldownCutoff = new Date(Date.now() - CLAIM_COOLDOWN_MS);
  // Per-runner cooldown covers both 'error' AND 'failed' — budget/session workers
  // land in 'failed' (PATCH body sends status:'failed'), so the original 'error'
  // only check missed them entirely and left the burn-loop gap that caused the
  // 2026-06-25 session-limit storm.
  //
  // Not applied to a person's explicit claim from an MCP session: there is no
  // runner loop to break, every MCP session shares the runner id 'mcp' (so one
  // person's reaped worker cooled the task down for everyone), and re-claiming
  // right after a worker was reaped is exactly what an organizer does.
  if (!(taskId && interactiveSession)) {
    explicitTaskGates.runnerCooldown = sql`NOT EXISTS (
        SELECT 1 FROM ${workers} w_cd
        WHERE w_cd.task_id = ${tasks.id}
        AND w_cd.runner = ${runner}
        AND w_cd.status IN ('error', 'failed')
        AND w_cd.updated_at > ${cooldownCutoff}
      )`;
    claimableConditions.push(explicitTaskGates.runnerCooldown);
  }

  // Filter by roleSlug (see role-gate.ts). Opt-in EXPLICIT_ROLE_SLUGS
  // (visual-auditor) need an explicit availableSkills match; every other role
  // keeps the legacy rule, where an empty list claims anything.
  //
  // Exception: an interactive session's explicit claim (taskId + interactiveSession)
  // on a task whose mission runs locally (executor='local') skips the explicit-slug
  // requirement too. Runners never see a local mission's tasks at all (missionLocal
  // above already exempts this same claim from that gate), so the role gate's
  // browser-capability signal has no runner to protect here — the person's own
  // session can produce the same evidence a browser-capable runner would
  // (scripts/qa/shoot.sh, or dispatching visual-qa.yml, per the visual-review
  // skill), and the visual_evidence completion gate (workers/[id]/route.ts) still
  // enforces it regardless of who claims. Scoped to local missions only: a
  // runner-executed mission's browser-capability requirement is untouched, and a
  // force claim still never lifts this gate (see the force-claim comment above).
  const roleGateExempt = localMissionClaim;
  const roleConditions = roleGateExempt ? [] : roleSlugGate(availableSkills);
  if (roleConditions.length > 0) explicitTaskGates.role = and(...roleConditions)!;
  claimableConditions.push(...roleConditions);

  // Over-fetch candidates so a deferred prefix (e.g. connector-mismatched tasks)
  // cannot exhaust the window and starve valid tasks behind it.
  // Without this, `limit: availableSlots` means the dispatch loop only ever sees
  // the highest-priority N tasks; if all N are permanently deferred (wrong
  // connector, pacing, etc.) nothing else is ever examined — race_lost forever.
  //
  // Role-env gaps are known before the cut, so they do not count toward the
  // window: a page whose candidates no channel can deliver secrets to fetches
  // the next page, until the window holds candidateLimit runnable candidates
  // (bounded by ROLE_ENV_WINDOW_MAX_PAGES). Without this a backlog of
  // undeliverable high-priority tasks (e.g. a role whose secrets live on
  // another team) fills every window and the runner never sees the work
  // behind it. Gapped tasks stay in the
  // list so the loop still defers and reports them; the authoritative
  // pre-filter below re-runs after backend flips.
  const candidateLimit = Math.min(Math.max(availableSlots * 5, 25), 100);
  const fetchCandidatePage = (offset: number) => db.query.tasks.findMany({
    where: and(...claimableConditions),
    orderBy: (tasks, { desc, asc }) => [desc(tasks.priority), asc(tasks.createdAt)],
    limit: candidateLimit,
    offset,
    with: { workspace: true },
  });
  const claimableTasks: Awaited<ReturnType<typeof fetchCandidatePage>> = [];
  {
    const seen = new Set<string>();
    let runnable = 0;
    for (let page = 0; page < ROLE_ENV_WINDOW_MAX_PAGES; page++) {
      const batch = await fetchCandidatePage(page * candidateLimit);
      const fresh = batch.filter(t => !seen.has(t.id));
      for (const t of fresh) seen.add(t.id);
      claimableTasks.push(...fresh);
      if (batch.length < candidateLimit || taskId) break;
      const gaps = await runRoleEnvPreFilter(fresh, account.id);
      runnable += fresh.length - fresh.filter(t => gaps.has(t.id)).length;
      if (runnable >= candidateLimit) break;
    }
  }

  if (forceClaim && claimableTasks.some(t => t.id === taskId)) {
    // Which of the lifted SQL gates would have excluded the task. Same
    // predicates the ordinary claim applies; audit only, never blocks.
    const failing = await evaluateForcedGates({
      taskId: taskId!,
      workspaceIds,
      gates: {
        deps: depsGate(),
        missionHeld: missionNotHeld(),
        missionLocal: missionNotLocal(),
        subject: subjectLivenessCondition(),
        workspaceCap: workspaceCapGate(),
        workspaceExecutor: workspaceExecutorGate(cloudExecutor ? 'cloud' : 'host'),
        startAt: or(isNull(tasks.startAt), lte(tasks.startAt, now))!,
      },
    });
    forceBypassed.push(...failing);
  }

  if (claimableTasks.length === 0) {
    // An explicit taskId the query filtered out would otherwise read exactly
    // like an empty queue. Name the gate (friction task 81962c2f).
    const taskExclusion = taskId
      ? await diagnoseExplicitTaskExclusion({ taskId, workspaceIds, gates: explicitTaskGates, now })
      : null;
    return emptyClaim({
      diagnostics: {
        reason: 'no_pending_tasks',
        availableSlots,
        ...(taskExclusion ? { taskExclusion } : {}),
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

  // Memoized per-team provider pause log (budget/rate-limit walls recorded by the
  // worker-report route). A walled provider is never a dispatch target, in either
  // direction — that is what keeps a task from bouncing onto a pool that is dry.
  const teamPauseCache = new Map<string, Map<AgentBackend, ActivePause>>();
  const teamPauses = async (teamId?: string): Promise<Map<AgentBackend, ActivePause>> => {
    if (!teamId) return new Map();
    const cached = teamPauseCache.get(teamId);
    if (cached) return cached;
    const pauses = await getActiveBackendPauses({ teamId, accountId: account.id });
    teamPauseCache.set(teamId, pauses);
    return pauses;
  };

  /**
   * Earliest reset across every wall this request saw, or null. Only instants
   * still in the future qualify: the runner schedules its resume poll at this
   * time, and a past instant means "poll now", every time — a hot claim loop.
   * The account's own reset is a candidate only while its wall is actually in
   * force (the in-memory `account` still carries a reset this request has just
   * auto-cleared), and a missing one resolves to the derived session end.
   */
  const earliestFutureReset = (): string | null => {
    const nowMs = Date.now();
    const candidates: Date[] = [];
    if (accountBudgetExhausted && account.budgetExhaustedAt) {
      candidates.push(effectiveBudgetResetAt(account.budgetExhaustedAt, account.budgetResetsAt));
    }
    for (const pauses of teamPauseCache.values()) {
      for (const pause of pauses.values()) candidates.push(pause.resetsAt);
    }
    const future = candidates.filter(d => d.getTime() > nowMs).sort((x, y) => x.getTime() - y.getTime());
    return future.length > 0 ? future[0].toISOString() : null;
  };

  // Why THIS claim runs a task on a backend other than the one stored on it
  // (every flip below is in-memory). Stamped on the claim's context write as
  // BACKEND_ROUTING_KEY so explain / get_task can say why the backend changed.
  const backendRouting = new Map<string, ClaimBackendRouting>();
  const noteRouting = (task: { id: string }, from: AgentBackend, backend: AgentBackend, reason: ClaimRoutingReason) => {
    backendRouting.set(task.id, { backend, from, reason, at: now.toISOString() });
  };

  // Apply the team toggle's SAFE direction up front: if a task's backend is
  // disabled team-wide and the fallback is Claude, rewrite it to Claude now —
  // before the capability filter — so a Codex task with Codex disabled isn't
  // dropped for lacking Codex capability. (The Claude→Codex direction needs a
  // credential + the per-workspace slot, so it stays in the dispatch loop below.)
  for (const task of claimableTasks) {
    const taskTeam = (task as any).workspace?.teamId as string | undefined;
    const enabled = await teamEnabledBackends(taskTeam);
    if (maskBackend((task as any).backend as AgentBackend, enabled) === 'claude' && (task as any).backend !== 'claude') {
      noteRouting(task, (task as any).backend, 'claude', 'codex_disabled');
      (task as any).backend = 'claude';
      continue;
    }
    // A pinned backend is never failed over (provider-failover spec): a pinned
    // Codex task waits out its own wall — the dispatch loop defers it.
    if (isBackendPinned((task as any).context)) continue;
    // Same reasoning for a provider that is rate-limited rather than disabled: a
    // Codex task whose pool is walled runs on Claude instead. Rewriting here (not
    // in the dispatch loop) matters because the capability filter below drops
    // Codex tasks on runners without Codex — a walled Codex task would otherwise
    // be invisible to every Claude-only runner in the fleet.
    if ((task as any).backend === 'codex' && (!enabled || enabled.includes('claude'))) {
      const pauses = await teamPauses(taskTeam);
      if (pauses.has('codex') && !pauses.has('claude')) {
        noteRouting(task, 'codex', 'claude', 'codex_rate_limited');
        (task as any).backend = 'claude';
        console.log(`[claim] Provider pause: task ${task.id} → Claude (Codex rate-limited until ${pauses.get('codex')!.resetsAt.toISOString()})`);
      }
    }
  }

  const runnerHasCodexBackend = capabilities.includes('backend:codex');
  const runnerHasLocalCodexAuth = capabilities.includes('OPENAI_API_KEY') || capabilities.includes('CODEX_HOME');
  // A team's agent model endpoint can power Codex too (OpenAI-compatible
  // kinds only), but only for a runner that will actually apply it — one that
  // declares AGENT_ENDPOINT_RUNNER_FEATURE, same as the Claude path.
  const runnerSupportsEndpointForCapabilityCheck = runnerSupportsAgentEndpoint(body.runnerFeatures);

  // Memoized per-workspace server-side Codex auth (scope-aware: team-wide,
  // account, or workspace): a ChatGPT/OAuth connect, an OpenAI API key, or an
  // OpenAI-compatible team endpoint this runner will apply. Exactly what
  // attachCodexCredentials / attachAgentEndpoints can deliver below.
  const codexAvailability = new Map<string, boolean>();
  const workspaceHasCodex = async (scope: { teamId: string; accountId?: string | null; workspaceId: string }): Promise<boolean> => {
    const wsId = scope.workspaceId;
    if (codexAvailability.has(wsId)) return codexAvailability.get(wsId)!;
    let available = false;
    try {
      available = (await hasCodexCredential(scope)) || (await hasOpenAiApiKey(scope)) ||
        (runnerSupportsEndpointForCapabilityCheck && await hasOpenAiCompatibleAgentEndpoint(scope));
    } catch (err) {
      console.warn(`[claim] Codex credential check failed for workspace ${wsId}:`, err);
    }
    codexAvailability.set(wsId, available);
    return available;
  };

  /**
   * Will this caller's worker actually have Codex auth? The one predicate for
   * both the capability filter (a task stored as Codex) and a flip to Codex
   * (`tryFlipToCodex`), mirroring the runner's own preflight (workers.ts,
   * "No Codex credential configured"): a delivered `codexCredential`, its own
   * OPENAI_API_KEY, or its own CODEX_HOME.
   *  - no `backend:codex`: the caller cannot run Codex at all (an MCP session,
   *    an old runner).
   *  - cloud executor: credentials are stripped from the claim and the egress
   *    proxy only credentials Anthropic and GitHub traffic, so nothing can
   *    authenticate Codex in the container.
   *  - local auth: enough on its own.
   *  - server credential: only deliverable with ENCRYPTION_KEY (every attach
   *    step is a no-op without it).
   */
  const codexAuthReachesRunner = async (scope: { teamId?: string | null; workspaceId: string }): Promise<boolean> => {
    if (!runnerHasCodexBackend || cloudExecutor) return false;
    if (runnerHasLocalCodexAuth) return true;
    if (!process.env.ENCRYPTION_KEY || !scope.teamId) return false;
    return workspaceHasCodex({ teamId: scope.teamId, accountId: account.id, workspaceId: scope.workspaceId });
  };

  const codexAuthTaskIds = new Set<string>();
  await Promise.all(claimableTasks.map(async (task) => {
    if ((task as any).backend !== 'codex') return;
    if (await codexAuthReachesRunner({ teamId: (task as any).workspace?.teamId, workspaceId: task.workspaceId })) {
      codexAuthTaskIds.add(task.id);
    }
  }));

  // Filter by backend: a Codex task needs a caller whose worker will have Codex auth.
  const filteredTasks = claimableTasks.filter((task) =>
    (task as any).backend !== 'codex' || codexAuthTaskIds.has(task.id));

  if (filteredTasks.length === 0) {
    return emptyClaim({
      diagnostics: {
        reason: 'capability_mismatch',
        pendingTasks: claimableTasks.length,
        matchedTasks: 0,
        ...(taskId ? {
          taskExclusion: {
            code: 'capability_mismatch',
            detail: 'The task runs on the Codex backend, and this caller advertises neither backend:codex with local Codex auth nor access to a team Codex credential.',
          },
        } : {}),
      } satisfies ClaimDiagnostics,
    });
  }

  // ── Connector availability pre-filter ──────────────────────────────────────
  // Classifies which candidate tasks have unavailable connectors, and why.
  // Taxonomy, visibility and credential rules live in ./connector-prefilter;
  // deciding what to DO about a failure stays here.
  const {
    connectorMismatchTaskIds,
    taskConnectorFailures,
    taskRequiredConnectorFailures,
    taskDegradedConnectors,
  } = await runConnectorPreFilter(filteredTasks);

  // ── Role env pre-filter ────────────────────────────────────────────────────
  // Candidates whose role/workspace declares env vars that no delivery channel
  // (role_env_secret, same-named mcp_credential, runner-held BUILDD_API_KEY)
  // can satisfy. Claiming them only produced a "Role env degraded" worker or a
  // provisioning failure, so the loop defers them instead. No runner can make
  // up the difference (its process env never reaches the agent), so this is a
  // server decision. Fails open. See ./role-env-injection.
  const roleEnvGaps = await runRoleEnvPreFilter(filteredTasks, account.id);

  // For explicit single-task claims: 422 routing_mismatch instead of silently
  // not claiming. The caller knows which task it wanted — a clear error with
  // typed failure info is more useful than an empty workers array.
  if (taskId && connectorMismatchTaskIds.has(taskId)) {
    const blockedTask = filteredTasks.find(t => t.id === taskId);
    const blockedSlug = (blockedTask as any)?.roleSlug as string | null;
    const failures = taskConnectorFailures.get(taskId) ?? [];
    const detail = failures.map(f => `'${f.connectorName}' (${f.mode})`).join(', ') ||
      `role '${blockedSlug}' connector requirements not met`;
    return NextResponse.json(
      {
        error: 'routing_mismatch',
        detail: `Task requires connectors for role '${blockedSlug}' that are unavailable: ${detail}`,
        connectorFailures: failures,
      },
      { status: 422 },
    );
  }


  // ── Connector-block notifications (fire-and-forget) ──────────────────────
  // For tasks blocked due to required-connector failures, notify the owning team
  // the first time the block is detected. Dedup is tracked via
  // task.context.connectorBlockNotifiedAt so a retry claim does not re-alert.
  // Errors are swallowed — notifications must never delay the claim response.
  if (taskRequiredConnectorFailures.size > 0) {
    const notifyNow = new Date();
    const notifyOps: Promise<void>[] = [];
    for (const [blockedTaskId, reqFailures] of taskRequiredConnectorFailures) {
      const blockedTask = filteredTasks.find(t => t.id === blockedTaskId);
      if (!blockedTask) continue;
      const teamId = (blockedTask as any).workspace?.teamId as string | undefined;
      if (!teamId) continue;
      const taskContext = (blockedTask.context as Record<string, unknown> | null) ?? {};
      const alreadySent = !!taskContext.connectorBlockNotifiedAt;
      notifyOps.push(
        notifyConnectorBlocked(
          {
            teamId,
            taskTitle: blockedTask.title,
            workspaceName: ((blockedTask as any).workspace?.name as string | undefined) ?? blockedTask.workspaceId,
            roleSlug: ((blockedTask as any).roleSlug as string | null) ?? '',
            failures: reqFailures,
          },
          alreadySent,
        ).then((sent) => {
          if (!sent) return;
          return db
            .update(tasks)
            .set({
              context: {
                ...taskContext,
                connectorBlockNotifiedAt: notifyNow.toISOString(),
                // Store failures so the reminder cron can reconstruct the message.
                connectorBlockFailures: reqFailures,
              },
              updatedAt: notifyNow,
            })
            .where(eq(tasks.id, blockedTaskId))
            .then(() => {});
        }).catch((err) => {
          console.warn(`[claim] connector-block notify failed for task ${blockedTaskId}:`, err);
        }),
      );
    }
    Promise.all(notifyOps).catch(() => {});
  }

  // Compute router inputs once per claim request. The router is pure; the
  // signals below feed its budget-pressure and spike-detection gates.
  const dailyBudgetPct = account.authType === 'api' && account.maxCostPerDay
    ? Math.min(1, parseFloat(account.totalCost.toString()) / parseFloat(account.maxCostPerDay.toString()))
    : 0;

  // OAuth budget pacing. Seat auth reports no cost, so the pressure signal is
  // learned from past exhaustion episodes instead: how many workers/turns/tokens
  // this account's 5h window has historically held (p25, conservative), versus
  // what the current window has already consumed. The 5h-wall forecast is not
  // reliable enough to delay work on, so it does NOT feed `dailyBudgetPct` (the
  // router would pause priority-0 work at 95%). Its only effect is a lower
  // per-seat session cap — `oauthSeatSlotsLeft`, retaining at least half the slots,
  // restored when the window resets, off entirely at low confidence.
  // Failures here never block claiming.
  //
  // Two hard exemptions, both deliberate:
  //  • `taskId` present — this is an explicit start (dashboard Start button or a
  //    Pusher assignment for one task). A human asking for this task now always
  //    wins over pacing; pacing only governs autonomous background claiming.
  //    Without this, pacing would reintroduce the silent no-op Start that
  //    /api/tasks/[id]/start already suffers from.
  //  • OAUTH_BUDGET_PACING=off — operational kill switch, no redeploy of logic
  //    needed, no settings row, no UI.
  const pacingConfig = readPacingConfig(process.env);
  const pacingApplies = pacingConfig.enabled && !taskId;
  let oauthPressure: OauthBudgetPressure | null = null;
  let oauthSeatSlotsLeft: number | null = null; // null = uncapped
  if (account.authType === 'oauth' && pacingApplies) {
    try {
      const accountIds = await resolveSeatIdPeers({
        id: account.id,
        teamId: account.teamId ?? '',
        seatId: account.seatId ?? null,
      });
      const episodes = await loadOauthEpisodes(accountIds, undefined, now);
      const capacity = learnOauthCapacity(episodes, { quantile: pacingConfig.quantile });

      if (capacity.confidence !== 'none') {
        const { windowStartedAt, usage } = await measureOauthWindow({
          accountIds,
          now,
          lastResetsAt: episodes[0]?.resetsAt ?? null,
        });

        oauthPressure = oauthBudgetPressure({ usage, capacity, now, windowStartedAt, observedAt: episodes[0]?.exhaustedAt });
        const seatCap = oauthParallelismCap({ pressure: oauthPressure, baseMax: account.maxConcurrentWorkers });
        if (seatCap !== null) {
          oauthSeatSlotsLeft = Math.max(0, seatCap - await countLiveSeatWorkers(accountIds));
        }
        if (oauthPressure.pct >= 0.5) {
          console.log(
            `[claim] ${describeOauthPressure(oauthPressure)} seat cap ${seatCap ?? 'none'} ` +
            `window opened ${windowStartedAt.toISOString()}, ends ${windowEndsAt(windowStartedAt).toISOString()}`,
          );
        }
      }
    } catch (err) {
      console.warn(`[claim] OAuth budget pacing unavailable for account ${account.id}:`, err);
    }
  }

  const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000);
  const recentClaims = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(eq(tasks.claimedBy, account.id), gte(tasks.claimedAt, tenMinAgo)));
  const recentClaimCount = recentClaims[0]?.count ?? 0;

  // Pre-fetch role rows for every unique roleSlug referenced by the filtered
  // tasks, in one query. Resolved per task below by pickRoleRowForTask: the
  // task workspace's override, else its team's default — never another
  // workspace's override of the same slug (role-routing.md §3.1).
  const uniqueRoleSlugs = [...new Set(
    filteredTasks.map(t => (t as any).roleSlug as string | null).filter(Boolean) as string[],
  )];
  let roleModelRows: RoleModelRow[] = [];
  if (uniqueRoleSlugs.length > 0) {
    const taskWorkspaceIds = [...new Set(filteredTasks.map(t => t.workspaceId))];
    const taskTeamIds = [...new Set(
      filteredTasks.map(t => (t as any).workspace?.teamId as string | undefined).filter(Boolean) as string[],
    )];
    roleModelRows = await db.query.workspaceSkills.findMany({
      where: and(
        inArray(workspaceSkills.slug, uniqueRoleSlugs),
        eq(workspaceSkills.isRole, true),
        eq(workspaceSkills.enabled, true),
        or(
          // Workspace override rows for the tasks' own workspaces
          inArray(workspaceSkills.workspaceId, taskWorkspaceIds),
          // Team-level default rows
          taskTeamIds.length > 0
            ? and(isNull(workspaceSkills.workspaceId), inArray(workspaceSkills.teamId, taskTeamIds))
            : undefined,
        ),
      ),
      columns: { slug: true, model: true, workspaceId: true, teamId: true },
    });
  }

  // Claim tasks and create workers with optimistic locking to prevent double-assignment.
  // Note: neon-http driver does not support interactive transactions (where intermediate
  // results inform subsequent queries). Instead, we use atomic UPDATE...WHERE status='pending'
  // which is inherently safe against concurrent claims at the SQL level.
  const claimedWorkers: ClaimTasksResponse['workers'] = [];

  // Per-reason deferral counters for the dispatch loop. Incremented at each
  // `continue` so the final response can distinguish "all deferred" from true
  // lock-contention (`race_lost`). Also powers the `all_candidates_deferred`
  // diagnostic reason added by the 2026-07-30 candidate-window starvation fix.
  const deferrals = {
    connector_mismatch: 0,
    subject_dead: 0,
    path_overlap: 0,
    advisory_manifest: 0,
    soft_overlap: 0,
    mission_budget: 0,
    mission_concurrent: 0,
    mission_paced: 0,
    workspace_cap: 0,
    provider_unavailable: 0,
    budget_paused: 0,
    routing_paused: 0,
    duplicate_worker: 0,
    sibling_retry_open: 0,
    fix_not_needed: 0,
    runner_capability: 0,
    codex_single_flight: 0,
    oauth_parallelism: 0,
    role_env_unsatisfied: 0,
    ordered_behind: 0,
    managed_concurrency: 0,
    managed_runner_hours: 0,
    hosted_runner_hours: 0,
    // Every counter must be a declared diagnostics key (and vice versa): the
    // response casts to ClaimDiagnostics['deferrals'], so without this check a
    // new reason ships untyped to every client.
  } satisfies Required<NonNullable<ClaimDiagnostics['deferrals']>>;

  // Set when the EXPLICITLY requested task (claim with `taskId`) is itself
  // deferred in the dispatch loop below. It already passed every SQL-level
  // gate (it is in `filteredTasks`), so the SQL probe never runs for it; the
  // loop knows which gate held it, so it says so (see deferTask).
  let explicitTaskExclusion: ClaimTaskExclusion | null = null;

  // One gate_events row per (task, reason) examined-and-not-dispatched this
  // tick — coalesced across polls by `fireDeferralEvent` so a task stuck
  // behind the same gate for hours accumulates a `consecutiveDeferrals`
  // counter on one row instead of a fresh row every few seconds. This is the
  // durable half of the `deferrals` counters above, which die with the
  // response object once this request returns.
  const deferTask = (
    task: { id: string; workspaceId: string; missionId?: string | null },
    reasonKey: keyof typeof deferrals,
    detail?: Record<string, unknown>,
  ) => {
    deferrals[reasonKey]++;
    // The named task itself was deferred: say by what. Path overlap sets a
    // richer sentence before calling here, so keep one that is already set.
    if (taskId && task.id === taskId && !explicitTaskExclusion) {
      explicitTaskExclusion = describeExplicitDeferral(reasonKey, detail);
    }
    fireDeferralEvent({
      gate: GATE_SLUGS.CLAIM_LOOP_DEFERRAL,
      surface: 'POST /api/workers/claim',
      outcome: 'deferred',
      reason: reasonKey,
      workspaceId: task.workspaceId,
      missionId: (task as any).missionId ?? null,
      taskId: task.id,
      callerOrigin: 'worker',
      detail,
    });
  };

  // Number of tasks that reached the atomic claim attempt (UPDATE...WHERE status='pending').
  // If lockAttempts === 0 at the end of the loop, every candidate was deferred — no
  // lock contention occurred and `race_lost` would be a misnomer.
  let lockAttempts = 0;
  // First PR that deferred a candidate on path overlap — surfaced as
  // `diagnostics.blockedByPr` (no runner reads it yet; it is there for callers
  // that want to name the PR an idle runner is waiting on).
  let firstBlockingPr: { prNumber: number | null; prUrl: string | null } | null = null;
  // path_overlap deferrals to register as waiters on their blocker, written
  // once after the response (scheduleClaimDeferralWaiters). Without the row a
  // blocker's release has nobody to wake, and the deferred task waits out the
  // runner's fallback poll.
  const deferralWaiters = new Map<string, ClaimDeferralWaiter[]>();
  const noteDeferralWaiter = (workspaceId: string, waitingTaskId: string, blockingTaskId: string | null | undefined, blockedPaths: string[]) => {
    if (!blockingTaskId || blockingTaskId === waitingTaskId) return;
    const list = deferralWaiters.get(workspaceId) ?? [];
    for (const blockedPath of blockedPaths) list.push({ waitingTaskId, blockingTaskId, blockedPath });
    if (list.length > 0) deferralWaiters.set(workspaceId, list);
  };

  // Per-workspace concurrency cap enforced within this batch. The SQL guard above
  // filtered candidates against *existing* active workers, but a single batch could
  // still claim several same-repo tasks at once (they all passed when the count was
  // below the cap). Seed the running tally with this account's existing active
  // workers per workspace and stop claiming once a repo workspace reaches its cap.
  const DEFAULT_MAX_CONCURRENT_TASKS = 3;
  const activeByWorkspace = new Map<string, number>();
  // Managed runs this batch started, per team: not yet visible to the
  // entitlement's live-worker count.
  const managedClaimedByTeam = new Map<string, number>();
  // Hosted runner allowance per team, read once per request (cloud claims only).
  const hostedAllowanceByTeam = new Map<string, Awaited<ReturnType<typeof checkHostedRunnerAllowance>>>();
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
  const activeTaskIds = activeWorkers.map(w => w.taskId).filter(Boolean) as string[];
  if (activeTaskIds.length > 0) {
    // Not filtered on the stored column: a budget-failover flip leaves the row
    // on 'claude' and records the Codex run only in the claim stamp, so a
    // `backend = 'codex'` WHERE missed every failover-started Codex worker and
    // the next claim request flipped another task onto the same window.
    const activeTasks = await db.query.tasks.findMany({
      where: inArray(tasks.id, activeTaskIds),
      columns: { workspaceId: true, backend: true, context: true },
    });
    for (const t of activeTasks) {
      if (t.workspaceId && claimedBackendOf(t.backend, t.context) === 'codex') codexBusyWorkspaces.add(t.workspaceId);
    }
  }
  // Flip a task to Codex in-memory, respecting runner-side Codex auth
  // (codexAuthReachesRunner — the same predicate as the capability filter), the
  // ≤1-Codex-per-workspace throttle, and an active Codex rate-limit. Shared by
  // the provider toggle and budget failover. Returns true if the flip happened.
  const tryFlipToCodex = async (task: any, teamId: string | undefined, wsId: string | undefined, reason: ClaimRoutingReason): Promise<boolean> => {
    const codexFree = !!wsId && !codexBusyWorkspaces.has(wsId) && !codexFlippedWorkspaces.has(wsId);
    if (teamId && (await teamPauses(teamId)).has('codex')) return false;
    if (wsId && teamId && codexFree && await codexAuthReachesRunner({ teamId, workspaceId: wsId })) {
      noteRouting(task, (task.backend || 'claude') as AgentBackend, 'codex', reason);
      task.backend = 'codex';
      codexFlippedWorkspaces.add(wsId);
      return true;
    }
    return false;
  };

  // The Claude model route per workspace (./claude-model-route), memoized: the
  // seat predicate the budget failover and OAuth pacing both read.
  const claudeRouteCache = new Map<string, Promise<ClaudeModelRoute>>();
  const claudeRouteFor = (teamId: string | undefined, workspaceId: string): Promise<ClaudeModelRoute> => {
    const key = `${teamId ?? ''}:${workspaceId}`;
    let route = claudeRouteCache.get(key);
    if (!route) {
      route = resolveClaudeModelRoute({
        teamId,
        workspaceId,
        accountId: account.id,
        cloudExecutor,
        llmProviderOverride: body.llmProviderOverride === true,
        runnerSupportsEndpoint: runnerSupportsEndpointForCapabilityCheck,
        encryptionKeySet: !!process.env.ENCRYPTION_KEY,
      });
      claudeRouteCache.set(key, route);
    }
    return route;
  };

  // Pre-fetch tasks with open PRs per workspace, keyed by workspaceId.
  // Used by the path-overlap claim guard below. Fetched once outside the loop
  // so we don't repeat the query for every candidate task.
  const openPrTasksByWorkspace = new Map<string, Array<{
    taskId: string | null;
    pathManifest: string[] | null;
    prNumber: number | null;
    prUrl: string | null;
    workerStatus: string | null;
    prLifecycle: string | null;
    branch: string | null;
    prBaseRef: string | null;
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
      columns: { workspaceId: true, taskId: true, prNumber: true, prUrl: true, branch: true, prBaseRef: true, prLifecycleStatus: true, status: true, updatedAt: true },
    });
    // Exclude closed/abandoned PRs — a closed PR should not block sibling tasks
    // from claiming (it was abandoned, not merged; treating it as open would
    // block dependent tasks forever if the PR branch is never re-opened).
    // Also exclude holders parked on a question past the TTL (path-claim-ttl.ts).
    // Per worker on purpose, unlike layer 2 / check_path_claim (per task via
    // expiredParkedTaskIds): this layer is keyed on the PR, and the PR belongs
    // to the one worker that opened it. A fresh sibling worker on the same task
    // with no PR still blocks through its path_claims at layer 2.
    const activeOpenPrWorkers = openPrWorkers.filter(w => w.prLifecycleStatus !== 'closed' && !isExpiredParkedHolder(w));
    if (activeOpenPrWorkers.length > 0) {
      const prTaskIds = activeOpenPrWorkers.map(w => w.taskId).filter(Boolean) as string[];
      const prTasks = prTaskIds.length > 0
        ? (await db.query.tasks.findMany({
            where: inArray(tasks.id, prTaskIds),
            columns: { id: true, pathManifest: true },
          })) ?? []
        : [];
      const prTaskManifestMap = new Map(prTasks.map(t => [t.id, t.pathManifest as string[] | null]));

      for (const w of activeOpenPrWorkers) {
        const manifest = w.taskId ? (prTaskManifestMap.get(w.taskId) ?? null) : null;
        const entry = {
          taskId: w.taskId, pathManifest: manifest, prNumber: w.prNumber, prUrl: w.prUrl,
          workerStatus: (w.status as string | null) ?? null, prLifecycle: (w.prLifecycleStatus as string | null) ?? null,
          branch: w.branch ?? null, prBaseRef: w.prBaseRef ?? null,
        };
        const list = openPrTasksByWorkspace.get(w.workspaceId) ?? [];
        list.push(entry);
        openPrTasksByWorkspace.set(w.workspaceId, list);
      }
    }
  }

  // Pre-fetch active path_claims per workspace for the path-overlap backstop.
  // path_claims holds actual file locks: declared ones from check_path_claim,
  // and — since observed touches are auto-leased on worker sync
  // (claimObservedPaths) — a lease on every file a live worker has actually
  // edited. This backstop defers a pending task whose pathManifest overlaps any
  // held lock, even if the locking task hasn't opened a PR yet, which is the
  // window layer 1 cannot see and the reason the auto-lease matters: the second
  // agent is stopped before it starts rather than told afterwards.
  const activePathClaimsByWorkspace = new Map<string, Map<string, string[]>>();
  // Workspaces whose lease read failed: their lease state is unknown, so the
  // hold/start shadow below never asks about them.
  const leaseReadFailedWorkspaces = new Set<string>();
  if (openPrWorkspaceIds.length > 0) {
    await Promise.all(openPrWorkspaceIds.map(async (wsId) => {
      try {
        const byTask = await getActiveClaimsByWorkspace(wsId);
        if (byTask.size > 0) activePathClaimsByWorkspace.set(wsId, byTask);
      } catch (err) {
        leaseReadFailedWorkspaces.add(wsId);
        console.warn(`[claim] getActiveClaimsByWorkspace failed for workspace ${wsId}:`, err);
      }
    }));
  }

  // Soft overlap holders (./soft-overlap-gate). Read only when a candidate
  // carries `pathDeclaration.softOverlaps`; null = the read failed, and every
  // soft entry then holds as unknown state (fail closed).
  let softHolders: Map<string, SoftHolderRow> | null = new Map();
  const softHolderIds = softOverlapHolderIds(filteredTasks as Array<{ id: string; pathDeclaration?: unknown }>);
  if (softHolderIds.size > 0) {
    try {
      softHolders = await loadSoftOverlapHolders([...softHolderIds]);
    } catch (err) {
      softHolders = null;
      console.warn('[claim] soft overlap holder read failed (holding every soft overlap):', err);
    }
  }

  // ── Mission-level gates (pacing, concurrency, budget) ─────────────────────────
  // Batch-fetch mission rows and active worker counts for all tasks that reference
  // a mission. Used by three claim-loop guards:
  //   1. budget_exhausted status → skip task (never claim into an exhausted mission)
  //   2. maxConcurrentTasks     → skip when mission-level cap is reached
  //   3. pacing                 → skip when the minimum inter-start interval hasn't elapsed
  //
  // These are enforced in-loop so they skip individual tasks without blocking other
  // missions or non-mission tasks in the same poll.
  //
  // The same read also carries the mission's Option A′ integration fields out to
  // the runner. That is not a gate — it is what lets the runner's Git Workflow
  // prompt block call `resolveTaskPrBase`, the same function `create_pr` uses to
  // derive the base. Without them the prompt could only see the workspace's
  // trunk, which is exactly how a worker came to be told "PR to <trunk>" by a
  // server that then refused trunk for that task.
  type MissionClaimData = {
    id: string;
    status: string;
    maxConcurrentTasks: number | null;
    pacingMode: 'eager' | 'paced';
    pacingMaxPerHour: number | null;
    lastTaskStartedAt: Date | null;
    workingBranch: string | null;
    integrationBranchEnabled: boolean | null;
  };
  const missionClaimMap = new Map<string, MissionClaimData>();
  /**
   * missionId → in-flight NON-review tasks. Reviewer-dispatched tasks
   * (`isDispatchedReview`) inherit the reviewed PR's missionId but are not mission work: they are
   * exempt from the mission concurrency cap and pacing gate below, so they must
   * not occupy a slot either — otherwise a running reviewer pushes back the
   * next builder, and the builder queue pushes back the review.
   */
  const missionActiveCountMap = new Map<string, number>();
  /**
   * missionId → ids of that mission's in-flight tasks that declared no file
   * scope. "No scope" is `declaresNoScope()`, NOT `isAdvisoryManifest()`: null,
   * `[]` and `['**']` are all equally undeclared, and the sentinel-only reading
   * let a manifest-less task (anything predating the `['**']` mission default)
   * past this guard entirely.
   *
   * Feeds the compensating serialization guard in the dispatch loop: since the
   * authoring pass no longer mints dependsOn edges from a wildcard manifest
   * (packages/core/path-overlap.ts), and a task with no concrete paths cannot be
   * matched against a held lease by layer 2 no matter who is holding one, two
   * scope-undeclared tasks in one mission would otherwise run concurrently and
   * ping-pong conflict retries on the same files.
   *
   * `category: 'review'` tasks are excluded from both sides of this guard.
   * `createReviewerTask` (lib/reviewer.ts) never sets a pathManifest — a
   * reviewer reads a diff and posts a verdict, it has no file scope to
   * declare — so every reviewer task is "scope-undeclared" by construction.
   * Counting it as the mission's one undeclared-scope occupant blocks every
   * other reviewer task in the same mission (they can never conflict with each
   * other on disk), and worse, an orchestration/investigation task that is
   * ALSO scope-undeclared and stays in flight starves reviewer tasks
   * indefinitely — the mission's heartbeat loop keeps refilling that slot
   * before a reviewer ever gets a turn.
   */
  const missionAdvisoryInFlight = new Map<string, Set<string>>();
  /** The same in-flight rows, kept for the claim planner's input. */
  let missionInFlightRows: MissionInFlightRow[] = [];

  const filteredMissionIds = [...new Set(
    filteredTasks.map(t => (t as any).missionId as string | null).filter(Boolean) as string[],
  )];
  if (filteredMissionIds.length > 0) {
    const missionRows = await db.query.missions.findMany({
      where: inArray(missions.id, filteredMissionIds),
      columns: {
        id: true, status: true, maxConcurrentTasks: true, pacingMode: true,
        pacingMaxPerHour: true, lastTaskStartedAt: true,
        workingBranch: true, integrationBranchEnabled: true,
      },
    });
    for (const m of missionRows) {
      missionClaimMap.set(m.id, m as MissionClaimData);
    }

    // In-flight tasks per mission. ONE query feeds two gates: the concurrency
    // count (was a COUNT(*) GROUP BY) and the advisory-manifest serialization
    // guard below, which needs the in-flight tasks' manifests. Row-level instead
    // of aggregated so we don't add a second round trip; the count is the same
    // number of joined worker rows the aggregate produced.
    missionInFlightRows = await db
      .select({ missionId: tasks.missionId, taskId: tasks.id, pathManifest: tasks.pathManifest, category: tasks.category, context: tasks.context, outputRequirement: tasks.outputRequirement })
      .from(workers)
      .innerJoin(tasks, eq(tasks.id, workers.taskId))
      .where(and(
        inArray(tasks.missionId, filteredMissionIds),
        inArray(workers.status, ['running', 'starting', 'idle', 'waiting_input']),
      ));
    for (const row of missionInFlightRows) {
      if (!row.missionId) continue;
      if (!isDispatchedReview(row.category, row.context)) {
        missionActiveCountMap.set(row.missionId, (missionActiveCountMap.get(row.missionId) ?? 0) + 1);
      }
      if (row.category !== 'review' && !producesNoFileEdits(row.outputRequirement)
        && declaresNoScope(row.pathManifest as string[] | null)) {
        const set = missionAdvisoryInFlight.get(row.missionId) ?? new Set<string>();
        if (row.taskId) set.add(row.taskId);
        missionAdvisoryInFlight.set(row.missionId, set);
      }
    }
  }

  // Hold/start at claim (knowledge-base: buildd/design/conflict-aware-orchestration.md §5b).
  // The collector only remembers advisory deferrals that pass every
  // deterministic rail (no I/O); the decisions run after the response. The
  // gated START path is live (task 7eb191b9): an advisory deferral looks up an
  // applied Jev START for its exact state, one indexed ledger read, and holds
  // on any miss or error. `CLAIM_HOLD_APPLYING_FRACTION = 0` turns it off.
  const holdStart = new ClaimHoldCollector();
  const holdStartGated = gatedStartReachable();
  // Every hold/start call in the loop is non-throwing: the collector methods,
  // gatedStartApplies and acquireGatedStartPaths catch internally, and this
  // context builder does too. The bookkeeping runs for every team, opted in or
  // not, so a malformed row must cost a skipped note, never a failed claim.
  const holdStartContext = (t: any, isForced: boolean): ClaimHoldTaskContext | null => {
    try {
      return buildHoldStartContext(t, isForced);
    } catch (err) {
      console.warn(`[claim] hold/start context failed for task ${t?.id} (skipped):`, (err as Error)?.message ?? err);
      return null;
    }
  };
  const buildHoldStartContext = (t: any, isForced: boolean): ClaimHoldTaskContext | null => {
    const teamId = t.workspace?.teamId as string | undefined;
    if (!teamId) return null;
    const created = t.createdAt ? new Date(t.createdAt) : null;
    return {
      teamId,
      workspaceId: t.workspaceId,
      missionId: t.missionId ?? null,
      taskId: t.id,
      accountId: account.id ?? null,
      title: typeof t.title === 'string' ? t.title : null,
      taskCreatedAt: created && Number.isFinite(created.getTime()) ? created.toISOString() : null,
      retryKind: t.conflictRetryPrNumber ? 'conflict' : t.reviewerRetryPrNumber ? 'reviewer' : t.ciRetryPrNumber ? 'ci' : null,
      forced: isForced,
      leaseReadFailed: leaseReadFailedWorkspaces.has(t.workspaceId),
      gitConfig: t.workspace?.gitConfig ?? null,
      now: now.toISOString(),
    };
  };

  /** The risk evidence for an open-PR overlap, read before the synchronous collector runs. Never throws. */
  const readOpenPrRiskEvidence = async (
    t: any,
    manifest: string[],
    openPrs: Array<{ prNumber: number | null; pathManifest: string[] | null; workerStatus: string | null; branch: string | null }>,
    ownPrs: Array<{ branch: string | null }>,
  ): Promise<ClaimRiskEvidence> => {
    try {
      const overlapping = openPrs.filter(p => p.prNumber && p.pathManifest?.length && intersectPaths(manifest, p.pathManifest).length > 0);
      // A holder with a live worker is a hard rail; its diff cannot change the answer.
      const askable = overlapping.filter(p => !isLiveHolderStatus(p.workerStatus));
      if (askable.length === 0 || askable.length !== overlapping.length) return {};
      const [prScopes, probe] = await Promise.all([
        prefetchPrDiffScopes({ workspaceId: t.workspaceId, prNumbers: askable.map(p => p.prNumber as number) }, await defaultPrDiffScopeDeps()),
        askable.length === 1 && ownPrs.find(p => p.branch)?.branch
          ? loadPairProbeEvidence({ workspaceId: t.workspaceId, candidate: { branch: ownPrs.find(p => p.branch)!.branch }, holder: { branch: askable[0].branch } })
          : Promise.resolve(null),
      ]);
      return { prScopes, probe };
    } catch (err) {
      console.warn(`[claim] open-PR risk evidence unavailable for task ${t?.id} (skipped):`, (err as Error)?.message ?? err);
      return {};
    }
  };

  // ── Claim-time batch planner (./claim-plan-input, knowledge-base: buildd/design/jev-scheduling.md §5) ──
  // Per workspace, gitConfig.claimPlanner: 'off' leaves everything below
  // exactly as it was — no extra read, no extra write, same walk. 'record'
  // plans beside the legacy walk and records both. 'apply' (the default when
  // unset) claims in plan order: every gate in the loop still runs on each pick, and a pick
  // that is refused or loses its race is dropped and the rest re-planned.
  // Never for an explicit taskId claim (which includes every force claim). A
  // gated START (now live) is just another gate on each pick: it can only
  // relax an advisory deferral the pick reaches, so 'apply' keeps its order.
  const plannerConfigs = new Map<string, ReturnType<typeof resolveClaimPlannerConfig>>();
  const plannerModeOf = (t: { workspaceId: string }): ClaimPlannerMode => {
    if (taskId) return 'off';
    let cfg = plannerConfigs.get(t.workspaceId);
    if (!cfg) {
      cfg = resolveClaimPlannerConfig((t as any).workspace?.gitConfig);
      plannerConfigs.set(t.workspaceId, cfg);
    }
    return cfg.mode;
  };
  // A candidate a pre-filter already refuses (connector, role env) is not
  // planned: it would only hold a slot it can never take. It still walks the
  // loop below so its own deferral is recorded.
  const plannedTasks = filteredTasks.filter(t =>
    plannerModeOf(t) !== 'off' && !connectorMismatchTaskIds.has(t.id) && !roleEnvGaps.has(t.id));
  let plannerSignals: PlannerSignals = EMPTY_PLANNER_SIGNALS;
  if (plannedTasks.length > 0) {
    plannerSignals = await loadPlannerSignals(plannedTasks.map(t => t.id), [...new Set(plannedTasks.map(t => t.workspaceId))]);
  }
  /** One threshold set per plan: the planned workspaces' own, when they all agree; else declared scope only. */
  const plannerThresholdsFor = (ts: Array<{ workspaceId: string }>): PlannerThresholds | null => {
    const sets = [...new Set(ts.map(t => JSON.stringify(plannerConfigs.get(t.workspaceId)?.thresholds ?? null)))];
    return sets.length === 1 ? (JSON.parse(sets[0]) as PlannerThresholds | null) : null;
  };
  const planFor = (cands: typeof filteredTasks, claimed: unknown[], capacity: number) => {
    const ctx = buildClaimPlanInput({
      candidates: cands,
      openPrTasksByWorkspace,
      activePathClaimsByWorkspace,
      missionInFlightRows,
      claimedThisBatch: claimed,
      capacity,
      pressure: { dailyBudgetPct, oauthPressure: oauthPressure?.pct ?? null, confidence: oauthPressure?.confidence ?? null },
      thresholds: plannerThresholdsFor(cands),
      signals: plannerSignals,
    });
    return { ctx, plan: planClaimBatch(ctx.input) };
  };
  const singleWorkspaceOf = (ts: Array<{ workspaceId: string }>): string | null => {
    const ws = [...new Set(ts.map(t => t.workspaceId))];
    return ws.length === 1 ? ws[0] : null;
  };

  // 'record': the plan the planner would make right now, before anything is claimed.
  const recordTasks = plannedTasks.filter(t => plannerModeOf(t) === 'record');
  const recordPlan: ClaimPlan | null = recordTasks.length > 0 ? planFor(recordTasks, [], availableSlots).plan : null;

  // 'apply': claim order is produced lazily, one pick at a time, so each pick
  // is planned against what this batch has claimed so far.
  const applyTasks = plannedTasks.filter(t => plannerModeOf(t) === 'apply');
  const applyIds = new Set(applyTasks.map(t => t.id));
  const applyTaskById = new Map(applyTasks.map(t => [t.id, t]));
  const applyInitial = applyTasks.length > 0 ? planFor(applyTasks, [], availableSlots) : null;
  /** Predicted-scope tasks whose advisory_manifest mutex the planner's edges replace. */
  const plannerReplacesMutex = applyInitial ? plannerScopedTaskIds(applyInitial.ctx) : new Set<string>();
  const plannerAttempted = new Set<string>();
  const claimedTasksSoFar = () => claimedWorkers.map(w => w.task as unknown);
  function* plannedClaimOrder(): Generator<(typeof filteredTasks)[number]> {
    while (claimedWorkers.length < availableSlots) {
      const remaining = applyTasks.filter(t => !plannerAttempted.has(t.id));
      if (remaining.length === 0) break;
      const next = planFor(remaining, claimedTasksSoFar(), availableSlots - claimedWorkers.length).plan.picks[0];
      if (!next) break;
      plannerAttempted.add(next.id);
      yield applyTaskById.get(next.id)!;
    }
    // Everything the planner does not order walks as before, in the legacy order.
    for (const t of filteredTasks) if (!applyIds.has(t.id)) yield t;
  }
  const claimOrder: Iterable<(typeof filteredTasks)[number]> = applyTasks.length > 0 ? plannedClaimOrder() : filteredTasks;

  for (const task of claimOrder) {
    // Set only by a gated START that relaxed the open-PR overlap: these
    // declared paths are acquired exclusively right before the atomic claim.
    let gatedStartPaths: string[] | null = null;
    // Soft overlaps a force claim went past: recorded with its outcome as
    // calibration data (human force, not a model label).
    const softOverlapForced: Array<Record<string, unknown>> = [];
    // Soft overlaps a START went past (rule or Jev): recorded once the claim
    // wins, so the outcome join can grade a started pair and the dashboard can
    // say who decided.
    const softOverlapStarted: Array<Record<string, unknown>> = [];
    // Captured before any provider-toggle/budget-failover flip below can mutate
    // (task as any).backend, so the Codex single-flight check further down tests
    // what this task WAS ASSIGNED, not what it may have just been flipped to.
    // `tryFlipToCodex` already refuses to flip into a busy/already-flipped
    // workspace, so a flip-produced Codex task can never trip that check anyway —
    // this only needs to catch the task that was Codex from creation and so never
    // goes through `tryFlipToCodex` at all.
    const taskOriginallyCodex = (task as any).backend === 'codex';

    // Skip tasks whose required connectors are not available in the claiming workspace.
    // connectorMismatchTaskIds is populated by the pre-filter block above.
    if (connectorMismatchTaskIds.has(task.id)) { deferTask(task, 'connector_mismatch'); continue; }
    const roleEnvGap = roleEnvGaps.get(task.id);
    if (roleEnvGap) { deferTask(task, 'role_env_unsatisfied', { roleSlug: roleEnvGap.roleSlug, missing: roleEnvGap.missing }); continue; }

    // Subject-liveness in-loop guard (defense-in-depth for race between the SQL
    // prefilter and per-task processing). The SQL condition above should already
    // exclude reconciled tasks, but a concurrent reconciliation sweep might have
    // run between the initial query and this point. Same contract as the SQL
    // predicate (lib/subject-gate-contract.ts) — subjectAnchor and context must
    // be selected for it to see the anchor's source and the bypass flag; the
    // candidate query above selects every task column.
    // The named task under an admin force claim skips the gates a person may
    // override; every other candidate in the batch is gated as usual.
    const forced = forceClaim && task.id === taskId;
    /** Forceable gate hit: record it as bypassed on a force claim, else defer. True = skip the task. */
    const bypassOrDefer = (reasonKey: keyof typeof deferrals, detail?: Record<string, unknown>): boolean => {
      if (forced) {
        if (!forceBypassed.includes(reasonKey)) forceBypassed.push(reasonKey);
        return false;
      }
      deferTask(task, reasonKey, detail);
      return true;
    };

    if (!subjectStillLive(task)) {
      console.log(`[claim] task ${task.id} ${forced ? 'force-claimed past' : 'skipped:'} subject PR reconciled (dead)`);
      if (bypassOrDefer('subject_dead')) continue;
    }

    // One open retry per subject: a fix attempt whose retry family already has
    // another open attempt (an older one, or a newer one already running) is
    // cancelled here, never started beside it — two live siblings is how one
    // lineage forked into two PRs. Not forceable: the cancel is the decision.
    if ((task as any).taskClass === 'attempt' && (await guardClaimedRetry(task as any))) {
      console.log(`[claim] task ${task.id} cancelled: another fix attempt in its retry family is open`);
      deferTask(task, 'sibling_retry_open');
      continue;
    }

    // Allow tasks to declare a longer timeout via context.timeoutMinutes (max 240 min / 4 hours)
    const taskContext = task.context as Record<string, unknown> | null;
    // Backend is pinned by the task creator — must not flip it for any reason.
    const backendPinned = isBackendPinned(taskContext);

    // Path-overlap backstop (layer 1): if this task declares a pathManifest and
    // any open PR in the same workspace comes from a task with an overlapping
    // manifest, defer this claim. Prevents two tasks editing the same file in
    // parallel when the orchestrator forgot to serialize them with dependsOn edges.
    // (Regression guard for the PRs #1126/#1129 incident.)
    //
    // Exception: fix attempts are exempt from blocking on their own PR.
    // Conflict, review and CI fix attempts all copy the original's pathManifest
    // and resume on the PR's branch, so that PR always overlaps — it is the
    // thing being fixed, not a concurrent edit. Exempting only conflict retries
    // stranded every review/CI fix behind the PR it was dispatched to fix.
    // Likewise a task never blocks on a PR its own earlier worker opened: a
    // loopUntilMerged parent re-queues while that PR is open and carries no
    // *RetryPrNumber, so it deferred behind itself forever.
    //
    // Same reasoning extends to a task whose subject anchor names a PR (e.g.
    // "rebase and land PR #1737", or a system/context-supplied prNumber) — see
    // docs/design/task-subject-anchors.md. Its whole job is to take over that
    // PR's files, so an overlap with exactly that PR is the task, not a
    // conflict with it. Unlike subjectLivenessCondition() (subject-gate-
    // contract.ts), this does not require a binding source: widening
    // claimability is safe even off a title-derived anchor, since (unlike the
    // liveness gate) getting it wrong here never makes a task mortal — worst
    // case it still blocks on any *other* overlapping PR below.
    //
    // Each of those exemptions also covers PRs stacked on the exempt PR (base
    // ref = its branch, transitively). In a stacked mission chain Step D is
    // based on Step C's branch, so D's diff carries all of C's files; a review
    // fix for C deferred behind D on every round, overlapping only C's own work.
    const taskManifest = (task as any).pathManifest as string[] | null;
    if (taskManifest?.length) {
      const openPrTasks = openPrTasksByWorkspace.get(task.workspaceId) ?? [];
      // Own PRs (its earlier worker's, the PR a fix attempt fixes, its subject
      // PR) and PRs stacked on them never block it — see splitOwnOpenPrs.
      // A PR into a different landing base (a trunk → mission refresh, for a
      // trunk-bound task) changes nothing this task lands on — see
      // ./open-pr-target-base.
      const taskMission = (task as any).missionId ? missionClaimMap.get((task as any).missionId) : null;
      const trunk = workspaceTrunk(task.workspace?.gitConfig);
      const filterOpenPrTasks = partitionOpenPrsByLandingBase(
        { base: candidateLandingBase({ task: task as any, mission: taskMission, trunk }), trunk, manifest: taskManifest },
        splitOwnOpenPrs(task, openPrTasks).others,
      ).sameBase;
      const blocking = findBlockingPr(taskManifest, filterOpenPrTasks);
      // Note the deferral (no I/O). An applied gated START for this exact
      // state relaxes ONLY this layer; layer 2 and every
      // later gate still run, and the paths are acquired exclusively below.
      const holdCtx = blocking && !forced ? holdStartContext(task, forced) : null;
      // The collector is synchronous and does no I/O, so what it needs is read
      // here: each overlapping holder's current PR diff, and (for a candidate
      // that already has a branch) the newest probe of that pair. A read that
      // fails or times out is absent, which leaves the answer with Jev.
      const holdEvidence = holdCtx
        ? await readOpenPrRiskEvidence(task, taskManifest, filterOpenPrTasks, splitOwnOpenPrs(task, openPrTasks).own)
        : {};
      const holdNote = holdCtx ? holdStart.noteOpenPrOverlap(holdCtx, taskManifest, filterOpenPrTasks, activePathClaimsByWorkspace.get(task.workspaceId), holdEvidence) : null;
      const openPrVerdict = blocking && holdNote ? await openPrStartVerdict(holdNote, holdStartGated) : 'HOLD';
      if (blocking && openPrVerdict !== 'HOLD') {
        console.log(`[claim] ${openPrVerdict === 'rule_start' ? 'rule_start' : 'gated_start'}: task ${task.id} past open-PR overlap (PR #${blocking.prNumber ?? blocking.prUrl}); acquiring its paths`);
        gatedStartPaths = holdNote!.candidate.concretePaths;
      } else if (blocking) {
        console.log(`[claim] path_overlap_blocked: task ${task.id} deferred (manifest overlaps PR #${blocking.prNumber ?? blocking.prUrl})`);
        const blockedByPr = { prNumber: blocking.prNumber ?? null, prUrl: blocking.prUrl ?? null };
        firstBlockingPr ??= blockedByPr;
        const blockingEntry = filterOpenPrTasks.find(
          t => (t.prNumber ?? null) === blockedByPr.prNumber && (t.prUrl ?? null) === blockedByPr.prUrl,
        );
        if (task.id === taskId && !forced) {
          const overlapPaths = intersectPaths(taskManifest, blockingEntry?.pathManifest ?? []);
          const prLabel = blockedByPr.prNumber ? `#${blockedByPr.prNumber}` : (blockedByPr.prUrl ?? 'an open PR');
          explicitTaskExclusion = {
            code: 'path_overlap',
            detail: `Its files overlap open PR ${prLabel}${overlapPaths.length ? ` (${overlapPaths.join(', ')})` : ''}. Wait for it to merge, or rebase onto it.`,
          };
        }
        if (bypassOrDefer('path_overlap', blockedByPr)) {
          // The blocker's own manifest paths, which its terminal release wakes.
          noteDeferralWaiter(task.workspaceId, task.id, blockingEntry?.taskId,
            intersectPaths(blockingEntry?.pathManifest ?? [], taskManifest));
          continue;
        }
      }

      // Path-overlap backstop (layer 2): also check active path_claims rows.
      // This catches tasks that are running but haven't opened a PR yet — the
      // window between task start and PR open where layer 1 would miss them.
      //
      // The sentinel is stripped rather than treated as a veto on the whole
      // check: a manifest of ['**', 'a.ts'] used to skip layer 2 entirely and
      // therefore ignored a genuine held lock on a.ts. '**' says "scope not
      // fully declared", which is no reason to discard the parts that ARE
      // declared. A manifest (or claim) that is *only* the sentinel has no
      // concrete paths left and stays advisory.
      const concreteManifest = taskManifest.filter(p => p !== REPO_WIDE_SENTINEL);
      if (concreteManifest.length > 0) {
        const activeClaims = activePathClaimsByWorkspace.get(task.workspaceId);
        if (activeClaims) {
          let blockedByActiveClaim = false;
          for (const [claimingTaskId, claimedPaths] of activeClaims) {
            if (claimingTaskId === task.id) continue; // own claims never block self
            const concreteClaimed = claimedPaths.filter(p => p !== REPO_WIDE_SENTINEL);
            if (concreteClaimed.length === 0) continue; // advisory-only claim
            if (pathsOverlap(concreteManifest, concreteClaimed)) {
              console.log(`[claim] path_claim_blocked: task ${task.id} deferred (manifest overlaps active claim held by task ${claimingTaskId})`);
              const overlapPaths = intersectPaths(concreteManifest, concreteClaimed);
              if (task.id === taskId && !forced) {
                explicitTaskExclusion = {
                  code: 'path_overlap',
                  detail: `Its files overlap an active claim held by task ${claimingTaskId}${overlapPaths.length ? ` (${overlapPaths.join(', ')})` : ''}. Wait for that task to finish, or rebase onto its work.`,
                };
              }
              // prNumber/prUrl: null so a coalesced row does not keep naming a
              // PR from an earlier layer-1 deferral as the current blocker.
              blockedByActiveClaim = bypassOrDefer('path_overlap', { blockingTaskId: claimingTaskId, prNumber: null, prUrl: null });
              // The holder's lease paths, so a narrowing that gives one back
              // wakes this task too (narrow matches waiters by exact path).
              if (blockedByActiveClaim) {
                noteDeferralWaiter(task.workspaceId, task.id, claimingTaskId, intersectPaths(concreteClaimed, concreteManifest));
              }
              break;
            }
          }
          if (blockedByActiveClaim) continue;
        }
      }

      // Soft overlap (./soft-overlap-gate): an in-flight task whose declared
      // scope overlaps this one's on the same file or by directory prefix, or a
      // pre-v2 inferred edge. Never a dependsOn edge. A migration / hard-surface
      // (serialized, generated, hotspot) / unknown-state entry holds
      // deterministically. The rest is tiered (orchestration-claim-risk): a
      // holder that never started, or a directory-only overlap, starts in code
      // (`rule_start`); a same-file one holds unless an applied Jev START
      // exists for this exact state. Either START's declared paths are then
      // acquired exclusively before the claim (a live lease wins). Forced:
      // bypassed and recorded.
      const softVerdicts = softHolderIds.size > 0
        ? evaluateSoftOverlaps(task as any, softHolders, {
            isHardSurface: (paths, kind) => touchesHardOverlapSurface(paths, kind, (task as any).workspace?.gitConfig ?? null),
          })
        : [];
      let softHeld = false;
      for (const v of softVerdicts) {
        // The rule's verdict: deterministic for a hard overlap, HOLD for a
        // same-file or prefix one until an applied Jev START says otherwise.
        let verdict: 'deterministic_hold' | 'HOLD' | 'START' | 'rule_start' = v.kind === 'deterministic' ? 'deterministic_hold' : 'HOLD';
        let risk: { tier: string; rationale: string; reasons: string[]; reevaluateOn: string[] } | null =
          v.kind === 'deterministic' ? { tier: 'hard', rationale: `Held: ${v.overlapKind.replace('_', ' ')} overlap.`, reasons: [v.overlapKind], reevaluateOn: ['holder_terminal'] } : null;
        if (v.kind === 'advisory' && !forced) {
          const holdCtx = holdStartContext(task, forced);
          const candidateBranch = splitOwnOpenPrs(task, openPrTasksByWorkspace.get(task.workspaceId) ?? []).own.find(p => p.branch)?.branch ?? null;
          const probe = holdCtx && candidateBranch
            ? await loadPairProbeEvidence({ workspaceId: task.workspaceId, candidate: { branch: candidateBranch }, holder: { taskId: v.holderTaskId } })
            : null;
          const assessed = holdCtx
            ? holdStart.assessSoftOverlap(holdCtx, taskManifest, { taskId: v.holderTaskId, overlapPaths: v.paths, overlapKind: v.overlapKind, workerStatus: v.workerStatus }, activePathClaimsByWorkspace.get(task.workspaceId), { probe })
            : null;
          if (assessed) risk = assessed.risk;
          verdict = await softOverlapStartVerdict(assessed?.note ?? null, holdStartGated);
        }
        if (verdict === 'START' || verdict === 'rule_start') {
          console.log(`[claim] ${verdict === 'rule_start' ? 'rule_start' : 'gated_start'}: task ${task.id} past soft overlap with ${v.holderTaskId} (${risk?.tier ?? 'unknown'}); acquiring its paths`);
          gatedStartPaths = concreteManifest;
          softOverlapStarted.push({
            holderTaskId: v.holderTaskId,
            paths: v.paths.slice(0, 10),
            overlapKind: v.overlapKind,
            decidedBy: verdict === 'rule_start' ? 'rule' : 'jev',
            riskTier: risk?.tier ?? null,
            reasons: risk?.reasons.slice(0, 4) ?? [],
          });
          continue;
        }
        const detail = {
          holderTaskId: v.holderTaskId,
          paths: v.paths.slice(0, 10),
          verdict,
          overlapKind: v.overlapKind,
          // The tier and why, for explain/the dashboard; what would change it.
          ...(risk ? { riskTier: risk.tier, rationale: risk.rationale, reevaluateOn: risk.reevaluateOn } : {}),
        };
        if (forced) {
          softOverlapForced.push(detail);
          bypassOrDefer('soft_overlap', detail);
          continue;
        }
        console.log(`[claim] soft_overlap_held: task ${task.id} deferred behind ${v.holderTaskId} (${verdict})`);
        bypassOrDefer('soft_overlap', detail);
        noteDeferralWaiter(task.workspaceId, task.id, v.holderTaskId, v.paths);
        softHeld = true;
        break;
      }
      if (softHeld) continue;
    }

    // ── Mission-level gates ──────────────────────────────────────────────────────
    // Applied before workspace concurrency and model routing (cheap short-circuits).
    const taskMissionId = (task as any).missionId as string | null;
    // Reviews read a diff and post a verdict; they are not mission work. They
    // keep the budget gate below and every workspace/account cap further down,
    // but skip the mission's concurrency cap and pacing interval, and never
    // consume either (see the post-claim bookkeeping). Gating them made
    // reviews start long after their PR opened, in bursts — widening the
    // window in which a PR can merge with no verdict. Only reviewer-dispatched
    // rows qualify: any task creator can set `category: 'review'`.
    const isReviewTask = isDispatchedReview((task as any).category, (task as any).context);
    if (taskMissionId) {
      const missionData = missionClaimMap.get(taskMissionId);
      if (missionData) {
        // 1. Budget exhausted: never claim new tasks from an exhausted mission.
        //    Already-running workers are unaffected (they were claimed earlier).
        // A one-way door: nothing clears budget_exhausted except a human raising
        // costBudgetUsd, and it strands EVERY task in the mission at once. The
        // operator override (/start with forceOverride → context.bypassMissionBudget)
        // releases a single task without resuming the whole mission.
        if (
          missionData.status === 'budget_exhausted'
          && !hasBypassFlag(taskContext, BYPASS_MISSION_BUDGET_KEY)
        ) {
          console.log(`[claim] task ${task.id} skipped: mission ${taskMissionId} budget_exhausted`);
          deferTask(task, 'mission_budget', { missionId: taskMissionId });
          continue;
        }

        // 2. Mission-level concurrency cap. Enforces missions.maxConcurrentTasks, which
        //    previously existed in the schema but was never read by the claim loop.
        //    Review tasks are exempt (isReviewTask above) and are not counted.
        const concurrencyBlock = !isReviewTask && checkMissionConcurrencyGate(
          missionData.maxConcurrentTasks,
          missionActiveCountMap.get(taskMissionId) ?? 0,
        );
        if (concurrencyBlock) {
          console.log(`[claim] task ${task.id} deferred: mission ${taskMissionId} at concurrency cap (${concurrencyBlock.active}/${concurrencyBlock.cap})`);
          if (bypassOrDefer('mission_concurrent', { missionId: taskMissionId, active: concurrencyBlock.active, cap: concurrencyBlock.cap })) continue;
        }

        // 3. Pacing gate: paced missions enforce a minimum interval between task starts.
        //    Skipping is cheap — the task stays pending and is eligible on the next poll.
        //    Review tasks are exempt and never stamp lastTaskStartedAt.
        const pacingBlock = !isReviewTask && checkMissionPacingGate(missionData, now);
        if (pacingBlock) {
          console.log(
            `[claim] task ${task.id} deferred: mission ${taskMissionId} paced ` +
            `(next eligible ${pacingBlock.nextEligibleAt.toISOString()}, ` +
            `interval ${pacingBlock.intervalSec}s, elapsed ${Math.round(pacingBlock.elapsedSec)}s)`,
          );
          if (bypassOrDefer('mission_paced', { missionId: taskMissionId, nextEligibleAt: pacingBlock.nextEligibleAt.toISOString() })) continue;
        }

        // 4. Advisory-manifest serialization (compensating guard).
        //    An undeclared scope — null, [], or '**' (declaresNoScope) — no
        //    longer mints stored dependsOn edges (correct — those edges block
        //    until completed+merged, which is not what a file conflict needs),
        //    and neither path-overlap layer can help: layer 1 returns null for a
        //    wildcard candidate, and layer 2 is nested inside
        //    `if (taskManifest?.length)` and compares *this* task's concrete
        //    paths — of which a scope-undeclared task has none, whatever leases
        //    the other side holds. Two scope-undeclared tasks in one mission
        //    would therefore edit the same files concurrently and ping-pong
        //    conflict retries — the exact failure mode the ['**'] default was
        //    introduced to stop.
        //
        //    Auto-leasing observed touches (PATCH /api/workers/[id] →
        //    claimObservedPaths) does not retire this guard. It fills layer 2's
        //    supply side, so a task that DID declare paths is now deferred on a
        //    file a live worker is actually editing. It cannot help here,
        //    because the deferral this guard makes is decided by the *candidate*
        //    having nothing to compare, and because a lease only exists after
        //    the holder's first sync — this gate runs before either task starts.
        //
        //    So: at most one scope-undeclared task per mission in flight. This
        //    is a SOFT deferral — the task stays pending and is retried on the
        //    next poll (seconds), never a stored edge (which would wait for
        //    completed + PR merged). Mission-scoped, so it cannot reintroduce
        //    workspace-wide serialization.
        //
        //    The in-flight set includes `waiting_input` workers (same statuses
        //    the mission concurrency count uses): that worker's worktree still
        //    holds uncommitted edits, so treating it as free would reintroduce
        //    the conflict. Cost: a mission's other scope-undeclared tasks wait
        //    on a parked question — visible as the advisory_manifest deferral
        //    counter and as the parked task's own "Needs Input" state.
        //
        //    `category: 'review'` candidates skip this gate entirely: a
        //    reviewer never edits files, so it cannot conflict with whatever
        //    the mission's in-flight scope-undeclared occupant is doing, and
        //    gating it here just adds a second review-starvation failure mode
        //    on top of the one already fixed above (an orchestration task
        //    holding the slot would otherwise block every reviewer forever).
        //
        //    `artifact_required` / `none` candidates skip it too, and never
        //    occupy the slot: their deliverable is not a code change, so they
        //    have no files to collide on. Without this a research task filed
        //    without a manifest (there is no way to add one after creation)
        //    waited behind any unrelated '**' task in the mission.
        //    Under the planner's 'apply', a task with a confident predicted
        //    scope (plannerReplacesMutex) was already ordered by real edges
        //    against that scope, so the mutex no longer applies to it.
        //    `localMissionClaim` (verified interactive session, explicit
        //    taskId, mission.executor='local' — same predicate as the role
        //    gate exemption above) also skips it: a person running a local
        //    mission's tasks from their own session is the one choosing what
        //    to claim next, in an isolated worktree per task, same as the
        //    LX-2/LX-4 exemptions already granted to the mission-local and
        //    role gates. This is narrower than an admin force claim — which
        //    still does NOT lift this gate (see the force-claim comment
        //    block and its regression test) — because force alone carries no
        //    guarantee a human is actually supervising concurrent work.
        if ((task as any).category !== 'review' && !producesNoFileEdits((task as any).outputRequirement)
          && declaresNoScope(taskManifest) && !plannerReplacesMutex.has(task.id) && !localMissionClaim) {
          const advisoryPeers = missionAdvisoryInFlight.get(taskMissionId);
          const blockingPeer = advisoryPeers
            ? [...advisoryPeers].find(id => id !== task.id)
            : undefined;
          // Noted like layer 1 above. An applied gated START relaxes
          // only this serialization; there are no declared paths to acquire,
          // and observed touches are leased by the exclusive primitive later.
          const holdCtx = blockingPeer ? holdStartContext(task, forced) : null;
          const holdNote = holdCtx && blockingPeer ? holdStart.noteAdvisoryManifest(holdCtx, blockingPeer) : null;
          if (blockingPeer && holdStartGated && holdNote && await gatedStartApplies(holdNote)) {
            console.log(`[claim] gated_start: task ${task.id} past advisory_manifest serialization (peer ${blockingPeer})`);
          } else if (blockingPeer) {
            console.log(
              `[claim] advisory_manifest_serialized: task ${task.id} deferred ` +
              `(mission ${taskMissionId} already has scope-undeclared task ${blockingPeer} in flight)`,
            );
            deferTask(task, 'advisory_manifest', { missionId: taskMissionId, blockingPeer });
            continue;
          }
        }
      }
    }

    // Per-repo concurrency cap (repo-backed workspaces only — repo-less ones are not
    // serialized). Each task is worktree-isolated, so the cap only bounds how many
    // branches run in parallel on one repo.
    // capExempt=true in context allows one-time bypass (set by /start with capExempt flag).
    // A mission may raise the effective cap above the workspace default; use the same
    // GREATEST logic as the SQL prefilter so in-batch behaviour is consistent.
    const isCapExempt = hasBypassFlag(taskContext, CAP_EXEMPT_KEY);
    const taskWorkspace = (task as any).workspace as { repo?: string | null; maxConcurrentTasks?: number | null } | undefined;
    if (taskWorkspace?.repo && !isCapExempt) {
      const workspaceCap = taskWorkspace.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS;
      const missionCap = taskMissionId ? (missionClaimMap.get(taskMissionId)?.maxConcurrentTasks ?? 0) : 0;
      const cap = Math.max(workspaceCap, missionCap);
      if ((activeByWorkspace.get(task.workspaceId) || 0) >= cap) {
        if (bypassOrDefer('workspace_cap', { active: activeByWorkspace.get(task.workspaceId) || 0, cap })) continue;
      }
    }

    // Commercial entitlement: Buildd-managed runner keys only (packages/shared/
    // src/entitlements.ts). A self-hosted runner never gets here, and the
    // operational caps above stay as they are. Not forceable and not an error:
    // the task stays pending with the block stamped on it for the dashboard,
    // and a managed run ending (or the hourly sweep) wakes it.
    if (account.managedRunner) {
      const entitlementTeamId = (task as any).workspace?.teamId as string | undefined;
      if (entitlementTeamId) {
        const block = await checkManagedRunnerEntitlement(entitlementTeamId, {
          claimedInBatch: managedClaimedByTeam.get(entitlementTeamId) ?? 0,
          now,
        });
        if (block) {
          deferTask(task, entitlementDeferralKey(block), { ...block });
          await stampEntitlementBlock(task.id, block, now);
          continue;
        }
      }
    }

    // Hosted runner allowance (teams.hostedRunnerHours, counted hours this
    // month): cloud claims only, and only when the team has one. A host
    // runner may still take the task. Same queued-not-failed treatment as the
    // managed entitlement above; the hourly sweep wakes it once the month
    // resets or the allowance grows. Running tasks are never touched.
    if (cloudExecutor) {
      const hostedTeamId = (task as any).workspace?.teamId as string | undefined;
      if (hostedTeamId) {
        if (!hostedAllowanceByTeam.has(hostedTeamId)) {
          hostedAllowanceByTeam.set(hostedTeamId, await checkHostedRunnerAllowance(hostedTeamId, { now }).catch((err) => {
            console.error(`[claim] hosted runner allowance check failed for team ${hostedTeamId}:`, err);
            return null;
          }));
        }
        const block = hostedAllowanceByTeam.get(hostedTeamId) ?? null;
        if (block) {
          deferTask(task, entitlementDeferralKey(block), { ...block });
          await stampEntitlementBlock(task.id, block, now);
          continue;
        }
      }
    }

    // Team provider toggle (reversible mask) — applied BEFORE budget logic so the
    // rest sees the effective backend. Disabling a provider here redirects matching
    // jobs to an enabled one at dispatch time, without touching stored settings;
    // re-enabling restores them automatically. See packages/core/backend-policy.ts.
    // A task whose creator named its backend is never moved (backendPinned).
    const taskTeamId = (task as any).workspace?.teamId as string | undefined;
    const enabledBackends = await teamEnabledBackends(taskTeamId);
    const codexEnabledForTeam = !enabledBackends || enabledBackends.includes('codex');
    const maskedBackend = maskBackend((task as any).backend as AgentBackend, enabledBackends);
    if (!backendPinned && maskedBackend !== (task as any).backend) {
      if (maskedBackend === 'codex') {
        // Claude disabled team-wide → must run on Codex. Skip (leave pending) if
        // Codex has no credential or its single per-workspace slot is taken.
        if (!(await tryFlipToCodex(task, taskTeamId, task.workspaceId, 'claude_disabled'))) { deferTask(task, 'provider_unavailable', { attemptedBackend: 'codex' }); continue; }
        console.log(`[claim] Provider toggle: task ${task.id} → Codex (Claude disabled for team ${taskTeamId})`);
      } else {
        // Codex disabled team-wide → run on Claude.
        noteRouting(task, (task as any).backend, 'claude', 'codex_disabled');
        (task as any).backend = 'claude';
        console.log(`[claim] Provider toggle: task ${task.id} → Claude (Codex disabled for team ${taskTeamId})`);
      }
    } else if (backendPinned && maskedBackend !== (task as any).backend) {
      // Backend is pinned by task creator. Team provider toggle is not applied to pinned backends.
      // The backend is deferred to let it wait for its intended provider to become available.
      deferTask(task, 'provider_unavailable', { backend: (task as any).backend, reason: 'pinned' });
      continue;
    }

    // Is the CLAUDE pool walled right now? Computed for every task, not just
    // Claude ones: a Codex task that hits its own wall needs to know whether
    // Claude is a viable escape (and vice versa). Each provider has its own pool.
    const tenantCtx = (taskContext?.tenantContext as { tenantId?: string }) || null;
    const claudeEnabledForTeam = !enabledBackends || enabledBackends.includes('claude');
    let claudePoolBlocked = false;

    if (accountBudgetExhausted && !tenantCtx?.tenantId && !interactiveSession && !taskId) {
      // Account's own OAuth session/budget is exhausted. Interactive sessions
      // have their own credentials and do not consume this account budget.
      // Explicit taskId claims bypass the budget check (same exemption as pacing).
      claudePoolBlocked = true;
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
            claudePoolBlocked = true;
          }
        }
      }
    }
    // Walls recorded against Claude in the pause log (e.g. a team running on a
    // managed Claude credential rather than this account's own session).
    // An interactive session is exempt for the same reason as the account flag
    // above: the wall was hit by a runner's seat, and the session runs the task
    // on its own credentials. Without this, a task whose runner just died on a
    // session limit could not be claimed (even with force) until the reset.
    const pauses = interactiveSession ? new Map<AgentBackend, ActivePause>() : await teamPauses(taskTeamId);
    if (pauses.has('claude')) claudePoolBlocked = true;

    // Does a Claude run of THIS task draw on that walled pool? Only when its
    // model route is the OAuth seat (./claude-model-route): a task the team
    // agent endpoint, a metered Anthropic key, the runner's own provider or
    // cloud egress carries spends that budget, not the seat's. A tenant task
    // runs on its tenant's own seat, whose wall is the tenant budget above.
    // Resolved lazily — only a walled pool or an active seat cap needs it.
    const isTenantTask = !!tenantCtx?.tenantId;
    const claudeRunUsesSeat = async (): Promise<boolean> =>
      isTenantTask || routeUsesOauthSeat(await claudeRouteFor(taskTeamId, task.workspaceId));

    // Codex wall → escape to Claude while its pool is open, rather than claiming
    // onto a provider that will immediately report a rate-limit. A task pinned
    // to Codex is never moved: it waits for its own reset.
    if ((task as any).backend === 'codex' && pauses.has('codex')) {
      if (!backendPinned && claudeEnabledForTeam && (!claudePoolBlocked || !(await claudeRunUsesSeat()))) {
        noteRouting(task, 'codex', 'claude', 'codex_rate_limited');
        (task as any).backend = 'claude';
        console.log(`[claim] Budget failover: routing task ${task.id} to Claude (Codex rate-limited until ${pauses.get('codex')!.resetsAt.toISOString()})`);
      } else {
        deferTask(task, 'budget_paused', {
          backend: 'codex', resetsAt: pauses.get('codex')!.resetsAt.toISOString(),
          ...(backendPinned ? { pinned: true } : {}),
        });
        continue;
      }
    }

    const isCodexTask = (task as any).backend === 'codex';

    // Codex single-flight (≤1 Codex worker per workspace): a task that was
    // already assigned backend='codex' at creation time never goes through
    // `tryFlipToCodex` (that guard only runs for a flip decision), so without
    // this check it sailed straight through to the atomic claim below and the
    // constraint was only discovered after a worker had already started —
    // enforced by killing it (see the runner's startFromClaim single-flight
    // check, kept as a race backstop for two concurrent claim requests this
    // in-batch check can't see). Deferring here means the task stays pending
    // and is retried on a later poll once the workspace's one Codex slot
    // frees, at zero worker cost. codexBusyWorkspaces also picks up a Codex
    // task claimed earlier in THIS batch (see the post-claim bookkeeping
    // below), so two originally-Codex tasks for the same workspace in one
    // poll don't both get claimed.
    if (
      taskOriginallyCodex &&
      isCodexTask && // still resolved to Codex — the toggle/wall reroutes above may have moved it to Claude
      (codexBusyWorkspaces.has(task.workspaceId) || codexFlippedWorkspaces.has(task.workspaceId))
    ) {
      deferTask(task, 'codex_single_flight', { workspaceId: task.workspaceId });
      continue;
    }

    // Seat-bound: this Claude run spends the walled pool. Computed BEFORE the
    // failover so a task on another route is never blocked, flipped or deferred.
    const claudeBudgetBlocked = !isCodexTask && claudePoolBlocked && await claudeRunUsesSeat();

    // Proactive budget failover: rather than skip a Claude task until the session/
    // budget resets, route it to Codex *now* when (a) the runner will have Codex
    // auth and (b) no Codex worker is already active there (≤1 per workspace).
    // The flip is in-memory only — scoped to this run, not a permanent backend change.
    // Tasks we can't fail over are left pending and retried on reset / when Codex frees.
    if (claudeBudgetBlocked) {
      // Only fail over to Codex if the task did not ask for Claude explicitly and
      // the team toggle allows it; otherwise leave it pending until the reset.
      if (!backendPinned && codexEnabledForTeam && await tryFlipToCodex(task, taskTeamId, task.workspaceId, 'claude_seat_exhausted')) {
        console.log(`[claim] Budget failover: routing task ${task.id} to Codex (workspace ${task.workspaceId} Claude budget exhausted)`);
      } else {
        deferTask(task, 'budget_paused', { backend: 'claude', ...(backendPinned ? { pinned: true } : {}) });
        continue;
      }
    }

    // Learned OAuth pressure narrows the seat's Claude parallelism (see above).
    // Codex, tenant work and non-seat Claude routes draw on other pools, so they
    // are never held by it. Read the backend fresh: `isCodexTask` was captured
    // before the budget failover above, which may just have flipped this task to Codex.
    const usesOauthSeat = (task as any).backend !== 'codex' && !isTenantTask
      && (oauthSeatSlotsLeft === null || await claudeRunUsesSeat());
    if (usesOauthSeat && oauthSeatSlotsLeft !== null && oauthSeatSlotsLeft <= 0) {
      deferTask(task, 'oauth_parallelism', { pct: oauthPressure?.pct ?? null });
      continue;
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
      if (task.id === taskId) {
        explicitTaskExclusion = {
          code: 'workspace_mismatch',
          detail: `The task is pinned to project "${taskProject}", which this workspace does not have, so it was failed. Check the workspace the MCP session is connected to.`,
        };
      }

      // TERMINAL write → must run the same post-terminal resolution every other
      // terminal writer runs (lib/stale-workers.ts, workers/[id] completion,
      // interrupt, tasks/cleanup). Without it cascadeDependencyFailure never
      // fires and every task depending on this one stays pending forever:
      // 'failed' is not in DEP_SATISFYING_STATUSES, so the dep gate blocks the
      // dependents behind a task that can never complete.
      // Awaited (dependents must be consistent before we answer) but non-fatal:
      // one bad cascade must not abort the rest of the claim batch.
      try {
        await resolveCompletedTask(task.id, task.workspaceId);
      } catch (err) {
        console.error(`[claim] dependency cascade failed for workspace-mismatched task ${task.id}:`, err);
      }
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
    // Only a caller PIN counts as explicit — not the model a previous claim of
    // this task wrote into context.model (a requeue keeps it). See model-pin.ts.
    const explicit = readModelPin(taskContext);
    const taskTier = (task as any).tier as RegistryTier | null | undefined;
    const roleRow = pickRoleRowForTask(roleModelRows, {
      roleSlug, workspaceId: task.workspaceId, teamId: taskTeamId,
    });
    // Precedence: pin → tasks.tier → role exact id → matrix + role floor. An
    // inferred role never touches the model (role-routing.md §4.1).
    const { roleModel, explicitModel, routerRoleFloor, roleTierOverride } = resolveClaimModelInputs({
      pin: explicit,
      taskTier,
      roleModel: roleRow ? (roleRow.model ?? 'inherit') : null,
      roleInferred: taskContext?.roleInferred != null,
    });

    const routingDecision = resolveEffectiveModel({
      explicitModel,
      kind: (task as any).kind || null,
      complexity: (task as any).complexity || null,
      roleFloor: routerRoleFloor,
      dailyBudgetPct,
      recentClaimCount,
      priority: task.priority ?? 0,
    });

    if (routingDecision.model === 'paused') {
      // Budget-pressure pause — leave the task pending for next cycle.
      deferTask(task, 'routing_paused');
      continue;
    }

    // Model-routing experiment (docs/design/model-routing-experiment.md). Null —
    // and a no-op below — unless the team has a `running` experiment row and
    // this task is eligible or inherits an arm. Never throws, never defers.
    const experimentDraw = await drawModelRoutingArm({
      teamId: taskTeamId, task: task as any, explicitModel: explicit, routerReason: routingDecision.reason,
      routerModel: routingDecision.model, roleModel, budgetPressure: dailyBudgetPct,
    });

    // Resolve the concrete model ID through the model policy (the team's tier
    // registry is its document — packages/core/model-policy.ts).
    // - exact-id pin: the escape hatch; bypass tier resolution, pass the full
    //   ID to the runner as-is.
    // - shorthand pin (`opus`/`sonnet`/`haiku`): a tier request, resolved like
    //   any tier so the policy decides which model that is.
    // - tier path: task.tier → router alias → policy → full model ID.
    // taskTeamId already defined above (line ~619)
    const pinTier = shorthandPinTier(explicitModel);
    let resolvedModel: string;
    let resolvedTierMeta: { tier: string; provider: string; source?: string; policy?: TierPolicyMeta } | undefined;
    let poolDraw: AgentPoolDraw | null = null;
    // Where `resolvedModel` came from, and the tier entry a rejected model falls
    // back to. The catalog is read once per claim (cached in-process and in
    // system_cache); empty means unknown and the guard fails open.
    let modelSource: DispatchModelSource = 'pin';
    let tierEntryModel: { model: string; source: DispatchModelSource } | null = null;
    let guardTier: RegistryTier = tierForModelId(routingDecision.model);
    const modelRejections: Omit<DispatchModelRejection, 'fallback'>[] = [];
    const runnerCliVersion = body.environment?.claudeCliVersion;
    const dispatchCatalog = await getCachedOpenRouterCatalog();
    // Central certification (model-certification.ts): floors learned by the
    // probe, so a model certified after this build shipped is served and gated
    // like one in the static table. Empty on any failure: the static table only.
    const certifications = await getModelCertifications();
    // A challenger or treatment the runner cannot launch is not served; the
    // incumbent is. Same fallback accounting as a CLI-floor miss, plus a record
    // of the id so a bad arm cannot go on silently losing its draws.
    const clientCanServe = (source: DispatchModelSource) => (m: string): boolean => {
      if (!checkModelClientCapability(m, runnerCliVersion, certifications).ok) return false;
      const verdict = checkDispatchModel(m, dispatchCatalog, certifications);
      if (!verdict.ok) modelRejections.push({ rejected: m, reason: verdict.reason, source });
      return verdict.ok;
    };
    const tierModelSource = (s: string | undefined): DispatchModelSource =>
      s === 'catalog' ? 'tier_catalog' : s === 'default' ? 'tier_default' : 'tier_row';

    if (routingDecision.reason === 'explicit_override' && !pinTier) {
      resolvedModel = routingDecision.model;
    } else {
      // Determine the tier to look up: a shorthand pin, then task.tier, then a
      // premium-plus role floor (above the router's opus ceiling), then the
      // router alias.
      const derivedTier = pinTier ?? taskTier ?? roleTierOverride ?? mapRouterAlias(routingDecision.model);
      guardTier = derivedTier;

      if (taskTeamId) {
        const entry = await resolveTierEntry(
          derivedTier,
          taskTeamId,
          task.workspaceId,
          'agent',
          runnerCliVersion,
        );
        resolvedModel = entry.model;
        resolvedTierMeta = { tier: derivedTier, provider: entry.provider, source: entry.source, ...(entry.policy ? { policy: entry.policy } : {}) };
        modelSource = tierModelSource(entry.source);
        tierEntryModel = { model: entry.model, source: modelSource };
        // A treatment or pool arm below replaces resolvedTierMeta without the
        // policy decision: that route is the experiment's, not the policy's.
        if (experimentDraw) {
          const treatment = await applyModelRoutingTreatment(experimentDraw, {
            controlModel: entry.model, routerReason: routingDecision.reason, taskTier, backend: task.backend,
            resolveTier: (t) => resolveTierEntry(t, taskTeamId, task.workspaceId, 'agent'),
            clientCanServe: clientCanServe('routing_experiment'),
          });
          if (treatment) {
            resolvedModel = treatment.model;
            resolvedTierMeta = { tier: treatment.tier, provider: treatment.provider, source: treatment.source };
            modelSource = 'routing_experiment';
          }
        }
        // Tier model pool (knowledge-base: buildd/design/tier-model-pools.md). Null, and a no-op,
        // unless the team has a split pool on this tier and the task is
        // eligible. A task in the model-routing experiment serves the
        // incumbent: one experiment per unit. Never throws, never defers.
        poolDraw = await drawAgentPoolArm({
          teamId: taskTeamId, tier: derivedTier, task: task as any,
          workspace: task.workspace as any, workspaceOverride: entry.source === 'workspace',
          explicitModel: explicit, roleModel, budgetPressure: dailyBudgetPct,
          inModelRoutingExperiment: !!experimentDraw,
        });
        if (poolDraw) {
          const served = applyAgentPoolArm(poolDraw, {
            incumbentModel: entry.model, backend: task.backend,
            clientCanServe: clientCanServe('tier_pool_arm'),
          });
          if (served) {
            resolvedModel = served.model;
            resolvedTierMeta = { tier: derivedTier, provider: served.provider, source: 'pool' };
            modelSource = 'tier_pool_arm';
          }
        }
      } else {
        // No team, so no registry: the policy's default layer still answers,
        // rather than handing the runner a bare router alias to interpret.
        const entry = await resolveTierEntry(derivedTier, null, task.workspaceId, 'agent', runnerCliVersion);
        resolvedModel = entry.model;
        resolvedTierMeta = { tier: derivedTier, provider: entry.provider, source: entry.source, ...(entry.policy ? { policy: entry.policy } : {}) };
        modelSource = tierModelSource(entry.source);
        tierEntryModel = { model: entry.model, source: modelSource };
      }
    }

    // Last line of defence: whatever source produced the id, do not launch a
    // worker with one the runner's Claude Code will reject at startup. That
    // worker dies before doing anything, its slot is released and the task goes
    // back to pending, so the runner looks idle while the queue is stranded.
    // Serve the tier entry (the workspace/team default) if it is itself fine,
    // else the tier's code-level default, and leave an error trace naming the
    // rejected id and where it came from.
    {
      let fallbacks = tierEntryModel ? [tierEntryModel] : [];
      if (!tierEntryModel && taskTeamId && !checkDispatchModel(resolvedModel, dispatchCatalog, certifications).ok) {
        // A rejected pin: fall back to the workspace default for its family.
        const entry = await resolveTierEntry(guardTier, taskTeamId, task.workspaceId, 'agent', runnerCliVersion);
        fallbacks = [{ model: entry.model, source: tierModelSource(entry.source) }];
        resolvedTierMeta = { tier: guardTier, provider: entry.provider, source: entry.source, ...(entry.policy ? { policy: entry.policy } : {}) };
      }
      const guarded = guardDispatchModel({
        resolved: resolvedModel,
        source: modelSource,
        tier: guardTier,
        fallbacks,
        catalog: dispatchCatalog,
        certifications,
      });
      if (guarded.rejection) {
        modelRejections.push({ rejected: guarded.rejection.rejected, reason: guarded.rejection.reason, source: guarded.rejection.source });
        for (const draw of [experimentDraw, poolDraw]) {
          if (draw && draw.assignedModel === guarded.rejection.rejected) {
            draw.served = false;
            draw.assignedModel = guarded.model;
            draw.eligibility = { ...draw.eligibility, fallback: 'model_unrecognized' };
          }
        }
        resolvedModel = guarded.model;
        modelSource = guarded.source;
        if (resolvedTierMeta) {
          // The policy's pick did not run, so its decision no longer describes
          // this claim: drop it, and no outcome is reported against it.
          const { policy: _notServed, ...rest } = resolvedTierMeta;
          resolvedTierMeta = { ...rest, source: guarded.source === 'tier_default' ? 'default' : resolvedTierMeta.source };
        }
      }
    }
    const claimModelRejections: DispatchModelRejection[] = modelRejections.map((r) => ({ ...r, fallback: resolvedModel }));
    for (const r of claimModelRejections) {
      console.warn(`[claim] task ${task.id}: ${describeDispatchModelRejection(r)}`);
    }

    // Refuse a task whose resolved model needs a newer Claude Code client than
    // this runner reports, BEFORE a worker session starts — the API's own
    // version-gate 400 ("Claude Code X.Y.Z does not support this model;
    // version A.B.C or newer is required") is otherwise deterministic and
    // identical on every retry, burning a full worker session each time. See
    // packages/core/model-capability-requirements.ts.
    const capabilityCheck = checkModelClientCapability(resolvedModel, body.environment?.claudeCliVersion, certifications);
    if (!capabilityCheck.ok) {
      deferTask(task, 'runner_capability', {
        model: resolvedModel,
        requiredVersion: capabilityCheck.requiredVersion,
        runnerVersion: body.environment?.claudeCliVersion ?? null,
      });
      continue;
    }

    // Persist the routing decision in task context so the runner consumes it
    // without extra lookups. We also write predictedModel for analytics.
    //
    // `routingReason` is diagnostic only — nothing reads it to decide a model.
    // Without it, "why did this task get this model?" is unanswerable after the
    // fact: `context.model` is overwritten here, so an explicit pin becomes
    // indistinguishable from a tier resolution that happened to match, and a
    // budget downshift (a surprisingly cheap model) looks like a deliberate
    // choice. Fill-forward: rows claimed before this shipped have no reason and
    // must be reported as unknown rather than guessed at.
    //
    // `modelPinned` records whether `model` is a caller pin or this claim's
    // routed output, so the next claim after a requeue routes afresh instead of
    // replaying this result as an override. A role full-id pin is not a task
    // pin: it is re-read from the role on every claim.
    if (forced) {
      console.log(`[claim] force claim: task ${task.id} past [${forceBypassed.join(', ')}] by admin account ${account.id}`);
    }
    const patchedContext = {
      // A previous claim's force audit never carries over (withoutForceClaim).
      ...withoutForceClaim(taskContext),
      ...(forced ? {
        [FORCE_CLAIM_CONTEXT_KEY]: {
          at: now.toISOString(),
          accountId: account.id,
          userId: interactiveSession?.userId ?? null,
          bypassed: [...forceBypassed],
        },
      } : {}),
      model: resolvedModel,
      modelPinned: explicit !== null,
      routingReason: routingDecision.reason,
      ...(resolvedTierMeta ? { resolvedTier: resolvedTierMeta } : {}),
    };
    // Why this claim's backend differs from the stored one — or nothing, so a
    // previous attempt's flip never reads as this one's.
    delete (patchedContext as Record<string, unknown>)[BACKEND_ROUTING_KEY];
    // Claimed: it no longer waits on an entitlement.
    delete (patchedContext as Record<string, unknown>)[ENTITLEMENT_BLOCK_CONTEXT_KEY];
    const routing = backendRouting.get(task.id);
    if (routing && routing.backend === (task as any).backend) {
      (patchedContext as Record<string, unknown>)[BACKEND_ROUTING_KEY] = routing;
    }
    // Who holds an interactive claim: the MCP liveness touch is scoped to the
    // session user that made it (lib/interactive-worker-liveness.ts). Rewritten
    // on every claim so a stamp never outlives the claim it described.
    delete (patchedContext as Record<string, unknown>)[INTERACTIVE_CLAIM_USER_KEY];
    if (interactiveSession?.userId) {
      (patchedContext as Record<string, unknown>)[INTERACTIVE_CLAIM_USER_KEY] = interactiveSession.userId;
    }
    // And the MCP session that made it: a bld_ key has no user, so this is
    // what keeps one of its sessions from keeping another's claims alive.
    delete (patchedContext as Record<string, unknown>)[INTERACTIVE_CLAIM_SESSION_KEY];
    if (interactiveSession?.sessionKey) {
      (patchedContext as Record<string, unknown>)[INTERACTIVE_CLAIM_SESSION_KEY] = interactiveSession.sessionKey;
    }

    // Gated START only (never as shipped): the relaxed overlap's declared
    // paths go through the exclusive primitive, all-or-nothing, before the
    // claim. Any conflict keeps the original path_overlap hold.
    let gatedStartLeaseIds: string[] = [];
    if (gatedStartPaths) {
      const acquired = await acquireGatedStartPaths({ workspaceId: task.workspaceId, taskId: task.id, paths: gatedStartPaths });
      if (!acquired.ok) {
        deferTask(task, 'path_overlap', { gatedStart: 'acquire_failed' });
        continue;
      }
      gatedStartLeaseIds = acquired.insertedIds;
    }

    // Atomic claim: only succeeds if task is still pending (optimistic lock)
    lockAttempts++;
    const updated = await db
      .update(tasks)
      .set({
        claimedBy: account.id,
        claimedAt: now,
        expiresAt,
        status: 'assigned',
        predictedModel: resolvedModel,
        context: patchedContext,
        // Mark loopState as 'running' so the completion route knows this iteration
        // is active and can safely evaluate the exit condition (double-evaluation guard).
        ...(task.loopConfig ? { loopState: 'running' } : {}),
      })
      .where(and(eq(tasks.id, task.id), eq(tasks.status, 'pending')))
      .returning({ id: tasks.id });

    if (updated.length === 0) {
      // Already claimed by another request. A gated START that leased paths
      // for this attempt gives them back unless the winning claim owns them.
      if (gatedStartLeaseIds.length > 0) {
        await releaseGatedStartPaths({ workspaceId: task.workspaceId, taskId: task.id, insertedIds: gatedStartLeaseIds });
      }
      continue;
    }

    // Workflow kernel T9 (docs/specs/workflow-state-kernel.md §10.5): a review
    // or CI fix is revalidated against a live read at claim. One whose target was
    // resolved while it queued (approved, merged, head moved, round superseded)
    // is cancelled as skipped — never started, and not a worker failure.
    if (isRepairRole((task as any).deliveryRole) && (task as any).deliveryId) {
      const fixDecision = await claimKernelFix({
        id: task.id, workspaceId: task.workspaceId, deliveryId: (task as any).deliveryId, deliveryRole: (task as any).deliveryRole, context: task.context,
      }).catch((err): { action: 'defer'; reason: string } => {
        console.error(`[claim] workflow kernel FixClaimed failed for task ${task.id}:`, err);
        return { action: 'defer', reason: 'kernel_error' };
      });
      if (fixDecision.action !== 'proceed') {
        if (gatedStartLeaseIds.length > 0) {
          await releaseGatedStartPaths({ workspaceId: task.workspaceId, taskId: task.id, insertedIds: gatedStartLeaseIds });
        }
        if (fixDecision.action === 'cancel') {
          console.log(`[claim] task ${task.id} skipped: ${fixDecision.reason}`);
          await cancelSkippedTask(task.id, fixDecision.reason);
        } else {
          await withDispatchHint({ suppress: 'claim_rollback' }, db
            .update(tasks)
            .set({ claimedBy: null, claimedAt: null, expiresAt: null, status: 'pending' })
            .where(and(eq(tasks.id, task.id), eq(tasks.status, 'assigned'), eq(tasks.claimedBy, account.id))));
        }
        deferTask(task, 'fix_not_needed', { reason: fixDecision.reason });
        continue;
      }
    }

    if (experimentDraw) {
      await recordModelRoutingAssignment(experimentDraw, { taskId: task.id, runnerCliVersion: body.environment?.claudeCliVersion, resolvedModel });
    }
    if (poolDraw) {
      await recordAgentPoolAssignment(poolDraw, { taskId: task.id, runnerCliVersion: body.environment?.claudeCliVersion, resolvedModel });
    }

    // Count this claim toward the per-workspace cap for the rest of the batch.
    activeByWorkspace.set(task.workspaceId, (activeByWorkspace.get(task.workspaceId) || 0) + 1);
    if (account.managedRunner) {
      const entitlementTeamId = (task as any).workspace?.teamId as string | undefined;
      if (entitlementTeamId) managedClaimedByTeam.set(entitlementTeamId, (managedClaimedByTeam.get(entitlementTeamId) ?? 0) + 1);
    }

    // Mirror into the Codex single-flight tracker so a second originally-Codex
    // task for this workspace, later in the same batch, hits the defer above
    // instead of claiming alongside the one just claimed here.
    if (isCodexTask) {
      codexBusyWorkspaces.add(task.workspaceId);
    }

    // Mission-level post-claim bookkeeping: update in-memory counters so
    // subsequent tasks in the same batch respect the gates we just passed.
    // Review tasks consume neither the concurrency count nor the pacing slot.
    if (taskMissionId && (task as any).category !== 'review'
      && !producesNoFileEdits((task as any).outputRequirement)
      && declaresNoScope((task as any).pathManifest as string[] | null)) {
      // Reserve the mission's single scope-undeclared slot for the rest of the
      // batch, so one poll cannot claim two '**' tasks from the same mission.
      // Keyed on category alone, like both sides of the advisory guard above.
      const set = missionAdvisoryInFlight.get(taskMissionId) ?? new Set<string>();
      set.add(task.id);
      missionAdvisoryInFlight.set(taskMissionId, set);
    }
    if (taskMissionId && !isReviewTask) {
      // Increment concurrency count so a second task from the same mission in
      // this batch sees the updated active count.
      missionActiveCountMap.set(taskMissionId, (missionActiveCountMap.get(taskMissionId) ?? 0) + 1);

      const missionData = missionClaimMap.get(taskMissionId);
      if (missionData?.pacingMode === 'paced') {
        // Stamp lastTaskStartedAt in-memory to block same-batch double-starts.
        missionData.lastTaskStartedAt = now;
        // Persist to DB asynchronously — best-effort; pacing is maintained correctly
        // in-memory for the current batch, and the DB timestamp governs future polls.
        db.update(missions)
          .set({ lastTaskStartedAt: now, updatedAt: now })
          .where(eq(missions.id, taskMissionId))
          .catch(err => console.warn(`[claim] Failed to stamp mission lastTaskStartedAt for ${taskMissionId}:`, err));
      }
    }

    // Keep the in-memory task copy in sync so downstream enrichment and the
    // returned worker payload see the patched context.
    (task as any).context = patchedContext;
    (task as any).predictedModel = resolvedModel;

    // Option A′: hand the runner the two mission fields `resolveTaskPrBase`
    // needs, so the prompt it builds and the base `create_pr` derives come out
    // of the same function. Absent for a task with no mission, which is the
    // "behave exactly as before" answer everywhere in A′.
    if (taskMissionId) {
      const missionData = missionClaimMap.get(taskMissionId);
      if (missionData) {
        (task as any).mission = {
          workingBranch: missionData.workingBranch,
          integrationBranchEnabled: missionData.integrationBranchEnabled,
        };
      }
    }

    // Generate branch name based on workspace gitConfig
    const gitConfig = task.workspace?.gitConfig as {
      branchingStrategy?: 'none' | 'trunk' | 'gitflow' | 'feature' | 'custom';
      branchPrefix?: string;
      useBuildBranch?: boolean;
      defaultBranch?: string;
    } | null;

    // A pinned shared head (context.headBranch) takes precedence, except one
    // equal to the task's own base: an integration-branch mission child bases
    // on the mission branch and works on its own generated task head.
    //
    // The rule itself lives in @buildd/core/branch-names because approve-plan
    // has to predict this exact name when it resolves a stacked baseBranch ref;
    // its hand-mirrored copy of the chain below had already drifted.
    const branch = generateTaskBranchName({
      taskId: task.id,
      title: task.title,
      gitConfig,
      sharedHeadBranch: (patchedContext as Record<string, unknown> | null)?.headBranch,
      baseBranch: (patchedContext as Record<string, unknown> | null)?.baseBranch,
    });

    // Atomic conditional insert: only creates worker if under concurrency limit
    // AND the task has no live worker already. This prevents two TOCTOU races:
    //   1. multiple requests pass the count check, then all insert (over the limit)
    //   2. the candidate query's NOT EXISTS live-worker filter is a snapshot read;
    //      by the time this insert runs another claim (or a reaper re-queue racing
    //      a still-live worker) may already own the task. A second row for a task
    //      that already has one can only ever rot into a stale-worker kill.
    // Lock the claimed task in this statement. Cancellation either wins first
    // (the status check refuses insertion), or waits for this insert to commit
    // and then sees the live worker in its post-cancellation read.
    //
    // Race 1's single-statement guard above is real for the per-task dup check
    // (FOR UPDATE + NOT EXISTS), but the account-wide `count(*) < max` predicate
    // is a plain snapshot read under READ COMMITTED: two concurrent claims can
    // each evaluate it before the other's insert is visible and both pass,
    // pushing the live total over maxConcurrentWorkers (observed live — see
    // apps/web/tests/integration/concurrency.test.ts). Serialize per-account
    // with a transaction-scoped advisory lock taken in a batch alongside the
    // insert, same protocol as packages/core/path-claim.ts's workspaceLock: on
    // neon-http, db.batch runs as one non-interactive transaction, so the lock
    // is held exactly for this insert's duration and is safe without
    // db.transaction()'s interactive-session requirement.
    // The authenticated OAuth session user, never the client-relayed session
    // marker: an OAuth session acts as its team's shared account, so this is
    // what PATCH /api/workers/[id] matches to let only the claimer act as the
    // worker (lib/worker-owner.ts). NULL for a bld_ key.
    const claimedByUserId = (account as { sessionUserId?: string | null }).sessionUserId ?? null;
    const [, insertResult] = await db.batch([
      db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('workers_claim_concurrency'), hashtext(${account.id}::text))`),
      db.execute(sql`
        INSERT INTO ${workers} (task_id, workspace_id, account_id, name, runner, branch, status, claimed_by_user_id)
        SELECT ${task.id}, ${task.workspaceId}, ${account.id}, ${`${account.name}-${task.id.substring(0, 8)}`}, ${runner}, ${branch}, 'idle', ${claimedByUserId}::uuid
        WHERE EXISTS (
          SELECT 1 FROM ${tasks} t_claim
          WHERE t_claim.id = ${task.id}
          AND t_claim.status = 'assigned'
          AND t_claim.claimed_by = ${account.id}
          FOR UPDATE
        )
        AND (
          SELECT count(*) FROM ${workers}
          WHERE account_id = ${account.id}
          AND status IN ('idle', 'running', 'starting', 'waiting_input')
        ) < ${account.maxConcurrentWorkers}
        AND NOT EXISTS (
          SELECT 1 FROM ${workers} w_dup
          WHERE w_dup.task_id = ${task.id}
          AND w_dup.status IN ('idle', 'running', 'starting', 'waiting_input')
        )
        RETURNING *
      `),
    ]);

    const worker = (insertResult as { rows?: any[] })?.rows?.[0] as any;

    if (!worker) {
      // The conditional insert can no-op for two reasons. Only one of them
      // justifies rolling the task back to pending.
      const liveWorkers = await db.query.workers.findMany({
        where: and(
          eq(workers.taskId, task.id),
          inArray(workers.status, ['idle', 'running', 'starting', 'waiting_input']),
        ),
        columns: { id: true },
        limit: 1,
      });

      if (liveWorkers.length > 0) {
        // Dup guard fired: another worker already owns this task. Leave the task
        // assigned to it (rolling back to pending here is what let a second,
        // never-started row be minted on the next poll) and try the next task.
        console.warn(
          `[claim] Duplicate-worker guard: task ${task.id} already has live worker ${liveWorkers[0].id} — skipping`,
        );
        deferTask(task, 'duplicate_worker', { liveWorkerId: liveWorkers[0].id });
        continue;
      }

      // Roll back only our still-assigned claim; never resurrect a cancelled task.
      // Suppressed for the dispatch trigger: this undoes our own claim, it is
      // not new runnable state, and a wake here would loop claim → refuse →
      // rollback → wake across every runner.
      await withDispatchHint({ suppress: 'claim_rollback' }, db
        .update(tasks)
        .set({ claimedBy: null, claimedAt: null, expiresAt: null, status: 'pending' })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, 'assigned'), eq(tasks.claimedBy, account.id))));
      if (task.id === taskId) {
        explicitTaskExclusion = {
          code: 'account_cap',
          detail: `This account reached its limit of ${account.maxConcurrentWorkers} concurrent workers while the claim ran. Finish or release one, then retry.`,
        };
      }
      break;
    }

    // The queue was spared a doomed launch; leave the record of what was refused.
    // One stable pattern + excerpt per (id, source, reason) so repeats dedupe.
    // Best-effort: a trace failure must not undo a claim that already succeeded.
    if (claimModelRejections.length > 0) {
      try {
        await db.insert(workerErrorTraces).values(claimModelRejections.map((r) => ({
          workerId: worker.id,
          taskId: task.id,
          pattern: DISPATCH_MODEL_REJECTED_PATTERN,
          excerpt: describeDispatchModelRejection(r).slice(0, 500),
          source: 'claim',
        })));
      } catch (err) {
        console.warn(`[claim] failed to record dispatch model rejection for task ${task.id}:`, err);
      }
    }

    claimedWorkers.push({
      id: worker.id,
      taskId: task.id,
      branch,
      task: task as any,
    });
    // A START past a soft overlap (rule or Jev): one accepted row per holder,
    // the started half of the HOLD/START evaluation set.
    for (const s of softOverlapStarted) {
      fireGateEvent({
        gate: GATE_SLUGS.CLAIM_LOOP_DEFERRAL,
        surface: 'POST /api/workers/claim',
        outcome: 'accepted',
        reason: 'soft_overlap_start',
        taskId: task.id,
        workspaceId: task.workspaceId,
        missionId: (task as any).missionId ?? null,
        workerId: worker.id,
        callerOrigin: gateCallerOrigin({ apiAccount: account }),
        detail: { ...s, startedAt: now.toISOString() },
      });
    }
    if (forced) {
      fireGateEvent({
        gate: GATE_SLUGS.CLAIM_LOOP_DEFERRAL,
        surface: 'POST /api/workers/claim',
        outcome: 'bypassed',
        reason: 'force_claim',
        taskId: task.id,
        workspaceId: task.workspaceId,
        missionId: (task as any).missionId ?? null,
        workerId: worker.id,
        callerOrigin: gateCallerOrigin({ apiAccount: account }),
        detail: { bypassed: [...forceBypassed], accountId: account.id, userId: interactiveSession?.userId ?? null },
      });
      // A force past a soft overlap is calibration data for the HOLD/START
      // decision: a human START, labelled later by the same outcome join
      // (clean, collision, conflict task) as a model START, never counted as
      // a model answer. One row per holder it went past.
      for (const s of softOverlapForced) {
        fireGateEvent({
          gate: GATE_SLUGS.CLAIM_LOOP_DEFERRAL,
          surface: 'POST /api/workers/claim',
          outcome: 'bypassed',
          reason: 'force_soft_overlap',
          taskId: task.id,
          workspaceId: task.workspaceId,
          missionId: (task as any).missionId ?? null,
          workerId: worker.id,
          callerOrigin: gateCallerOrigin({ apiAccount: account }),
          detail: { ...s, calibration: 'human_force', startedAt: now.toISOString() },
        });
      }
    }
    if (usesOauthSeat && oauthSeatSlotsLeft !== null) oauthSeatSlotsLeft--;
  }

  // Planner bookkeeping. Under 'apply', every planned task never attempted is
  // re-planned against what is now in flight; the ones ordered behind a
  // blocker get ONE `ordered_behind` row per (task, blocker) — repeat polls
  // write nothing — in place of the per-poll path_overlap / advisory_manifest
  // deferral they would have had, and a waiter on the blocker so its release
  // wakes them.
  if (applyInitial) {
    const remaining = applyTasks.filter(t => !plannerAttempted.has(t.id));
    const final = remaining.length > 0
      ? planFor(remaining, claimedTasksSoFar(), Math.max(0, availableSlots - claimedWorkers.length))
      : null;
    for (const o of final?.plan.orientation ?? []) {
      const waiting = applyTaskById.get(o.taskId);
      if (!waiting) continue;
      const blocker = final!.ctx.inFlightMeta.get(o.blockedBy);
      const blockerTaskId = blocker ? blocker.taskId : o.blockedBy;
      deferrals.ordered_behind++;
      fireOrderedBehind({
        taskId: waiting.id,
        workspaceId: waiting.workspaceId,
        missionId: (waiting as any).missionId ?? null,
        blockedBy: blockerTaskId ?? o.blockedBy,
        edge: o.edge,
        orientation: o.reason,
      });
      if (blockerTaskId && (o.edge === 'path_overlap' || o.edge === 'lease_overlap' || o.edge === 'open_pr_overlap')) {
        const own = ((waiting as any).pathManifest as string[] | null) ?? [];
        const theirs = blocker?.paths ?? (((applyTaskById.get(blockerTaskId) as any)?.pathManifest as string[] | null) ?? []);
        const path = intersectPaths(own, theirs)[0] ?? own[0];
        // Same durable waiter as a path_overlap deferral: registered after the
        // response (scheduleClaimDeferralWaiters), woken through the outbox.
        if (path) noteDeferralWaiter(waiting.workspaceId, waiting.id, blockerTaskId, [path]);
      }
    }
    fireClaimPlanRecord({
      mode: 'apply',
      workspaceId: singleWorkspaceOf(applyTasks),
      plan: applyInitial.plan,
      actualPicks: claimedWorkers.filter(w => applyIds.has(w.taskId)).map(w => w.taskId),
      candidateCount: applyTasks.length,
      capacity: availableSlots,
      backend: effectiveBackendOf(applyTasks),
    });
  }
  if (recordPlan) {
    const recordIds = new Set(recordTasks.map(t => t.id));
    fireClaimPlanRecord({
      mode: 'record',
      workspaceId: singleWorkspaceOf(recordTasks),
      plan: recordPlan,
      actualPicks: claimedWorkers.filter(w => recordIds.has(w.taskId)).map(w => w.taskId),
      candidateCount: recordTasks.length,
      capacity: availableSlots,
      backend: effectiveBackendOf(recordTasks),
    });
  }

  // Hold/start shadow decisions run after the response is sent (after()).
  // Registering them is synchronous; nothing here is awaited.
  scheduleClaimHoldShadow(holdStart);
  scheduleClaimDeferralWaiters(deferralWaiters);

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
    // Same signal for a wall on any OTHER provider: every candidate was deferred
    // by `budget_paused`, so the runner needs the earliest reset across the pauses
    // this batch actually saw — `account.budgetResetsAt` only tracks Claude.
    // Exception: interactive sessions have their own credentials and do not consume
    // the account's provider budget, so they should not be blocked by accountBudgetExhausted.
    // Also exempt explicit taskId claims, which skip OAuth budget pacing by design.
    const accountBudgetBlocksBackgroundRunner = accountBudgetExhausted && !interactiveSession && !taskId;
    if (accountBudgetBlocksBackgroundRunner || deferrals.budget_paused > 0) {
      return emptyClaim({
        budgetResetsAt: earliestFutureReset(),
        diagnostics: { reason: 'budget_exhausted' } satisfies ClaimDiagnostics,
      });
    }
    // Distinguish true lock-contention (race_lost) from "all candidates were
    // deferred without a single claim attempt" (all_candidates_deferred).
    // race_lost = some tasks reached the atomic UPDATE but another worker won.
    // all_candidates_deferred = every filtered task was skipped by a pre-claim
    // gate (connector mismatch, pacing, workspace cap, etc.) — no race occurred.
    // This matters for diagnostics: race_lost with pendingTasks>0 looked like
    // normal contention but was actually a permanent stall (2026-07-30 incident).
    const totalDeferrals = Object.values(deferrals).reduce((s, n) => s + n, 0);
    const allDeferred = lockAttempts === 0 && filteredTasks.length > 0 && totalDeferrals > 0;
    const nonZeroDeferrals = Object.fromEntries(
      Object.entries(deferrals).filter(([, n]) => n > 0),
    ) as ClaimDiagnostics['deferrals'];
    return emptyClaim({
      diagnostics: {
        reason: allDeferred ? 'all_candidates_deferred' : 'race_lost',
        pendingTasks: claimableTasks.length,
        matchedTasks: filteredTasks.length,
        ...(totalDeferrals > 0 ? { deferrals: nonZeroDeferrals } : {}),
        ...(firstBlockingPr ? { blockedByPr: firstBlockingPr } : {}),
        ...(explicitTaskExclusion ? { taskExclusion: explicitTaskExclusion } : {}),
        // Surface learned OAuth pressure so an `oauth_parallelism` deferral is
        // attributable ("seat capped at 97% of the learned window") instead of
        // looking like an unexplained stall.
        ...(oauthPressure && oauthPressure.confidence !== 'none'
          ? {
              budgetPressure: {
                pct: oauthPressure.pct,
                limiter: oauthPressure.limiter,
                confidence: oauthPressure.confidence,
                samples: oauthPressure.samples,
              },
            }
          : {}),
      } satisfies ClaimDiagnostics,
    });
  }

  // Attach degradedConnectors to workers that claimed under advisory mode
  // and persist them to the DB for the audit trail on the task detail page.
  for (const cw of claimedWorkers) {
    const degraded = taskDegradedConnectors.get(cw.taskId);
    if (degraded && degraded.length > 0) {
      (cw as any).degradedConnectors = degraded;
      // Persist so the task detail page can show the badge even after completion.
      await db
        .update(workers)
        .set({ degradedConnectors: degraded as any })
        .where(eq(workers.id, cw.id));
    }
  }

  // Tell each agent what its workspace siblings already have in flight: open
  // PRs from other live workers, and path manifests declared by pending sibling
  // tasks. See ./workspace-work-context.
  await attachWorkspaceWorkContext(claimedWorkers, filteredTasks);

  // Broadcast claim events so dashboard updates in real-time
  for (const cw of claimedWorkers) {
    const claimedTask = filteredTasks.find(t => t.id === cw.taskId);
    if (claimedTask) {
      await triggerEvent(
        channels.workspace(claimedTask.workspaceId),
        events.TASK_CLAIMED,
        {
          task: { id: claimedTask.id, title: claimedTask.title, status: 'assigned', workspaceId: claimedTask.workspaceId, missionId: claimedTask.missionId ?? null },
          worker: { id: cw.id, name: account.name, status: 'idle' },
        }
      );
      // A fix attempt or reviewer just got a worker: the PR's activity comment
      // may now say "Fixing" / "Reviewing" instead of queued. No-op otherwise.
      await announceFixClaimed(claimedTask);
      await announceReviewClaimed(claimedTask);
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

  // Resolve the skill bundles the task asked for, and the role config its agent
  // runs under (workspace override > team default). See ./skill-and-role-injection.
  await attachSkillBundles(claimedWorkers, filteredTasks, account.id);
  await attachRoleConfig(claimedWorkers, filteredTasks, account.id);
  if (!cloudExecutor) await attachRoleEnvSecrets(claimedWorkers, filteredTasks, account.id);
  // Question gate: marks workers whose questions go through
  // /api/workers/[id]/question-check. No-op for a runner that never sent the feature.
  attachQuestionGate(claimedWorkers, {
    features: Array.isArray(body.runnerFeatures) ? body.runnerFeatures : undefined,
  });

  // Count dependents for each claimed task (for handoff announcement). This
  // scans OTHER tasks' dependsOn arrays for a claimed id, not the claimed
  // tasks' own dependsOn — a dependent can never be claimed in the same batch
  // as its still-in-progress upstream (see dependenciesSatisfied() in
  // ./deps-gate), so restricting the scan to claimedTaskIds would never match.
  const claimedTaskIds = claimedWorkers.map(cw => cw.taskId);
  if (claimedTaskIds.length > 0) {
    const dependentCounts = new Map<string, number>();
    // This runs AFTER the claim has been committed, so it must never be able to
    // fail the claim. It did: the predicate interpolated a JS array into a
    // template fragment, which renders as a parameter list rather than an
    // array, so `ANY(($1, $2))` was rejected by Postgres on every execution —
    // turning every successful claim into a 500 the runner threw on and leaving
    // the worker rows it had just created for the stale sweep to reap. Work
    // committed, then silently discarded.
    //
    // Two independent fixes, because either alone leaves a trap:
    //   1. the predicate is built by dependentCountQuery, whose rendered SQL is
    //      asserted in a test (the route's own suite stubs drizzle-orm, so no
    //      test here can see a malformed fragment);
    //   2. a failure degrades the handoff ANNOUNCEMENT, which is advisory, and
    //      never the dispatch. An enrichment query has no business deciding
    //      whether a runner learns it has work.
    try {
      const dependentRows = await db.execute(dependentCountQuery(claimedTaskIds));
      for (const row of dependentRows.rows as any[]) {
        dependentCounts.set(row.taskId, Number(row.dependentCount) ?? 0);
      }
    } catch (err) {
      console.error(
        '[claim] dependent-count query failed; handoff announcement degraded, dispatch unaffected:',
        err,
      );
    }

    for (const cw of claimedWorkers) {
      const count = dependentCounts.get(cw.taskId) ?? 0;
      if (count > 0) {
        // The runner reads task.context (claimedWorker.task.context), not a
        // top-level field on the worker — see prompt-builder.ts's taskContext.
        const taskObj = cw.task as any;
        if (taskObj) {
          taskObj.context = taskObj.context ?? {};
          taskObj.context.dependentCount = count;
        }
      }
    }
  }

  // Prompt-context injection. ORDER IS THE CONTRACT: these six append to the
  // same resolvedContextProviders rail and the runner concatenates it in
  // order — external providers, mission handoff, knowledge, subject-prior-work,
  // discrepancy, task-area scope. See ./context-injection and
  // ./prompt-context-pipeline for why the middle four run concurrently without
  // disturbing that order.
  await attachExternalContextProviders(claimedWorkers, filteredTasks);
  const taskAreaPredictions = await runDependentContextInjections(
    claimedWorkers,
    filteredTasks,
    account?.teamId
      ? {
          id: account.id,
          teamId: account.teamId,
          workspaceIds: account.workspaceIds,
          sessionUser: !!(account as { sessionUserId?: string }).sessionUserId,
        }
      : null,
  );
  await attachTaskAreaScope(claimedWorkers, filteredTasks, taskAreaPredictions);

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

  // Attach inline decrypted server-managed credentials (API key and/or OAuth
  // token), team-scoped to prevent cross-team leakage. See ./credential-injection.
  //
  // Every credential attach below is skipped for a cloud executor, so nothing
  // is even decrypted; stripClaimCredentials after them is the backstop that
  // makes the omission hold even if a new attach forgets the check.
  //
  // The team's agent model endpoint is ranked against the Anthropic key, the
  // seat and the Claude credential (Codex: the OpenAI key and codex_credential
  // instead) first (./agent-endpoint-injection): where it wins, it is the only
  // model credential attached, so the blocks below skip the backend-matching
  // ones for those workers.
  const endpointWorkers: ReadonlySet<string> = cloudExecutor
    ? new Set()
    : await attachAgentEndpoints(claimedWorkers, filteredTasks, account.id, {
        llmProviderOverride: body.llmProviderOverride === true,
        codexBaseUrlOverride: body.codexBaseUrlOverride === true,
        runnerSupportsEndpoint: runnerSupportsAgentEndpoint(body.runnerFeatures),
      });
  if (cloudExecutor) await attachCloudToolSearchHint(claimedWorkers, filteredTasks, account.id);
  if (!cloudExecutor) await attachServerManagedSecrets(claimedWorkers, account.id, endpointWorkers);

  // Which GitHub credentials the agent gets: a mode marker only, gated on the
  // rollout stage and the runner declaring the feature. See ./github-credential-injection.
  if (!cloudExecutor) {
    attachGitHubCredentialModes(claimedWorkers, {
      rollout: parseAgentGitHubRollout(process.env[AGENT_GITHUB_TOKEN_ROLLOUT_ENV]),
      runnerFeatures: body.runnerFeatures,
    });
  }

  // Inject active MCP connectors — resolution rules (role connectorRefs ∩ workspace
  // enablement ∩ team visibility, and owner-team credential keying) live in
  // ./mcp-connector-injection. Spec: docs/specs/mcp-connectors-and-roles.md §2/§3.
  //
  // Separate block from the credential decryption above so connector injection is
  // not gated on workspace anthropic/oauth secrets being present.
  if (!cloudExecutor && claimedWorkers.length > 0 && process.env.ENCRYPTION_KEY) {
    await attachMcpConnectors(claimedWorkers, now, getSecretsProvider());
  }

  // Attach agent-backend credentials and the runner's pre-refresh list.
  // Codex-backend tasks get Codex creds, everything else gets Claude creds; both
  // read-only (refresh is runner-side). See ./credential-injection.
  if (!cloudExecutor) {
    await attachCodexCredentials(claimedWorkers, filteredTasks, account.id, endpointWorkers);
    await attachClaudeCredentials(claimedWorkers, filteredTasks, account.id, endpointWorkers);
    await attachPendingCredentialRefreshes(claimedWorkers, filteredTasks, endpointWorkers);
  } else {
    for (const cw of claimedWorkers) {
      const removed = stripClaimCredentials(cw as unknown as Record<string, unknown>);
      if (removed.length > 0) {
        console.error(`[claim] cloud executor: stripped credential field(s) an attach step added anyway for worker ${cw.id}: ${removed.join(', ')}`);
      }
    }
  }
  // Also announce at the top level so the runner has ONE field to read on every
  // poll, claim or no claim. This one is account-team-scoped; the per-worker
  // lists above stay because a claim may serve a workspace outside the
  // authenticated account's own team, and the runner reads the claude_credential
  // secretId off the per-worker entry when wiring that worker to its broker.
  const accountCredentialRefreshes = cloudExecutor ? undefined : await resolveAccountCredentialRefreshes(account);

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
    // The workspace dispatch token never leaves in a claim (lib/workspace-dispatch-token.ts).
    workers: claimedWorkers.map((cw) => (cw.task
      ? { ...cw, task: { ...(cw.task as any), workspace: withoutDispatchToken((cw.task as any).workspace) } }
      : cw)),
    ...(accountCredentialRefreshes ? { pendingCredentialRefreshes: accountCredentialRefreshes } : {}),
    // Only report partial budget exhaustion for background runners. Interactive sessions
    // have their own credentials and should not be told about account budget state.
    // Also exempt explicit taskId claims, which skip budget gates by design.
    ...(accountBudgetExhausted && !interactiveSession && !taskId && {
      budgetResetsAt: earliestFutureReset(),
      diagnostics: { reason: 'budget_exhausted_partial' } satisfies ClaimDiagnostics,
    }),
  }, undefined, { route: req.nextUrl.pathname });
}

/**
 * Write the request's path_overlap waiters after the response: one locked
 * statement per workspace (registerClaimDeferralWaiters), which also wakes at
 * once any task whose blocker let go since this request read it. Off the hot
 * path, but not silent: a failure is logged, and the deferred task is still
 * re-registered by its next claim pass and swept by path-claims maintenance.
 */
function scheduleClaimDeferralWaiters(byWorkspace: Map<string, ClaimDeferralWaiter[]>): void {
  if (byWorkspace.size === 0) return;
  const run = () => Promise.all([...byWorkspace].map(([workspaceId, entries]) =>
    registerClaimDeferralWaiters(workspaceId, entries).catch(err => {
      console.error(`[claim] registering claim-deferral waiters failed for workspace ${workspaceId}:`, err);
      return { registered: 0, woken: [] as string[] };
    }),
  )).then(results => {
    // A blocker that let go since this request read it was woken in the same
    // statement; deliver that wake now rather than at the next unrelated kick.
    if (results.some(r => r.woken.length > 0)) kickDispatch();
  });
  try {
    after(run);
  } catch {
    // Outside a request scope (scripts, tests): run now, detached.
    void run();
  }
}

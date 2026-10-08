import { isSilentCompletion, silentCompletionRetryContext } from '@/lib/silent-completion';
import { NextRequest, NextResponse } from 'next/server';
import { questionNotificationText, withSanitizedBrief } from '@buildd/core/question-brief';
import { isUuid } from '@/lib/uuid';
import { db } from '@buildd/core/db';
import { codingRunObservations, reviewVerdictObservations } from '@buildd/core/model-policy';
import { reportTaskPolicyOutcome } from '@/lib/model-policy-outcomes';
import { workers, tasks, artifacts, workspaces, githubRepos, missionNotes, accounts, teams, tenantBudgets, oauthBudgetEpisodes, workerErrorTraces, workerActionEvents, workerPromptCompositionEvents, connectors, secrets, missions, taskSchedules } from '@buildd/core/db/schema';
import { githubApi, postPrReview } from '@/lib/github';
import { eq, and, or, desc, gte, gt, inArray, isNull, isNotNull, not, sql } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { authenticateApiKey } from '@/lib/api-auth';
import { withoutDispatchToken } from '@/lib/workspace-dispatch-token';
import { authenticateTaskScopedCaller } from '@/lib/task-token-auth';
import { callerOwnsWorker } from '@/lib/worker-owner';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { resolveCompletedTask } from '@/lib/task-dependencies';
import { checkWorkerDeliverables, getWorkerDeliverableArtifactCount } from '@/lib/worker-deliverables';
import { jsonResponse } from '@/lib/api-response';
import { notifyTeam, notifyTeamOf } from '@/lib/notify';
import { markHoldDue, type HoldResolution } from '@/lib/question-hold';
import { disposeParkedWaitingFor } from '@/lib/park-disposition';
import { gateEnabledFromGitConfig, hardRailContextFromGitConfig } from '@/lib/question-gate-check';
import { sendTaskCallback } from '@/lib/task-callback';
import { emit } from '@/lib/core-emit';
import { upsertAutoArtifact, formatStructuredOutput } from '@/lib/artifact-helpers';
import { recordTaskOutcome } from '@buildd/core/routing-analytics';
import { recordRunnerOutcome } from '@buildd/core/runner-health';
import { recordTaskAreaOutcome } from '@buildd/core/task-area-prediction-source';
import { recordOrchestrationTouchLabel } from '@buildd/core/orchestration-ledger-source';
import { reportOps } from '@buildd/core/report-ops';
import { estimateCostUsd, estimateCostUsdFromTotals } from '@buildd/core/model-prices';
import { applyBudgetUsage, countsTowardAgentSdkCreditPool } from '@buildd/core/budget-alerts';
import { combineCostBasis, costBasisWrite, parseCostBasis, type CostBasis } from '@buildd/core/cost-basis';
import { lineageStamp } from '@/lib/attempt-lineage';
import { getMissionSpendUsd, exhaustMissionBudget } from '@/lib/mission-budget';
import { isBudgetExhaustionError, isSessionBudgetCapError, extractResetTime, SESSION_WINDOW_MS } from '@/lib/budget-errors';
import { loadOauthEpisodes, measureOauthWindow, resolveSeatIdPeers } from '@/lib/oauth-budget-window';
import { recordBackendPause, resolveFailoverBackend, teamEnabledBackends } from '@/lib/backend-failover';
import { backendLabel, claimedBackendOf, isBackendPinned } from '@buildd/core/backend-policy';
import { tryAutoMergeWorkerPr, escalateReviewerExhaustion, escalateReviewContractFailure } from '@/lib/auto-merge';
import { landPr, resolveLandingMode } from '@/lib/pr-landing';
import { protectedBaseBranches } from '@/lib/auto-merge-bound';
import { LIVE_WORKER_STATUSES } from '@/lib/task-presentation';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { wakeOldestPendingTaskOnCapacityFreed } from '@/lib/capacity-freed-wake';
import { onManagedWorkerTerminal } from '@/lib/entitlements/managed-runner';
import type { ReviewerTaskOutput } from '@/lib/reviewer';
import { enforceServerSideEscalation } from '@/lib/reviewer';
import {
  checkDispatch,
  guardDispatchedTask,
  reconcileSubjectEvent,
  type DispatchProposal,
  type SubjectEvent,
} from '@/lib/supersession';
import { parseReviewerOutput, applyConfidenceGate, REVIEWER_VERDICTS } from '@/lib/reviewer-output';
import { attemptIdentityFrom } from '@/lib/attempt-identity';
import { isApprovalSelfMergeable } from '@/lib/pr-review-status';
import type { MigrationSafety } from '@/lib/migration-safety';
import { RECOMMENDATION_MARKER } from '@/lib/reviewer-evidence';
import { recordReviewerCriteriaFindings } from '@/lib/criteria-reviewer-findings';
import {
  extractVerdictFromProse,
  constructFallbackStructuredOutput,
} from '@/lib/reviewer-prose-fallback';
import { formatAttemptTitle } from '@/lib/task-title';
import { BASH_FAILURE_PATTERN, BASH_RECOVERED_PATTERN, BASH_TRACE_EXCERPT_MAX } from '@buildd/core/bash-failure-trace';
import { approvedAwaitingMergeTitle } from '@/lib/reviewer-evidence';
import { isTaskKind, stampTaskKindIfAbsent } from '@/lib/task-kind';
import { appendPrActivity, taskActivityUrl } from '@/lib/pr-activity-comment';
import { announceFixEnded } from '@/lib/pr-activity-fix-claimed';
import { attemptEnded as workflowAttemptEnded, attemptEndFromPatch, fixCompletionGate, isKernelReviewRound, isRepairRole, recordLocalHead, recordReviewVerdict, taskRetryCoversAttemptEnd } from '@/lib/workflow/seam';
import { GATE_SLUGS, fireGateEvent } from '@/lib/gate-ledger';
import { siblingProbeHeartbeat } from '@/lib/sibling-conflict-probe-store';
import { derivedMergeGateEvent } from '@/lib/derived-merge-gate';
import { dependencyBotPushRefusal, isDependencyBotPrContext } from '@/lib/dependency-bot-pr';
import { fireTerminalRecord } from '@/lib/terminal-record-ledger';
import { applyReviewerLedeCorrection } from '@/lib/pr-lede-correction';
import { resolvePolicy, RESOLVE_POLICY_MISSION_COLUMNS, WORKERS_POLICY_MISSION_COLUMNS } from '@/lib/merge-policy';
import { recordCredentialAuthFailure, recordCredentialAuthSuccess, getActiveClaudeSecretId } from '@/lib/credential-health';
import { classifyAuthErrorSeverity } from '@buildd/core/auth-error-classifier';
import { secrets as secretsTable } from '@buildd/core/db/schema';
import { redactSecretsInBody } from '@buildd/core/redaction';
import { decrypt } from '@buildd/core/secrets';
import type { LoopVerdict } from '@/lib/completion-policy';
import type { HeldOutcomeAnalytics, SlotFailure } from '@/lib/core-events';
import { COMPLETION_POLICIES, RECOVERABLE_BLOCKER_REPAIR } from '@/modules';
import type { TaskHandoff, PathCollisionNotice } from '@buildd/shared';
import { VISUAL_AUDITOR_ROLE_SLUG, TERMINAL_WORKER_STATUSES, isTerminalWorkerStatus, INTERACTIVE_WORKER_RUNNER } from '@buildd/shared';
import { reportWorkerModelIncident } from '@/lib/model-compatibility-incident';
import { classifyReportedFailure, isConcurrencyConflictError, isModelIdRejectedError, isSilentStartShape, isUnrecognizedModelError, MODEL_REJECTION_CONTEXT_KEY, rejectedModelId, SILENT_START_ERROR, TASK_CANCELLED_UNDER_SESSION_ERROR } from '@/lib/worker-exit-taxonomy';
import { shutdownDeadBuilddPrs } from '@/lib/dead-pr-shutdown';
import { hasUnfinishedDependent } from '@/lib/handoff-gate';
import { releaseAndNotify } from '@/lib/path-claim-release';
import { isReadOnlyReview } from '@/lib/read-only-review';
import { schedulePrScopeReconcile } from '@/lib/pr-scope-reconcile-trigger';
import { acquireObservedPaths } from '@buildd/core/path-claim';
import {
  parseWorkingSetDelta,
  parseShipCheckpointReports,
  boundedObservedSample,
  applyWorkingSetSync,
  fireObservationTruncated,
  recordShipCheckpointReports,
  handoffPrScope,
  terminalOwnedPaths,
} from '@/lib/working-set-sync';
import { recordPathCollisionDeferral } from '@/lib/path-collision-deferral';
import { recordPathDeclaration } from '@/lib/path-declaration-ledger';
import { buildWorkerMessage, enqueueWorkerMessage, clearWorkerMessages } from '@buildd/core/worker-messages';
import { formatWorkerMessages, type WorkerMessage } from '@buildd/core/worker-message-format';
import { queueSystemInstruction } from '@/lib/system-instruction-queue';
import { pathsOverlap, isAdvisoryManifest, partitionRegenerableOverlaps } from '@buildd/core/path-overlap';
import { isNonReactivatableError } from '@/lib/worker-termination';
import { markInstructionsDelivered } from '@/lib/worker-instructions';
import { loadMissionBaseGuard } from '@/lib/mission-base-guard';
import { verifyReportedWorkerPr, type ReportedPrVerdict } from '@/lib/agent-capabilities/reported-pr';
import { ensureIntegrationBaseForTaskPr } from '@/lib/mission-integration-branch';
import { teamCredentialWhere } from '@buildd/core/secrets/team-scope';

/**
 * Worker statuses from which no further live update is legal. Every optimistic
 * write in this handler is guarded against these — resurrecting a terminated
 * worker would let a stale in-flight PATCH overwrite a real outcome.
 *
 * `superseded` (POST /api/workers/[id]/respond) is included even though that
 * route writes it directly rather than through this handler's own CAS: once a
 * human has answered the worker's question and a continuation task exists,
 * this row is done — an in-flight runner PATCH for the same worker that reads
 * stale-but-not-yet-superseded state must still find the row terminal by the
 * time its own write lands, so it 409s instead of silently overwriting the
 * answer's outcome.
 */
// TERMINAL_WORKER_STATUSES / isTerminalWorkerStatus: @buildd/shared (also
// covers the legacy `done`).

/**
 * The model this session actually ran on.
 *
 * Feeds two things: `task_outcomes.actual_model` (which was written as NULL for
 * every task because nothing ever passed a value) and the seat/OAuth cost
 * estimate, which needs a model to price session totals against.
 *
 * Priority: the runner's explicit report > the model it recorded in resultMeta >
 * the SDK's own per-model attribution. Returns null when nothing is known — an
 * older runner that sends none of these keeps the previous behaviour rather than
 * having a model guessed for it.
 *
 * With several models in the attribution map (a mid-session fallback fired) the
 * one that produced the most output tokens is the representative model.
 */
function resolveSessionActualModel(
  reported: unknown,
  resultMeta: { actualModel?: unknown; modelUsage?: Record<string, unknown> | null } | null | undefined,
): string | null {
  const asModel = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim() : null;

  const fromBody = asModel(reported);
  if (fromBody) return fromBody;

  const fromMeta = asModel(resultMeta?.actualModel);
  if (fromMeta) return fromMeta;

  const entries = Object.entries(resultMeta?.modelUsage ?? {});
  if (entries.length === 0) return null;
  let best: string | null = null;
  let bestOut = -1;
  for (const [model, usage] of entries) {
    const out = (usage as { outputTokens?: unknown } | null)?.outputTokens;
    const n = typeof out === 'number' && Number.isFinite(out) ? out : 0;
    if (n > bestOut) { bestOut = n; best = asModel(model); }
  }
  return best;
}

/**
 * Build the 409 body for a compare-and-swap miss on the worker row.
 *
 * Two very different things can make a guarded UPDATE match 0 rows:
 *
 *  1. The worker was genuinely terminated (interrupt, reassignment, stale
 *     cleanup) after this handler read it. That IS an abort — and the response
 *     must name the cause (`reason` + `actualStatus`) so the runner can act on
 *     it and so the DB stops recording the runner's `Terminated by server`
 *     fallback string in place of the real cause.
 *
 *  2. A benign lost update: another in-flight PATCH for the SAME live worker
 *     committed first. The runner fires several non-awaited PATCHes during
 *     startup, so this happened routinely — and replying `abort: true` made the
 *     runner hard-kill healthy sessions ~1s after they started. A live row is
 *     never an abort: report a retryable conflict and let the runner re-sync.
 *
 * The current row is re-read to tell the two apart.
 *
 * `extra` merges additional fields into a terminal (abort) response only —
 * used to tell the runner a failure report it lost the race on was still
 * recorded somewhere durable (see `postSupersessionErrorRecorded` below),
 * so its console log reads as "captured" rather than "silently dropped".
 */
async function workerConflictResponse(id: string, extra?: Record<string, unknown>) {
  const current = await db.query.workers.findFirst({ where: eq(workers.id, id) });
  const actualStatus = current?.status ?? null;

  if (!isTerminalWorkerStatus(actualStatus)) {
    return NextResponse.json({
      error: 'Worker state changed concurrently',
      conflict: true,
      retryable: true,
      actualStatus,
    }, { status: 409 });
  }

  const artifactCount = await getWorkerDeliverableArtifactCount(id);
  const deliverables = checkWorkerDeliverables(current as any, { artifactCount });
  return NextResponse.json({
    error: 'Worker was terminated - task may have been reassigned',
    abort: true,
    reason: current?.error || `worker already ${actualStatus}`,
    actualStatus,
    hasDeliverables: deliverables.hasAny,
    ...extra,
  }, { status: 409 });
}

/**
 * Metrics-only PATCH: persist terminal MEASUREMENT on a worker whose outcome is
 * already recorded.
 *
 * Why this exists: the documented worker workflow has the agent call the buildd
 * MCP `complete_task` itself. That marks the worker terminal server-side and
 * pushes worker:completed, so the runner's own completion PATCH — the sole
 * carrier of `resultMeta` (tool histogram, model attribution),
 * token counts, reported cost, git stats and subagent spans — arrives on a
 * terminal row and is refused with 409 {abort:true}. A large share of completed
 * workers therefore had result_meta NULL with zero cost and zero tokens, and
 * that cohort ran far longer than the measured one: every adoption, cost and
 * token rollup was computed on the short-session half of the fleet.
 *
 * What makes this safe:
 *  - It writes measurement only. `status`, `error`, `summary`, `completedAt`,
 *    milestones, verification evidence and structured output are NOT writable
 *    here, and the per-PATCH turn increment is skipped — so it can neither
 *    resurrect a finished worker nor rewrite its outcome.
 *  - It refuses a worker the SERVER terminated (`isNonReactivatableError`:
 *    expiry, heartbeat loss, reassign, human takeover). The runner is gone or
 *    was overruled in those cases, so its late report does not describe the
 *    outcome that was recorded. This keeps the non-reactivatable-termination
 *    protection exactly as strict as it is for a reactivation attempt.
 *  - Numbers only ever go UP. A late report must not lower a figure another
 *    writer (PR route diff stats, server-side cost estimate) already recorded.
 *  - The write is a compare-and-swap on the status that was read, so a row
 *    moving underneath it yields a retryable conflict rather than a stale write.
 */
/**
 * Does this report carry usage? Only then does it say anything about the
 * worker's cost basis (docs/specs/real-and-virtual-cost.md).
 */
function reportCarriesUsage(body: Record<string, any>): boolean {
  const pos = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (pos(body.costUsd) || pos(body.inputTokens) || pos(body.outputTokens)) return true;
  const meta = body.resultMeta;
  if (!meta || typeof meta !== 'object') return false;
  if (meta.totalUsage && typeof meta.totalUsage === 'object') return true;
  return !!meta.modelUsage && typeof meta.modelUsage === 'object' && Object.keys(meta.modelUsage).length > 0;
}

async function applyMetricsOnlyPatch(
  id: string,
  worker: typeof workers.$inferSelect,
  body: Record<string, any>,
  reportedBasis: CostBasis | null,
) {
  if (isNonReactivatableError(worker.error)) {
    const artifactCount = await getWorkerDeliverableArtifactCount(id);
    const deliverables = checkWorkerDeliverables(worker as any, { artifactCount });
    return NextResponse.json({
      error: 'Worker was terminated - task may have been reassigned',
      abort: true,
      metricsAccepted: false,
      reason: worker.error,
      actualStatus: worker.status,
      hasDeliverables: deliverables.hasAny,
    }, { status: 409 });
  }

  const updates: Partial<typeof workers.$inferInsert> = { updatedAt: new Date() };

  // resultMeta is merged, not replaced: a provision-failure shell or an earlier
  // partial report already on the row must not be erased by a later one that
  // happens to carry fewer keys.
  const incomingMeta = body.resultMeta;
  const existingMeta = (worker.resultMeta && typeof worker.resultMeta === 'object' && !Array.isArray(worker.resultMeta))
    ? worker.resultMeta as unknown as Record<string, unknown>
    : {};
  let mergedMeta: Record<string, unknown> = existingMeta;
  if (incomingMeta && typeof incomingMeta === 'object' && !Array.isArray(incomingMeta)) {
    mergedMeta = { ...existingMeta, ...incomingMeta };
    updates.resultMeta = mergedMeta as unknown as typeof updates.resultMeta;
  }

  /** Monotonic: returns the incoming value only when it beats what we have. */
  const raise = (incoming: unknown, existing: number | null | undefined): number | null => {
    if (typeof incoming !== 'number' || !Number.isFinite(incoming) || incoming <= 0) return null;
    return incoming > (existing ?? 0) ? incoming : null;
  };

  // Cost is measurement too — and on the seat/OAuth fleet it is DERIVED, not
  // reported: costUsd arrives as 0 and the token totals are the only signal.
  // The derivation normally happens in the status-transition block, which is
  // gated on `wasTerminal === false`; for this cohort that block already ran at
  // MCP-completion time with no tokens and no resultMeta, produced 0, and will
  // never run again. Deriving here is the difference between "the tokens
  // finally land" and "cost attribution finally works".
  //
  // Deliberately NOT done here: the teams.monthlyCostUsd accumulation and the
  // budget-threshold notifications that sit beside that derivation. Those are
  // spend CONSEQUENCES — back-filling spend that was never counted could cross a
  // threshold and page on history rather than on activity. Making this cohort's
  // spend consume budget is a separate, deliberate decision; see
  // docs/specs/usage-and-cost-accounting.md.
  const reportedCost = typeof body.costUsd === 'number' ? body.costUsd : 0;
  let effectiveCost = reportedCost;
  if (!(effectiveCost > 0)) {
    const perModel = estimateCostUsd(
      mergedMeta.modelUsage as Parameters<typeof estimateCostUsd>[0] | undefined,
    );
    effectiveCost = perModel > 0
      ? perModel
      : estimateCostUsdFromTotals(
        mergedMeta.totalUsage as Parameters<typeof estimateCostUsdFromTotals>[0] | undefined,
        resolveSessionActualModel(
          body.actualModel,
          mergedMeta as Parameters<typeof resolveSessionActualModel>[1],
        ),
      );
  }
  const cost = raise(effectiveCost, Number(worker.costUsd ?? 0));
  if (cost !== null) updates.costUsd = cost.toString();
  if (cost !== null && !(reportedCost > 0)) {
    mergedMeta = { ...mergedMeta, costEstimated: true };
    updates.resultMeta = mergedMeta as unknown as typeof updates.resultMeta;
  }
  if (reportCarriesUsage(body)) {
    updates.costBasis = costBasisWrite(reportedBasis ?? 'unknown') as unknown as CostBasis;
  }
  const inTokens = raise(body.inputTokens, worker.inputTokens);
  if (inTokens !== null) updates.inputTokens = inTokens;
  const outTokens = raise(body.outputTokens, worker.outputTokens);
  if (outTokens !== null) updates.outputTokens = outTokens;
  const commits = raise(body.commitCount, worker.commitCount);
  if (commits !== null) updates.commitCount = commits;
  const files = raise(body.filesChanged, worker.filesChanged);
  if (files !== null) updates.filesChanged = files;
  const added = raise(body.linesAdded, worker.linesAdded);
  if (added !== null) updates.linesAdded = added;
  const removed = raise(body.linesRemoved, worker.linesRemoved);
  if (removed !== null) updates.linesRemoved = removed;
  const spansObserved = raise(body.subagentSpansObserved, worker.subagentSpansObserved);
  if (spansObserved !== null) updates.subagentSpansObserved = spansObserved;
  const bgMs = raise(body.backgroundAgentMs, worker.backgroundAgentMs);
  if (bgMs !== null) updates.backgroundAgentMs = bgMs;

  if (typeof body.lastCommitSha === 'string' && body.lastCommitSha.length > 0) {
    updates.lastCommitSha = body.lastCommitSha;
  }
  if (Array.isArray(body.subagentSpans) && body.subagentSpans.length > 0) {
    updates.subagentSpans = body.subagentSpans;
  }

  const written = Object.keys(updates).filter((k) => k !== 'updatedAt');
  if (written.length === 0) {
    return NextResponse.json({ success: true, metricsOnly: true, updated: [] });
  }

  const [row] = await db
    .update(workers)
    .set(updates)
    .where(worker.status
      ? and(eq(workers.id, id), eq(workers.status, worker.status))
      : eq(workers.id, id))
    .returning();

  if (!row) {
    return NextResponse.json({
      error: 'Worker state changed concurrently',
      conflict: true,
      retryable: true,
      actualStatus: worker.status,
    }, { status: 409 });
  }

  return NextResponse.json({
    success: true,
    metricsOnly: true,
    updated: written,
    actualStatus: row.status,
  });
}

function collectSecretValues(label: string, plaintext: string): Array<{ label: string; value: string }> {
  const values = [{ label, value: plaintext }];
  try {
    const parsed = JSON.parse(plaintext);
    const visit = (value: unknown, path: string) => {
      if (typeof value === 'string') values.push({ label: path, value });
      else if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}.${index}`));
      else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
      }
    };
    visit(parsed, label);
  } catch {
    // Plain scalar secret, already included above.
  }
  return values;
}
/**
 * Check whether a mission's cumulative worker spend has breached its costBudgetUsd
 * cap. If so, atomically transition the mission to budget_exhausted and notify.
 * Returns whether the mission is exhausted so retry classification can honor
 * mission-budget precedence after the terminal worker cost is persisted.
 */
async function checkAndExhaustMissionBudget(missionId: string): Promise<boolean> {
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { id: true, title: true, status: true, costBudgetUsd: true },
  });
  if (!mission || mission.status !== 'active') return mission?.status === 'budget_exhausted';
  if (mission.costBudgetUsd == null) return false;

  const budgetUsd = parseFloat(mission.costBudgetUsd as string);
  const spendUsd = await getMissionSpendUsd(missionId);
  if (spendUsd < budgetUsd) return false;

  await exhaustMissionBudget(missionId, mission.title, spendUsd, budgetUsd);
  return true;
}

/**
 * Auth-failure/success classification against the backend credential.
 *
 * Extracted so the post-supersession path below (a terminal report for a
 * worker `/respond` already answered) can run the IDENTICAL classify →
 * attribute → record sequence a live terminal transition gets. Credential
 * health is about the CREDENTIAL, not the reporting worker's own recorded
 * outcome — a dead credential kills the continuation task exactly as it
 * would kill this worker, so it must not matter which one told us first.
 */
async function recordCredentialHealthForOutcome(
  taskId: string | null,
  status: string,
  error: string | null | undefined,
): Promise<void> {
  if (!taskId) return;
  const taskForHealth = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { backend: true, workspaceId: true },
    with: { workspace: { columns: { teamId: true } } },
  });
  const teamId = (taskForHealth?.workspace as { teamId?: string } | undefined)?.teamId;
  if (!teamId) return;

  const backend = (taskForHealth as any)?.backend as string | undefined;
  const workspaceId = taskForHealth?.workspaceId ?? null;

  if (status === 'failed' && error) {
    const severity = classifyAuthErrorSeverity(error);
    if (severity !== 'none') {
      let secretId: string | null = null;
      if (!backend || backend === 'claude') {
        secretId = await getActiveClaudeSecretId(teamId, workspaceId);
      } else if (backend === 'codex') {
        // For Codex tasks, detect whether the failure was actually caused by
        // a Claude/Anthropic auth error (leaked Claude creds, misconfiguration)
        // rather than a Codex/OpenAI auth error. Attributing a Claude error to
        // the Codex credential falsely marks it revoked/degraded.
        const isClaudeOriginError = /access token could not be refreshed|logged out or signed in to another account|invalid authentication credentials|anthropic/i.test(error);
        if (isClaudeOriginError) {
          console.warn(`[workers PATCH] Codex task ${taskId} failed with a Claude auth error — attributing to Claude credential, not Codex`);
          secretId = await getActiveClaudeSecretId(teamId, workspaceId);
        } else {
          const codexRow = await db.query.secrets.findFirst({
            where: and(eq(secretsTable.teamId, teamId), eq(secretsTable.purpose, 'codex_credential')),
            columns: { id: true },
          });
          secretId = codexRow?.id ?? null;
        }
      }

      if (secretId) {
        const result = await recordCredentialAuthFailure(secretId, error);
        if (result?.becameRevoked) {
          void notifyTeam(teamId, 'credentialExpired', {
            title: '🔑 Credential revoked — action required',
            message: `Backend credential (${backend ?? 'claude'}) was revoked. Sign in again under Settings, Runners.\nError: ${error.slice(0, 150)}`,
            url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev'}/app/settings/runners`,
            urlTitle: 'Open settings',
            priority: 1,
          });
        }
      }
    }
  } else if (status === 'completed') {
    let secretId: string | null = null;
    if (!backend || backend === 'claude') {
      secretId = await getActiveClaudeSecretId(teamId, workspaceId);
    } else if (backend === 'codex') {
      const codexRow = await db.query.secrets.findFirst({
        where: and(eq(secretsTable.teamId, teamId), eq(secretsTable.purpose, 'codex_credential')),
        columns: { id: true },
      });
      secretId = codexRow?.id ?? null;
    }
    if (secretId) await recordCredentialAuthSuccess(secretId);
  }
}

/**
 * Record a terminal failure report for a worker `/respond` already marked
 * `superseded` before this PATCH's own terminal-ownership CAS could land.
 *
 * Does NOT touch `status` — the row stays `superseded`, exactly as
 * `IN_FLIGHT_WORKER_STATUSES`/`FAILED_WORKER_STATUSES` in lib/failure-analytics
 * require, so this can never flip a superseded worker back into the failure
 * rate. It records the error on a side field instead (`postSupersessionError`),
 * inserts the same `worker_error_traces` row a live failure would get (so
 * `get_error_traces` sees it regardless of whether this PATCH's own
 * `appendErrorTraces` array — processed unconditionally above, before this
 * CAS ever runs — happened to carry anything), and feeds credential health.
 *
 * CAS'd on `status = 'superseded'` rather than trusting the caller's
 * already-stale `worker` read: `workerConflictResponse` re-reads the row for
 * the same reason, and this function is only ever called on that re-read's
 * conflict path, so a row that moved to some OTHER terminal status between
 * those two reads should not have this write land either — it silently no-ops.
 */
async function recordPostSupersessionError(
  id: string,
  error: string,
  isSensitive: boolean,
): Promise<boolean> {
  const trimmed = error.slice(0, 2000);
  const [row] = await db
    .update(workers)
    .set({
      postSupersessionError: trimmed,
      postSupersessionErrorAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(workers.id, id), eq(workers.status, 'superseded')))
    .returning({ id: workers.id, taskId: workers.taskId });

  if (!row) return false;

  try {
    await db.insert(workerErrorTraces).values({
      workerId: id,
      taskId: row.taskId,
      pattern: 'post_supersession_error',
      excerpt: isSensitive ? '' : trimmed.slice(0, 500),
      source: 'post_supersession',
    });
  } catch (err) {
    console.error(`[Worker ${id}] Failed to insert post-supersession error trace:`, err);
  }

  try {
    await recordCredentialHealthForOutcome(row.taskId, 'failed', trimmed);
  } catch (err) {
    console.error(`[Worker ${id}] Failed to record credential health for post-supersession error:`, err);
  }
  return true;
}

// GET /api/workers/[id] - Get worker details
/** The `waitingFor` fields a sensitive workspace keeps: no prose, only what Needs You admission and hold resurfacing read. */
const SENSITIVE_PARK_FIELDS: ReadonlySet<string> = new Set(['disposition', 'dispositionBy', 'gateOutcome', 'rail', 'repairTaskId']);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  // A per-task token (cloud container) may read only its own worker.
  const account = await authenticateTaskScopedCaller(apiKey, req);
  // GET also accepts the dashboard session (the in-app chat reads worker
  // milestones as the signed-in user). PATCH stays worker-key-only. A key,
  // when present, is authoritative.
  const sessionUser = account ? null : await getCurrentUser();

  if (!account && !sessionUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // A non-UUID can never name a worker; querying with one throws 22P02 (a 500).
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    with: { task: true, workspace: true },
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  // The workspace row carries the webhook dispatch bearer token; neither a
  // team member reading a worker nor a cloud container has any use for it.
  const redacted = () => ({ ...worker, workspace: withoutDispatchToken(worker.workspace) });

  if (!account) {
    // Session: membership of the worker workspace's team, as on the dashboard.
    // Outside it the worker does not exist for this caller.
    const access = worker.workspaceId ? await verifyWorkspaceAccess(sessionUser!.id, worker.workspaceId) : null;
    if (!access) {
      return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
    }
    return NextResponse.json(redacted());
  }

  // Only the claiming principal: the account for a bld_ key, the session user
  // for an OAuth session (lib/worker-owner.ts). No team fallback; fails closed.
  if (!callerOwnsWorker(account, worker)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return NextResponse.json(account.taskScope ? redacted() : worker);
}

// PATCH /api/workers/[id] - Update worker status
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  // A per-task token (cloud container) may update only its own worker.
  const account = await authenticateTaskScopedCaller(apiKey, req);

  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
  });

  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  // Only the claiming principal: the account for a bld_ key, the session user
  // for an OAuth session (lib/worker-owner.ts). No team fallback; fails closed.
  if (!callerOwnsWorker(account, worker)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Resolve workspace sensitivity once — used throughout the handler to redact prose.
  const wsForSensitivity = worker.workspaceId
    ? await db.query.workspaces.findFirst({
        where: eq(workspaces.id, worker.workspaceId),
        columns: { dataClass: true, teamId: true, gitConfig: true },
      })
    : null;
  const isSensitive = wsForSensitivity?.dataClass === 'sensitive';

  let body = await req.json();

  // Server-side secret redaction (defense in depth). Resolve every secret
  // applicable to the worker's team/account/workspace, then recursively scrub
  // the complete request before any DB write or Pusher emission.
  const secretValues: Array<{ label: string; value: string }> = [];
  try {
    if (worker.workspaceId && wsForSensitivity?.teamId) {
      const credRows = await db.query.secrets.findMany({
        where: and(
          eq(secretsTable.teamId, wsForSensitivity.teamId),
          or(isNull(secretsTable.workspaceId), eq(secretsTable.workspaceId, worker.workspaceId)),
          worker.accountId
            ? or(isNull(secretsTable.accountId), eq(secretsTable.accountId, worker.accountId))
            : isNull(secretsTable.accountId),
        ),
        columns: { encryptedValue: true, label: true, purpose: true },
      });
      for (const row of credRows) {
        try {
          const val = decrypt(row.encryptedValue);
          if (val) secretValues.push(...collectSecretValues(row.label || row.purpose, val));
        } catch {
          // Non-fatal: skip credentials that fail decryption
        }
      }
    }

  } catch {
    // Pattern redaction below still runs if secret lookup is unavailable.
  }
  // Captured pre-redaction: this is an echo of the queued instruction text and is
  // compared byte-for-byte against the stored queue to clear it. Redacting the
  // echo (but not the stored copy) would make that compare-and-set never match,
  // so the same instruction would be served forever. It is never persisted.
  const rawInstructionsDelivered: unknown = body.instructionsDelivered;
  // Ack for worker→worker messages: the ids the consumer has actually shown to
  // the agent. Captured pre-redaction for the same reason as the instruction
  // echo — these are compared against the stored queue, never persisted as text.
  const rawWorkerMessagesDelivered: unknown = body.workerMessagesDelivered;
  body = redactSecretsInBody(body, secretValues);

  const basisParse = parseCostBasis(body.costBasis);
  if (!basisParse.ok) {
    return NextResponse.json({
      error: 'invalid_cost_basis',
      message: 'costBasis must be one of real, virtual, mixed, unknown.',
    }, { status: 400 });
  }
  const reportedBasis = basisParse.basis;
  const carriesUsage = reportCarriesUsage(body);

  // Metrics-only write: measurement about a session, no state transition. Must
  // be handled BEFORE the terminal guard below — a terminal worker is exactly
  // the case it exists for (the agent completed the task itself via the MCP, so
  // the runner's terminal PATCH lands on an already-completed row). See
  // applyMetricsOnlyPatch for what it may and may not write.
  if (body.metricsOnly === true) {
    return await applyMetricsOnlyPatch(id, worker, body, reportedBasis);
  }

  // Check if worker was already terminated (reassigned/failed)
  // Allow reactivation with 'running' status for follow-up messages from runner,
  // but NOT if the worker was auto-expired by cleanup (stale/timeout/heartbeat).
  // True when this request is deliberately writing over a terminal row it read
  // (a follow-up 'running' update). Such a write keeps the strict equality CAS —
  // the lost-update tolerance below must not apply to a resurrection.
  let reactivatingTerminalWorker = false;
  if (worker.status === 'failed' || worker.status === 'completed' || worker.status === 'error') {
    // Reactivation must be requested EXPLICITLY. The runner's deliberate resume
    // (sendMessage follow-up) sets `reactivate: true`; its periodic 10s keepalive
    // sync does not, and the two payloads are otherwise identical.
    //
    // Inferring intent from `worker.error` instead — as this did — silently
    // resurrected cleanly completed workers: a successful completion has
    // `error: null`, so every string check below was undefined, the guard fell
    // open, and a keepalive tick landing after the agent's complete_task wiped
    // both the worker's completion and the task's completed status. The row then
    // sat at 'running' with a frozen updatedAt (nothing re-syncs a locally-done
    // worker) until the reaper killed it — a task that finished healthy, killed.
    //
    // The window is wide because the runner's local status stays 'working' until
    // the SDK session ends, which is after complete_task AND after any
    // verificationCommand run, so verified/looped tasks were hit hardest.
    const reactivateRequested = body.reactivate === true;
    // Even an explicit request must not revive a worker the server itself
    // expired — the runner is gone or was killed, so there is nothing to resume.
    // The phrase list lives in @/lib/worker-termination so every terminator
    // (reassign, interrupt, stale cleanup) and every reader agree on it.
    const isNonReactivatableTermination = isNonReactivatableError(worker.error);
    if (body.status !== 'running' || !reactivateRequested || isNonReactivatableTermination) {
      // Enrich 409 with deliverable info so the runner can distinguish
      // "already completed successfully" from "genuinely terminated/reassigned"
      const artifactCount = await getWorkerDeliverableArtifactCount(id);
      const deliverables = checkWorkerDeliverables(worker, { artifactCount });
      return NextResponse.json({
        error: (worker.status === 'failed' || worker.status === 'error')
          ? 'Worker was terminated - task may have been reassigned'
          : 'Worker already completed',
        abort: true,
        reason: worker.error || worker.status,
        actualStatus: worker.status,
        hasDeliverables: deliverables.hasAny,
      }, { status: 409 });
    }
    // Reactivation: clear completion timestamp so worker can run again
    reactivatingTerminalWorker = true;
  }

  // connector_auth_expired: mark the MCP connector secret as expired and broadcast to the workspace.
  // For assertion-mode connectors this fires only when re-exchange is exhausted (runner sets the flag).
  // For oauth/static connectors it fires on the first 401.
  if (body.event === 'connector_auth_expired' && typeof body.connectorId === 'string') {
    const connectorRow = await db.query.connectors.findFirst({
      where: eq(connectors.id, body.connectorId),
      columns: { id: true, name: true, teamId: true },
    });
    if (connectorRow) {
      await db
        .update(secrets)
        .set({ tokenExpiresAt: sql`NOW()`, lastVerificationError: 'mid_task_401', updatedAt: sql`NOW()` })
        .where(teamCredentialWhere({ teamId: connectorRow.teamId, purpose: 'mcp_connector_credential', label: body.connectorId }));
      void triggerEvent(
        channels.workspace(worker.workspaceId),
        events.WORKER_CONNECTOR_AUTH_EXPIRED,
        { workerId: id, connectorId: body.connectorId, connectorName: connectorRow.name },
      );
    }
  }

  // connector_permission_insufficient: the connector token is valid but the GitHub App
  // installation lacks a required permission scope (403 "Resource not accessible by integration").
  // We do NOT expire the secret — the credential itself is fine. We record the permission gap
  // and broadcast so the workspace can surface a fix hint.
  if (body.event === 'connector_permission_insufficient' && typeof body.connectorId === 'string') {
    const connectorRow = await db.query.connectors.findFirst({
      where: eq(connectors.id, body.connectorId),
      columns: { id: true, name: true, teamId: true },
    });
    if (connectorRow) {
      await db
        .update(secrets)
        .set({ lastVerificationError: 'mid_task_403_permission', updatedAt: sql`NOW()` })
        .where(teamCredentialWhere({ teamId: connectorRow.teamId, purpose: 'mcp_connector_credential', label: body.connectorId }));
      void triggerEvent(
        channels.workspace(worker.workspaceId),
        events.WORKER_CONNECTOR_PERMISSION_INSUFFICIENT,
        { workerId: id, connectorId: body.connectorId, connectorName: connectorRow.name },
      );
    }
  }

  const {
    // `let` below, not destructured as const: a completion that lands on a
    // task already cancelled server-side is rewritten to a `failed` /
    // task_cancelled report before the output gate runs (see
    // taskCancelledUnderSession).
    status: reportedStatus, error: reportedError, costUsd, turns, localUiUrl, currentAction, milestones,
    appendMilestones,
    appendMcpCalls,
    appendErrorTraces,
    appendActionEvents,
    appendPromptCompositionEvents,
    waitingFor,
    // Worker self-classification of the work it is actually doing. Written to
    // tasks.kind only when that column is still NULL — see the guarded stamp
    // below and docs/specs/mission-legibility.md §2.6.
    kind: reportedKind,
    // Token usage
    inputTokens, outputTokens,
    // The model the session actually ran on, as reported by the runner.
    // Optional: an older runner omits it and the server derives what it can.
    actualModel,
    // Actual branch checked out in worktree (may differ from claim-time branch
    // when setupWorktree honors a resumeBranch). Persisted so reviewer/CI retry
    // dispatch reads the correct branch from the DB for the next retry's context.
    branch,
    // Git stats
    lastCommitSha, commitCount, filesChanged, linesAdded, linesRemoved,
    // `git status --porcelain` (tracked files only) at the worker's worktree,
    // refreshed by the runner's periodic sync. Read by the complete_task gate
    // below — see the 'auto' output-requirement block.
    dirtyWorktree,
    // Explicit complete_task acknowledgement that worktree edits (commits or
    // uncommitted changes) are being intentionally thrown away — a first-class
    // success exit for the 'auto' output-requirement gate below, distinct from
    // the `error` param (which marks the task failed).
    discardEdits,
    // complete_task's claim that a pr_required task's work already landed in
    // a merged PR it does not own. Checked against GitHub by the
    // outputRequirement gate below, never trusted as given.
    alreadyShippedIn,
    // SDK result metadata
    resultMeta,
    // Transient subagent progress (not persisted — forwarded via Pusher only)
    taskProgress,
    // Self-reported PR (for runners that create PRs outside the create_pr action)
    prUrl: selfReportedPrUrl,
    prNumber: selfReportedPrNumber,
    // Loop verification evidence (spec §2). Included when loopConfig.exitCondition.type='command'.
    verificationEvidence,
    // Subagent spans — persisted at terminal status only (completed/failed/error).
    // Runners only send these on terminal transitions; the server writes them through
    // unconditionally (no guard needed — hot-path updates never include them).
    subagentSpans,
    subagentSpansObserved,
    backgroundAgentMs,
    // Passive observed-touches: incremental list from git diff --name-only on the runner.
    // Server accumulates into workers.observedTouches for §6d collision detection.
    touchedPaths,
    // Runner pre-push/completion sweep: re-offer every touchedPaths entry for
    // lease, not only the ones new to observedTouches (see auto-lease below).
    checkpointSweep,
    // Authoritative working-set delta (lib/working-set-sync.ts): the paths
    // added to / removed from the task-owned set since the last ACK. When
    // present it is what gets leased; touchedPaths is then only the sample.
    workingSet: rawWorkingSet,
    // Ship checkpoints the runner could not prove while the server was
    // unreachable, reported on the first sync that lands.
    shipCheckpoints: rawShipCheckpoints,
    // Enforce-mode path claims: the checkpoint collision a `Deferred:` failure
    // is based on (lib/path-collision-deferral.ts). Ignored on anything else.
    pathCollision: reportedPathCollision,
    // Path-claim calls the runner let through degraded since its last report
    // (a delta) — the declaration denominator, conflict-aware-orchestration.md §3.
    pathClaimDegraded: reportedPathClaimDegraded,
    // Set by the runner's startup reconciliation (worker-sync.ts
    // restoreWorkersFromDisk) when it finds a local session whose process died
    // without ever reporting a terminal status — never sent by a live session.
    // The cloud runner's supervisor (apps/cloud-runner/src/supervisor.ts) sends
    // it for the same fact: the container or the runner process died before the
    // runner reported. Either way it rides the infra-retry budget below.
    // Distinguishes a terminal record's outcome ('crashed') from an ordinary
    // agent-reported failure, since both arrive as status: 'failed'.
    crashReconciled,
    // Live sibling conflict probe (lib/sibling-conflict-probe.ts): results of
    // the merge-tree probes this runner was handed, and whether it can run them.
    siblingProbeResults,
    siblingProbe: supportsSiblingProbe,
  } = body;
  let status = reportedStatus;
  let error = reportedError;

  // ── Who may consume the human-instruction queue ────────────────────────────
  //
  // `workers.pendingInstructions` is a delivery queue with exactly one real
  // consumer: the runner's sync loop, which injects the text into the live agent
  // session. Every other caller of this route (milestone updates, branch
  // registration, status transitions, the hook-driven waiting_input PATCHes)
  // ignores the response body entirely.
  //
  // The queue used to be cleared on EVERY PATCH, so an ordinary milestone update
  // silently threw away an undelivered instruction. Only a declared consumer may
  // move the queue now:
  //
  //  - `consumeInstructions: true` — the runner's sync loop. It receives the
  //    payload plus `instructionsAck`, injects it, and confirms with
  //    `instructionsDelivered: <text>`; the queue is cleared on that
  //    confirmation, never before.
  //  - a `milestones` / `appendMilestones` array and no flag — a client that
  //    predates the confirmation protocol (an older runner sync, an external
  //    worker posting progress). It gets the old drain-on-read behaviour, because
  //    it will never send a confirmation and re-serving forever would make it
  //    re-deliver the same message on every progress update.
  //  - anything else — receives a read-only copy (no state change), so an
  //    external worker implementation that reads `instructions` keeps working
  //    while the queue survives for the real consumer.
  const instructionAckText = typeof rawInstructionsDelivered === 'string' && rawInstructionsDelivered.length > 0
    ? rawInstructionsDelivered
    : null;
  const deliveredMessageIds = Array.isArray(rawWorkerMessagesDelivered)
    ? rawWorkerMessagesDelivered.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];
  const declaresInstructionConsumer = body.consumeInstructions === true;
  const legacyInstructionConsumer = !declaresInstructionConsumer
    && !instructionAckText
    && (Array.isArray(milestones) || Array.isArray(appendMilestones));
  const instructionConsumer = declaresInstructionConsumer || legacyInstructionConsumer;

  const updates: Partial<typeof workers.$inferInsert> = {
    updatedAt: new Date(),
  };

  // Record the runner's protocol capability so /instruct and /cmd know whether a
  // delivery can ever be confirmed for this worker.
  if (declaresInstructionConsumer && !(worker as { supportsInstructionAck?: boolean }).supportsInstructionAck) {
    updates.supportsInstructionAck = true;
  }

  if (status) updates.status = status;
  if (error !== undefined) updates.error = error;
  if (typeof costUsd === 'number') updates.costUsd = costUsd.toString();
  if (carriesUsage) updates.costBasis = costBasisWrite(reportedBasis ?? 'unknown') as unknown as CostBasis;
  if (typeof inputTokens === 'number') updates.inputTokens = inputTokens;
  if (typeof outputTokens === 'number') updates.outputTokens = outputTokens;
  if (typeof turns === 'number') updates.turns = turns;
  // Infer turns from resultMeta.numTurns when not explicitly provided (external runners send resultMeta but not turns)
  else if (resultMeta && typeof resultMeta.numTurns === 'number' && resultMeta.numTurns > 0) updates.turns = resultMeta.numTurns;
  // Auto-increment turns for MCP workers that don't send explicit turn counts.
  // A bare delivery acknowledgement is bookkeeping, not a turn — counting it
  // would inflate turns (and the OAuth budget window that reads them). This
  // covers both queues: instructionsDelivered and workerMessagesDelivered are
  // each sent as their own PATCH carrying nothing else.
  else if (!((instructionAckText || deliveredMessageIds.length > 0) && status === undefined && currentAction === undefined && milestones === undefined)) {
    updates.turns = sql`${workers.turns} + 1` as any;
  }
  if (localUiUrl !== undefined) updates.localUiUrl = localUiUrl;
  // Sensitive: generic state string instead of prose action description
  if (currentAction !== undefined) updates.currentAction = isSensitive ? 'working' : currentAction;
  // Sensitive: keep {type, ts} only — strip label and metadata prose
  if (milestones !== undefined) {
    updates.milestones = isSensitive
      ? (milestones as any[]).map((m: any) => ({ type: m.type, ts: m.ts }))
      : milestones;
  }
  // appendMilestones: merge new milestones into existing (for MCP workers)
  if (appendMilestones && Array.isArray(appendMilestones)) {
    const existing = (worker.milestones as any[]) || [];
    const toAppend = isSensitive
      ? appendMilestones.map((m: any) => ({ type: m.type, ts: m.ts }))
      : appendMilestones;
    const merged = [...existing, ...toAppend];
    updates.milestones = merged.length > 50 ? merged.slice(-50) : merged;
  }
  // appendMcpCalls: merge new MCP tool calls into existing log
  if (appendMcpCalls && Array.isArray(appendMcpCalls)) {
    const existing = (worker.mcpCalls as any[]) || [];
    const merged = [...existing, ...appendMcpCalls];
    updates.mcpCalls = merged.length > 100 ? merged.slice(-100) : merged;
  }
  // appendErrorTraces: insert pattern-matched errors into worker_error_traces.
  // Runner throttles same-pattern traces at the source, so we trust the
  // payload here without additional dedup. Excerpts are clamped to 500 chars
  // as a defense against a runaway agent posting megabytes of stderr.
  if (appendErrorTraces && Array.isArray(appendErrorTraces) && appendErrorTraces.length > 0) {
    const rows = appendErrorTraces
      .filter((t: any) => t && typeof t.pattern === 'string' && typeof t.excerpt === 'string')
      .slice(0, 50)  // hard cap per request to bound write volume
      .map((t: any) => ({
        workerId: worker.id,
        taskId: worker.taskId,
        pattern: String(t.pattern).slice(0, 100),
        // Sensitive: drop excerpt prose, keep only pattern/source/ts for structured analysis
        excerpt: isSensitive
          ? ''
          : String(t.excerpt).slice(
              0,
              t.pattern === BASH_FAILURE_PATTERN || t.pattern === BASH_RECOVERED_PATTERN ? BASH_TRACE_EXCERPT_MAX : 500,
            ),
        source: typeof t.source === 'string' ? t.source.slice(0, 50) : null,
      }));
    if (rows.length > 0) {
      try {
        await db.insert(workerErrorTraces).values(rows);
      } catch (err) {
        console.error('[workers PATCH] failed to insert error traces', err);
      }
    }
  }
  // appendActionEvents: insert per-call buildd MCP action events into
  // worker_action_events (health-analytics-spec §4.3 item 1 / WU-4). Action
  // names are structured tokens (not prose), so isSensitive doesn't strip
  // them — same treatment as `pattern` above, unlike `excerpt`. A hard cap
  // per request bounds write volume the same way appendErrorTraces does;
  // 200 rather than 50 because every buildd call lands here, not just errors.
  if (appendActionEvents && Array.isArray(appendActionEvents) && appendActionEvents.length > 0) {
    const rows = appendActionEvents
      .filter((e: any) => e && typeof e.action === 'string' && e.action.length > 0 && typeof e.ts === 'number')
      .slice(0, 200)
      .map((e: any) => ({
        workerId: worker.id,
        taskId: worker.taskId,
        action: String(e.action).slice(0, 100),
        ts: new Date(e.ts),
      }));
    if (rows.length > 0) {
      try {
        await db.insert(workerActionEvents).values(rows);
      } catch (err) {
        console.error('[workers PATCH] failed to insert action events', err);
      }
    }
  }
  // appendPromptCompositionEvents: insert one row per prompt build into
  // worker_prompt_composition_events (the durable rail the memory-digest
  // experiment reads back — see PromptCompositionRecord in
  // apps/runner/src/memory-digest-policy.ts). Cap at 50 rather than
  // appendActionEvents' 200: a session builds a handful of prompts, not one
  // row per MCP call. onConflictDoNothing guards the (worker_id, build_index)
  // unique index — the runner restores a drained buffer and retries on a
  // failed PATCH, so the same buildIndex can legitimately be shipped twice.
  if (appendPromptCompositionEvents && Array.isArray(appendPromptCompositionEvents) && appendPromptCompositionEvents.length > 0) {
    const rows = appendPromptCompositionEvents
      .filter((e: any) => e
        && typeof e.buildIndex === 'number' && Number.isFinite(e.buildIndex)
        && typeof e.ts === 'number'
        && typeof e.policyVersion === 'string' && e.policyVersion.length > 0
        && (e.arm === 'full' || e.arm === 'task_scoped')
        && typeof e.propensity === 'number'
        && typeof e.fraction === 'number'
        && typeof e.digestBytes === 'number'
        && typeof e.digestBytesAvailable === 'number'
        && typeof e.digestTruncated === 'boolean'
        && typeof e.taskMatchBytes === 'number'
        && typeof e.taskMatchCount === 'number'
        && typeof e.memoryBlockBytes === 'number'
        && typeof e.promptBytes === 'number'
        && typeof e.memoryShare === 'number')
      .slice(0, 50)
      .map((e: any) => ({
        workerId: worker.id,
        taskId: worker.taskId,
        buildIndex: e.buildIndex,
        ts: new Date(e.ts),
        policyVersion: String(e.policyVersion).slice(0, 100),
        arm: e.arm,
        propensity: String(e.propensity),
        fraction: String(e.fraction),
        digestBytes: e.digestBytes,
        digestBytesAvailable: e.digestBytesAvailable,
        digestTruncated: e.digestTruncated,
        taskMatchBytes: e.taskMatchBytes,
        taskMatchCount: e.taskMatchCount,
        // Both deliberately absent from the validation filter above: a runner
        // that predates these fields must still be able to write a row, and
        // NULL there is the honest record of "this runner did not report it".
        // Coercing them to a default would pool an unknown backend into the
        // Claude cohort and an unknown provenance into a real one.
        taskMatchDerivedBy: typeof e.taskMatchDerivedBy === 'string' && e.taskMatchDerivedBy
          ? e.taskMatchDerivedBy.slice(0, 40)
          : null,
        backend: typeof e.backend === 'string' && e.backend ? e.backend.slice(0, 40) : null,
        memoryBlockBytes: e.memoryBlockBytes,
        promptBytes: e.promptBytes,
        memoryShare: String(e.memoryShare),
        // Same absent-from-the-strict-filter treatment as taskMatchDerivedBy/
        // backend above: a runner predating this field cannot report it, and
        // NULL is the honest record of "unknown" rather than "empty".
        sections: Array.isArray(e.sections) ? e.sections.slice(0, 32) : null,
      }));
    if (rows.length > 0) {
      try {
        await db.insert(workerPromptCompositionEvents).values(rows).onConflictDoNothing();
      } catch (err) {
        console.error('[workers PATCH] failed to insert prompt composition events', err);
      }
    }
  }
  // Branch: persist actual checkout branch when resume branch was used
  if (typeof branch === 'string' && branch.length > 0) updates.branch = branch;
  // Git stats
  if (lastCommitSha !== undefined) updates.lastCommitSha = lastCommitSha;
  // §6.9 provenance: a repair attempt's reported local head joins its SHA set, so the push that
  // carries it is recognised as this attempt's by SHA, never by commit author.
  if (typeof lastCommitSha === 'string' && lastCommitSha && lastCommitSha !== worker.lastCommitSha && worker.taskId) {
    await recordLocalHead(worker.taskId, lastCommitSha).catch((err) => console.error(`[workflow] recordLocalHead failed for worker ${worker.id}:`, err));
  }
  if (typeof commitCount === 'number') updates.commitCount = commitCount;
  // Prefer non-zero existing stats over zeros from the runner: if the PR creation route
  // already recorded real diff stats and the runner reports 0 (e.g. wrong git base), keep the real values.
  if (typeof filesChanged === 'number' && (filesChanged > 0 || !(worker.filesChanged ?? 0))) updates.filesChanged = filesChanged;
  if (typeof linesAdded === 'number' && (linesAdded > 0 || !(worker.linesAdded ?? 0))) updates.linesAdded = linesAdded;
  if (typeof linesRemoved === 'number' && (linesRemoved > 0 || !(worker.linesRemoved ?? 0))) updates.linesRemoved = linesRemoved;
  if (typeof dirtyWorktree === 'boolean') updates.dirtyWorktree = dirtyWorktree;
  // Loop verification evidence: persisted from any PATCH that carries it. The
  // one that matters is the runner's pre-complete_task write (a non-terminal
  // PATCH) — the agent's complete_task that follows carries none, and the
  // loop dispatch below falls back to what is stored here.
  if (verificationEvidence && typeof verificationEvidence === 'object' && !Array.isArray(verificationEvidence)) {
    updates.verificationEvidence = verificationEvidence as Record<string, unknown>;
  }
  // Set when the incoming question carries a `hold` tag; null = an ordinary ask.
  let hold: HoldResolution | null = null;
  // Whether this PATCH's park may reach a person now (lib/park-disposition.ts).
  let parkAdmitted = false;
  // Waiting state — sensitive: store type only, drop prompt prose
  if (waitingFor !== undefined) {
    // Contract violation: the agent stopped and asked, but stated no real
    // question — either the runner's own fallback text (no question content
    // was ever passed to AskUserQuestion) or an empty/whitespace prompt. A
    // human opening this learns nothing and has to reconstruct the ask from
    // the transcript, so flag it rather than accept it silently. The flag is
    // a boolean, not prose, so it survives sensitive-workspace redaction.
    const isContentlessQuestion = waitingFor?.type === 'question'
      && (!waitingFor.prompt || !waitingFor.prompt.trim() || waitingFor.prompt.trim() === 'Awaiting input');
    // Question brief (packages/core/question-brief.ts): optional, validated
    // and capped here so a malformed field is dropped, never a refused park.
    const briefed = waitingFor !== null && waitingFor?.type === 'question'
      ? withSanitizedBrief(waitingFor)
      : waitingFor;
    // Needs You admission (lib/park-disposition.ts): every park is stamped
    // with a human-attention disposition before it is stored — the gate's
    // own (`ask`, or a `hold` lib/question-hold.ts decides whether to honour),
    // or the server's re-check of an untagged park (an older runner, a failed
    // gate call): hard rails, then stage 0, which routes a recoverable
    // platform blocker to a repair task instead of a person.
    let stored = briefed;
    if (briefed) {
      const parkTask = worker.taskId
        ? await db.query.tasks.findFirst({ where: eq(tasks.id, worker.taskId), columns: { title: true, pathManifest: true, missionId: true } })
        : null;
      const gitConfig = wsForSensitivity?.gitConfig ?? null;
      const parked = await disposeParkedWaitingFor({
        waitingFor: briefed as Record<string, unknown>,
        stored: worker.waitingFor as Record<string, unknown> | null,
        scope: worker.taskId && wsForSensitivity?.teamId
          ? {
              teamId: wsForSensitivity.teamId,
              workspaceId: worker.workspaceId,
              accountId: worker.accountId ?? null,
              taskId: worker.taskId,
              missionId: parkTask?.missionId ?? null,
              workerId: id,
              taskTitle: parkTask?.title ?? null,
              sensitive: isSensitive,
              gateEnabled: gateEnabledFromGitConfig(gitConfig),
              hardRail: { ...hardRailContextFromGitConfig(gitConfig), pathManifest: parkTask?.pathManifest ?? null },
            }
          : null,
        gitConfig,
        sensitive: isSensitive,
        pathManifest: parkTask?.pathManifest ?? null,
        nowMs: Date.now(),
        repairTaskExists: async (repairId) => isUuid(repairId) && !!(await db.query.tasks.findFirst({
          where: and(eq(tasks.id, repairId), eq(tasks.workspaceId, worker.workspaceId)),
          columns: { id: true },
        })),
        deps: { fileRepair: RECOVERABLE_BLOCKER_REPAIR },
      });
      hold = parked.hold;
      parkAdmitted = parked.admitted;
      stored = parked.waitingFor as typeof briefed;
    }
    // Sensitive: no prose, but the disposition fields are not prose and must
    // survive — Needs You admission reads them.
    const sensitiveStored = stored
      ? Object.fromEntries(Object.entries(stored).filter(([k]) => SENSITIVE_PARK_FIELDS.has(k)))
      : null;
    updates.waitingFor = (isSensitive && waitingFor !== null)
      ? { ...sensitiveStored, type: waitingFor.type, ...(isContentlessQuestion ? { contractViolation: true } : {}) }
      : (stored !== null && isContentlessQuestion ? { ...stored, contractViolation: true } : stored);
  }
  // Notification when agent needs input — sensitive: generic message only.
  // Team Pushover channel + the originating chat conversation. Only an
  // admitted park notifies: a held question is notified by the resurface
  // sweep at its deadline (lib/question-hold.ts), a recovered one never.
  if (waitingFor?.type === 'question' && parkAdmitted) {
    const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev';
    // Short by design: the question, one line of context, the recommended default.
    const note = questionNotificationText(
      withSanitizedBrief(waitingFor),
      { sensitive: isSensitive },
    );
    void notifyTeamOf({ workspaceId: worker.workspaceId }, 'needsAttention', {
      title: note.title,
      message: note.message,
      url: `${appBaseUrl}/app/tasks/${worker.taskId}/respond`,
      urlTitle: 'Respond',
      priority: 0,
    });
    // Agent chat: a mission filed from a conversation gets the question posted
    // back into it. Lazy + best-effort: never on this PATCH's critical path.
    if (worker.taskId) {
      const taskId = worker.taskId;
      void import('@/lib/chat/mission-events')
        .then(m => m.postQuestionEvent({ taskId, workerId: id, prompt: waitingFor.prompt, sensitive: isSensitive }))
        .catch(() => {});
    }
  }
  // Auto-clear waitingFor when worker resumes running
  if (status === 'running' && waitingFor === undefined) updates.waitingFor = null;
  // A permission prompt dies with its session: the runner resolves the blocked
  // PermissionRequest hook as deny when it aborts, but reports only the terminal
  // status. Left in place, the ended worker renders a live "Allow once / Deny"
  // card that can grant nothing. A question is kept — an AskUserQuestion abort
  // is meant to be answered after the session ends.
  if (
    waitingFor === undefined
    && isTerminalWorkerStatus(status)
    && (worker.waitingFor as { type?: string } | null)?.type === 'permission'
  ) {
    updates.waitingFor = null;
  }
  // SDK result metadata
  if (resultMeta !== undefined) updates.resultMeta = resultMeta;
  // Subagent spans (terminal flush — runner only sends on completed/failed/error).
  if (Array.isArray(subagentSpans)) updates.subagentSpans = subagentSpans;
  if (typeof subagentSpansObserved === 'number') updates.subagentSpansObserved = subagentSpansObserved;
  if (typeof backgroundAgentMs === 'number') updates.backgroundAgentMs = backgroundAgentMs;
  // Self-reported PR (for runners that open PRs outside the create_pr MCP
  // action). An agent run's report is held to create_pr's questions — linked
  // repo, a head the task owns, the mission base — before it is recorded
  // (lib/agent-capabilities/reported-pr.ts). A refused report drops only the
  // PR fields; the rest of this PATCH still applies. A person's session on
  // the shared account, and a workspace with no App to verify against, keep
  // recording it as given.
  const reportedPrUrl = typeof selfReportedPrUrl === 'string' && selfReportedPrUrl ? selfReportedPrUrl : null;
  const reportedPrNumber = typeof selfReportedPrNumber === 'number' && selfReportedPrNumber > 0 ? selfReportedPrNumber : null;
  if (reportedPrUrl || reportedPrNumber) {
    let verdict: ReportedPrVerdict = { accept: true, verified: false, pr: { url: reportedPrUrl, number: reportedPrNumber } };
    if (!(account as { sessionUserId?: string | null }).sessionUserId && worker.workspaceId) {
      const reportingTask = worker.taskId
        ? await db.query.tasks.findFirst({
            where: eq(tasks.id, worker.taskId),
            columns: { id: true, title: true, description: true, context: true, dependsOn: true, missionId: true, taskClass: true, reviewerRetryPrNumber: true, ciRetryPrNumber: true, conflictRetryPrNumber: true },
          })
        : null;
      verdict = await verifyReportedWorkerPr({
        worker: { id: worker.id, branch: worker.branch, workspaceId: worker.workspaceId, taskId: worker.taskId },
        task: reportingTask ?? null,
        reported: { url: reportedPrUrl, number: reportedPrNumber },
      });
    }
    if (verdict.accept) {
      if (verdict.verified) {
        updates.prUrl = verdict.pr.url;
        updates.prNumber = verdict.pr.number;
      } else {
        if (reportedPrUrl) updates.prUrl = reportedPrUrl;
        if (reportedPrNumber) updates.prNumber = reportedPrNumber;
      }
    } else {
      fireGateEvent({
        gate: GATE_SLUGS.PR_OWNERSHIP,
        surface: 'PATCH /api/workers/[id]',
        outcome: 'rejected',
        reason: verdict.reasonCode,
        workspaceId: worker.workspaceId,
        taskId: worker.taskId,
        workerId: worker.id,
        callerOrigin: 'worker',
      });
      console.warn(`[workers/${id}] self-reported PR not recorded: ${verdict.reasonCode}`);
    }
  }

  // Status audit trail: record terminal transitions in milestones for debugging
  if (status === 'completed' || status === 'failed') {
    const existingMilestones = (updates.milestones ?? worker.milestones ?? []) as any[];
    // Sensitive: keep {type, ts} only — strip label/from/to prose
    const transition = isSensitive
      ? { type: 'statusTransition', ts: Date.now() }
      : {
          type: 'statusTransition',
          label: `Status: ${worker.status} → ${status}`,
          from: worker.status,
          to: status,
          ts: Date.now(),
          source: 'api',
        };
    updates.milestones = [...existingMilestones, transition];
  }

  // Handle status transitions
  if (status === 'running' && !worker.startedAt) {
    updates.startedAt = new Date();
  }
  // Reactivation: clear completion state when worker resumes from completed/failed/error
  if (status === 'running' && (worker.status === 'completed' || worker.status === 'failed' || worker.status === 'error')) {
    updates.completedAt = null;
    updates.error = null;

    // Reactivate the associated task
    if (worker.taskId) {
      await db
        .update(tasks)
        .set({ status: 'assigned', updatedAt: new Date() })
        .where(eq(tasks.id, worker.taskId));
    }
  }
  // Enforce output requirement based on task.outputRequirement
  // (Must run BEFORE task status update to prevent marking task completed on validation failure)
  // Note: pr_required, artifact_required, and auto-with-commits are all hard
  // blockers (400) — the only silent-pass case left is a task that legitimately
  // produced neither commits nor an artifact (research/recon with a prose summary).
  // When artifact_required is satisfied by an artifact alone (no PR), the task
  // produced no code changes and there is nothing to merge/release. Skip the
  // release gate so a branch-merge workspace config does not flip the task to
  // failed because the worker branch was never pushed to the remote.
  let skipRelease = false;
  // Set by the pr_required gate when `alreadyShippedIn` names a PR GitHub
  // confirms merged; snapshotted onto tasks.result for audit.
  let alreadyShipped: { prNumber: number; prUrl: string } | null = null;
  // Lifted out of the outputRequirement block below (which only runs when
  // outputReq !== 'none') so the planning-contract guard can see a PR that was
  // auto-detected from GitHub even on a task with no output requirement.
  let workerHasPR = !!worker.prUrl;
  const sessionActualModel = resolveSessionActualModel(
    actualModel,
    (resultMeta ?? worker.resultMeta) as Parameters<typeof resolveSessionActualModel>[1],
  );
  // Call only after winning terminal ownership, including a silent refusal.
  const accumulateTerminalSpend = async () => {
    // Accumulate monthly spend + fire budget-threshold alerts (non-fatal).
    // Guarded by the worker's prior status so a duplicate terminal PATCH can't
    // double-count. Prefers the SDK's reported cost; falls back to a token-derived
    // estimate (list prices) when cost is $0 — the OAuth / credit-pool case.
    const wasTerminal = worker.status === 'completed' || worker.status === 'failed';
    if (!wasTerminal) {
      try {
        const reportedCost = typeof costUsd === 'number'
          ? costUsd
          : parseFloat((worker.costUsd as string | null) ?? '0');
        const usageForCost = (resultMeta?.modelUsage ?? (worker.resultMeta as any)?.modelUsage) as
          | Parameters<typeof estimateCostUsd>[0]
          | undefined;
        // Per-model attribution first. It is EMPTY on seat/OAuth auth — the very
        // case this estimate exists for — so fall back to pricing the session
        // totals (which OAuth does populate) against the session's actual model.
        const perModelEstimate = estimateCostUsd(usageForCost);
        const totalsForCost = (resultMeta?.totalUsage ?? (worker.resultMeta as any)?.totalUsage) as
          | Parameters<typeof estimateCostUsdFromTotals>[0]
          | undefined;
        const estimatedCost = perModelEstimate > 0
          ? perModelEstimate
          : estimateCostUsdFromTotals(totalsForCost, sessionActualModel);
        const effectiveCost = reportedCost > 0 ? reportedCost : estimatedCost;

        // Write effectiveCost back to the worker row so per-worker aggregations
        // (e.g. mission spend) see a non-null value for OAuth workers that don't
        // self-report costUsd. Only overwrite when the runner didn't report a
        // positive cost (reportedCost > 0 means line 387 already set the right value).
        if (effectiveCost > 0 && reportedCost <= 0) {
          updates.costUsd = effectiveCost.toString();
          const metaBase = (updates.resultMeta ?? worker.resultMeta ?? {}) as Record<string, unknown>;
          updates.resultMeta = { ...metaBase, costEstimated: true } as unknown as typeof updates.resultMeta;
        }

        // Codex and tenant-credential spend are billed elsewhere, so they do
        // not draw on the pool. The worker row above still carries the cost
        // either way.
        const poolTaskRow = terminalTaskRow[0];
        const countsTowardPool = countsTowardAgentSdkCreditPool({
          backend: poolTaskRow?.backend ?? null,
          authType: account.authType,
          tenantId: ((poolTaskRow?.context as Record<string, unknown> | null)?.tenantContext as { tenantId?: string } | undefined)?.tenantId ?? null,
          // The basis the row holds after this report, by the same rule the
          // SQL write applies.
          costBasis: carriesUsage
            ? combineCostBasis((worker.costBasis as CostBasis | null) ?? null, reportedBasis ?? 'unknown')
            : (worker.costBasis as CostBasis | null) ?? null,
        });

        if (effectiveCost > 0 && countsTowardPool) {
          // Aggregate budget is tracked at the team level so all token-accounts
          // under the same owner share one monthly cap (the Claude Agent SDK
          // credit pool is a single pool per subscription).
          //
          // Optimistic locking: read the team budget, compute the next state, then
          // commit only if the row is unchanged since we read it (CAS on cost+month).
          // neon-http has no interactive transactions, so we retry on contention —
          // concurrent worker completions under the same team must not lose spend
          // or mis-fire threshold alerts by racing on a read-modify-write.
          const envBudget = process.env.BUDGET_MONTHLY_USD ? parseFloat(process.env.BUDGET_MONTHLY_USD) : null;
          let committed = false;

          for (let attempt = 0; attempt < 5 && !committed; attempt++) {
            // Explicit column list: an unfiltered teams query selects every column
            // in schema.ts, so dropping one breaks this loop for the length of a
            // build. These four are the whole budget CAS working set.
            const team = await db.query.teams.findFirst({
              where: eq(teams.id, account.teamId),
              columns: {
                monthlyBudgetUsd: true,
                monthlyCostUsd: true,
                monthlyCostMonth: true,
                budgetAlertsSent: true,
              },
            });
            if (!team) break;

            const budgetUsd = team.monthlyBudgetUsd != null
              ? parseFloat(team.monthlyBudgetUsd.toString())
              : envBudget;
            const prevCost = (team.monthlyCostUsd as string | null) ?? '0';
            const prevMonth = team.monthlyCostMonth ?? null;

            const result = applyBudgetUsage(
              {
                monthlyCostUsd: parseFloat(prevCost),
                monthlyCostMonth: prevMonth,
                alertsSent: (team.budgetAlertsSent ?? []) as number[],
              },
              effectiveCost,
              budgetUsd,
              new Date(),
            );

            // CAS guard: a concurrent writer that won the race will have changed
            // cost or month (cost strictly moves on every charge), failing this
            // WHERE and returning no rows, so we re-read and retry.
            const rows = await db
              .update(teams)
              .set({
                monthlyCostUsd: result.monthlyCostUsd.toFixed(6),
                monthlyCostMonth: result.monthlyCostMonth,
                budgetAlertsSent: result.alertsSent,
              })
              .where(and(
                eq(teams.id, account.teamId),
                eq(teams.monthlyCostUsd, prevCost),
                prevMonth === null ? isNull(teams.monthlyCostMonth) : eq(teams.monthlyCostMonth, prevMonth),
              ))
              .returning({ id: teams.id });

            if (rows.length === 0) continue; // lost the race — re-read and retry
            committed = true;

            for (const threshold of result.crossed) {
              void notifyTeamOf({ teamId: account.teamId }, 'needsAttention', {
                priority: threshold >= 100 ? 1 : 0,
                title: `Buildd budget ${threshold}% used`,
                message: budgetUsd != null
                  ? `$${result.monthlyCostUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} Agent SDK credit used this month (${result.monthlyCostMonth}).`
                  : `$${result.monthlyCostUsd.toFixed(2)} spent this month (${result.monthlyCostMonth}).`,
              });
            }
          }

          if (!committed) {
            console.warn(`[Worker ${id}] budget update lost contention after retries; charge of $${effectiveCost.toFixed(4)} not recorded`);
          }
        }
      } catch (budgetErr) {
        console.error(`[Worker ${id}] budget tracking failed:`, budgetErr);
      }
    }
  };

  const releaseTerminalSeat = async () => {
    if ((LIVE_WORKER_STATUSES as readonly string[]).includes(worker.status) && account.authType === 'oauth') {
      await db.update(accounts)
        .set({ activeSessions: sql`GREATEST(${accounts.activeSessions} - 1, 0)` })
        .where(eq(accounts.id, account.id));
    }
  };

  const isTerminalStatus = status === 'completed' || status === 'failed' || status === 'error';

  // §6d observed-touch SAMPLE (lib/working-set-sync.ts).
  // On terminal status: clear. Otherwise dedup-append the paths this sync
  // reported, bounded at OBSERVED_TOUCHES_CAP. This column is what the
  // dashboard and explain read; it is NOT what coordination is decided on —
  // the authoritative current set is `path_claims`, fed by `workingSet` (or,
  // for an older runner, by every reported touch regardless of the cap).
  const workingSetDelta = parseWorkingSetDelta(rawWorkingSet);
  const reportedTouches = [...new Set([
    ...(Array.isArray(touchedPaths)
      ? touchedPaths.filter((path: unknown): path is string => typeof path === 'string') : []),
    ...(workingSetDelta?.add ?? []),
  ])];
  const sessionObservedTouches = [...new Set([
    ...(Array.isArray(worker.observedTouches) ? worker.observedTouches as string[] : []),
    ...reportedTouches,
  ])];
  // Legacy lease offer (no `workingSet` on the request): what this sync
  // reported that the column did not already hold. Independent of the cap —
  // a path past the sample cap is still leased.
  let newlyObservedPaths: string[] = [];
  if (isTerminalStatus) {
    // Ground truth for the task-area-prediction experiment, captured HERE
    // because the column is cleared on the next line and there is no other
    // durable per-task file list: the `pr` corpus only covers merged, ingested
    // PRs, which would silently narrow the cohort to work that landed.
    // Best-effort and awaited-but-never-thrown — see recordTaskAreaOutcome.
    if (worker.taskId) {
      // The sample plus this sync's paths plus what the task actually holds:
      // the leases are the complete set, the sample may be truncated.
      const observed = Array.isArray(worker.observedTouches) ? (worker.observedTouches as string[]) : [];
      const owned = worker.workspaceId ? await terminalOwnedPaths(worker.workspaceId, worker.taskId) : [];
      const finalPaths = [...new Set([...observed, ...reportedTouches, ...owned])];
      await recordTaskAreaOutcome(worker.taskId, finalPaths);
      // Final touched-file label for orchestration decisions (conflict-aware
      // orchestration §5), from the same observation, before the clear. Writes
      // only for a task a decision looked at; never throws into this PATCH.
      try {
        await recordOrchestrationTouchLabel({
          taskId: worker.taskId,
          workspaceId: worker.workspaceId,
          workerId: worker.id,
          workerStatus: status,
          paths: finalPaths,
          prNumber: worker.prNumber ?? null,
          headSha: worker.lastCommitSha ?? null,
          baseRef: worker.prBaseRef ?? null,
        });
      } catch (err) {
        console.warn(`[Worker ${id}] orchestration touch label failed (non-fatal):`, err);
      }
    }
    updates.observedTouches = null;
  } else if (reportedTouches.length > 0) {
    const existing = Array.isArray(worker.observedTouches) ? (worker.observedTouches as string[]) : [];
    const sample = boundedObservedSample(existing, reportedTouches);
    updates.observedTouches = sample.sample;
    if (sample.crossedCap) {
      // Once per worker: the diagnostic sample is truncated from here on.
      // Coverage is unaffected — every reported path is still leased below.
      console.log(`[Worker ${id}] observedTouches sample at its cap (${sample.dropped} more not shown); leases unaffected`);
      fireObservationTruncated(worker, sample);
    }
    const existingSet = new Set(existing);
    newlyObservedPaths = reportedTouches.filter(p => !existingSet.has(p));
  }

  // Fetch mission ownership for every terminal transition. Completion also uses
  // outputRequirement; failed/error transitions still need missionId so their
  // final recorded cost can enforce the mission budget.
  const terminalTaskRow = isTerminalStatus && worker.taskId
    ? await db
        // `taskClass` is here for the Option A′ auto-detect guard below:
        // `isMissionPrTask` needs it to tell the mission PR's own owner task
        // (head = integration branch, base = trunk, legal) apart from a task
        // PR wrongly pointed at trunk. Title alone would exempt nothing.
        // `backend` decides whether this session's spend draws on the Agent
        // SDK credit pool (countsTowardAgentSdkCreditPool).
        .select({ kind: tasks.kind, pathManifest: tasks.pathManifest, status: tasks.status, outputRequirement: tasks.outputRequirement, missionId: tasks.missionId, scheduleId: tasks.scheduleId, mode: tasks.mode, category: tasks.category, context: tasks.context, creationSource: tasks.creationSource, outputSchema: tasks.outputSchema, title: tasks.title, description: tasks.description, taskClass: tasks.taskClass, backend: tasks.backend, roleSlug: tasks.roleSlug, reviewerRetryPrNumber: tasks.reviewerRetryPrNumber, ciRetryPrNumber: tasks.ciRetryPrNumber, conflictRetryPrNumber: tasks.conflictRetryPrNumber, dependsOn: tasks.dependsOn, deliveryId: tasks.deliveryId, deliveryRole: tasks.deliveryRole })
        .from(tasks)
        .where(eq(tasks.id, worker.taskId))
        .limit(1)
    : [];
  const taskMissionId = terminalTaskRow[0]?.missionId ?? null;

  /**
   * Does a deliverable that belongs to THIS unit of work exist?
   *
   * The predicate used to be a bare `eq(artifacts.workerId, id)`, which cannot
   * match a mission artifact: api/missions/[id]/artifacts inserts `workerId:
   * null` by construction, and MCP `create_artifact` with a `missionId` routes
   * down that path. An agent that correctly produced its artifact was told it
   * had not, and 400'd on completion.
   *
   * `artifacts` has no taskId column, so mission-level rows are attributed by
   * (missionId, no owning worker, touched since this worker started). The time bound is what stops
   * a sibling task's pre-existing mission artifact from satisfying the gate.
   */
  // Captured outside the closure: narrowing of `worker` does not survive into a
  // function body.
  const workerStartedAt = worker.startedAt ?? null;
  async function hasDeliverableArtifact(strict = false): Promise<boolean> {
    // startedAt is written on the first `running` PATCH, so a completing worker
    // has one; epoch keeps a null from excluding everything.
    const workStart = workerStartedAt ? new Date(workerStartedAt) : new Date(0);
    const where = taskMissionId
      ? or(
          eq(artifacts.workerId, id),
          // workerId NULL only: a mission-level row (api/missions/[id]/artifacts).
          // A row another worker owns is ITS deliverable, and every mission
          // upload now carries missionId (upload-url, create_artifact), so a
          // sibling's screenshot must not satisfy this task's gate.
          and(eq(artifacts.missionId, taskMissionId), isNull(artifacts.workerId), gte(artifacts.updatedAt, workStart)),
        )
      : eq(artifacts.workerId, id);
    const rows = await db.query.artifacts.findMany({
      where: strict ? and(where,
        sql`COALESCE(${artifacts.metadata}->>'salvaged', 'false') <> 'true'`,
        sql`COALESCE(${artifacts.key}, '') NOT LIKE 'cloud-run-report:%'`,
        or(not(inArray(artifacts.type, ['screenshot', 'diff', 'file', 'data', 'link', 'recording', 'calendar_event'])), isNotNull(artifacts.key)),
      ) : where,
      limit: 1,
    });
    return rows.length > 0;
  }

  // The task was cancelled while this session was still running. The cancel's
  // abort push is best-effort, so the session can outlive it: the agent's own
  // complete_task is then refused by the MCP write fence (TASK CANCELLED), the
  // SDK session still ends cleanly, and the runner's fallback completion PATCH
  // lands here. The output gate below would demand a PR/artifact for a task
  // nobody wants any more and 400 it — which the runner recorded as a terminal
  // error and failure analytics counted as a failure.
  //
  // So a completion on a cancelled task that delivered nothing is recorded as
  // what it is — a cancellation — instead of being gated. One that DID deliver
  // (a PR or artifact made before the cancel landed) keeps completing exactly
  // as before; that is the same carve-out the MCP write fence makes. Failed /
  // error reports on a cancelled task take the same exit cause via
  // classifyReportedFailure below (the runner's abort path reports `failed`).
  //
  // "Delivered" includes an open PR on the worker's branch that is not on the
  // worker row yet (opened via `gh pr create`, not create_pr): the gate's
  // GitHub auto-detect below is the door that adopts it, so a cancellation
  // rewrite here must not pre-empt it. Only probed when nothing else counts.
  const workerBranch = worker.branch;
  const workerWorkspaceId = worker.workspaceId;
  async function hasOpenPrOnWorkerBranch(): Promise<boolean> {
    if (!workerBranch) return false;
    try {
      const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workerWorkspaceId) });
      if (!ws?.githubRepoId) return false;
      const repo = await db.query.githubRepos.findFirst({
        where: eq(githubRepos.id, ws.githubRepoId),
        with: { installation: true },
      }) as { fullName: string; installation: { installationId: number } | null } | undefined;
      if (!repo?.installation) return false;
      const owner = repo.fullName.split('/')[0];
      const prs = await githubApi(
        repo.installation.installationId,
        `/repos/${repo.fullName}/pulls?head=${encodeURIComponent(owner + ':' + workerBranch)}&state=open`,
      );
      return Array.isArray(prs) && prs.length > 0;
    } catch {
      return false;
    }
  }
  const taskCancelledUnderSession = isTerminalStatus && terminalTaskRow[0]?.status === 'cancelled';
  if (
    status === 'completed' && taskCancelledUnderSession && !workerHasPR
    && !(await hasDeliverableArtifact()) && !(await hasOpenPrOnWorkerBranch())
  ) {
    status = 'failed';
    error = TASK_CANCELLED_UNDER_SESSION_ERROR;
    updates.status = 'failed';
    updates.error = error;
    // Nothing of this worker's shipped; there is no branch to release.
    skipRelease = true;
    // The status-transition milestone above was written for the reported
    // status; keep the audit trail truthful about what was recorded.
    const trail = updates.milestones as Array<Record<string, unknown>> | undefined;
    const last = trail?.[trail.length - 1];
    if (last?.type === 'statusTransition' && last.to === 'completed') {
      last.to = 'failed';
      if (typeof last.label === 'string') last.label = `Status: ${worker.status} → failed (task cancelled)`;
    }
  }

  if (status === 'completed') {
    // Fetch task to check outputRequirement. Explicit select (not the
    // relational query builder): `tasks` has a `workers` relation and the RQB
    // can intermittently emit "missing FROM-clause entry for table workers".
    const outputReq = terminalTaskRow[0]?.outputRequirement ?? 'auto';

    // A reviewer task (createReviewerTask, apps/web/src/lib/reviewer.ts) never
    // opens a PR or produces an artifact of its own — its deliverable is
    // structuredOutput.verdict, consumed by handleReviewerOutcomeIfNeeded. The
    // `auto` gate's PR/artifact/fallback-summary check below was written for
    // ordinary coding tasks and has no concept of a verdict, so it 400'd every
    // reviewer session that ended without an agent-authored `complete_task`
    // (summarySource: 'fallback') even though that is the review contract's
    // OWN failure mode, already handled downstream by the review-contract
    // guard (requeue once, then fail with a recorded reason — see
    // reviewContractViolation below). Gate reviewer tasks on their own
    // contract instead of skipping the check outright.
    const isReviewerTask = terminalTaskRow[0]?.category === 'review'
      && Boolean((terminalTaskRow[0]?.context as Record<string, unknown> | undefined)?.reviewerFor);

    // A reviewer calling the MCP complete_task tool itself (any interactive
    // claim_task worker, or a runner-hosted agent mid-session — the tool marks
    // that PATCH viaCompleteTask) can still read the response, so refuse a
    // malformed verdict here with the allowed values instead of accepting the
    // call and failing the worker afterwards: a runner reviewer that left out
    // `summary` once lost a review it corrected on its very next call. A
    // runner-reported end-of-session completion has no agent turn left to read
    // a refusal, so it keeps the requeue-once contract guard further down.
    if (isReviewerTask && (worker.runner === 'mcp' || body.viaCompleteTask === true)) {
      const submitted = body.structuredOutput as { verdict?: unknown } | null | undefined;
      if (submitted && typeof submitted === 'object' && submitted.verdict) {
        const parsed = parseReviewerOutput(submitted);
        if (!parsed.ok) {
          return NextResponse.json({
            error: `Review verdict not recorded: ${parsed.reason}. Call complete_task again with structuredOutput { verdict: ${REVIEWER_VERDICTS.map((v) => `"${v}"`).join(' | ')}, confidence: <number 0-1>, summary: <string> }.`,
            hint: 'structuredOutput.verdict',
          }, { status: 400 });
        }
      }
    }

    // §9 completion gate (docs/specs/workflow-state-kernel.md): a kernel fix
    // attempt may not report `completed` while the PR's GitHub head is still
    // the head its review round was made on. A local commit is never delivery;
    // without this, a fix that never pushed read as done (#3754).
    if (isRepairRole(terminalTaskRow[0]?.deliveryRole) && worker.taskId) {
      const refusal = await fixCompletionGate({
        task: {
          id: worker.taskId, workspaceId: worker.workspaceId,
          deliveryId: terminalTaskRow[0].deliveryId ?? null, deliveryRole: terminalTaskRow[0].deliveryRole ?? null,
          context: terminalTaskRow[0].context,
        },
        localHeadSha: lastCommitSha ?? worker.lastCommitSha ?? null,
      }).catch((err) => {
        console.error(`[workflow] completion gate check failed for worker ${worker.id} (allowing; AttemptEnded decides):`, err);
        return null;
      });
      if (refusal) {
        await applyMetricsOnlyPatch(id, worker, body, reportedBasis).catch(() => null);
        const frictionSignature = fireGateEvent({
          gate: GATE_SLUGS.OUTPUT_REQUIREMENT,
          surface: 'PATCH /api/workers/[id]',
          outcome: 'rejected',
          reason: 'completion refused: delivery_not_advanced',
          workspaceId: worker.workspaceId,
          missionId: taskMissionId,
          taskId: worker.taskId,
          workerId: worker.id,
          callerOrigin: 'worker',
          detail: { code: refusal.code, boundHeadSha: refusal.boundHeadSha, liveHeadSha: refusal.liveHeadSha, localHeadSha: refusal.localHeadSha },
        });
        return NextResponse.json({
          error: refusal.error,
          hint: refusal.hint,
          code: refusal.code,
          gate: GATE_SLUGS.OUTPUT_REQUIREMENT,
          frictionSignature,
          boundHeadSha: refusal.boundHeadSha,
          liveHeadSha: refusal.liveHeadSha,
          localHeadSha: refusal.localHeadSha,
        }, { status: 400 });
      }
    }

    // A bookkeeping task (heartbeats, criteria evaluators, plan-rejection
    // replans — see packages/core/db/schema.ts taskClass) reports its outcome
    // via complete_task's summary/structuredOutput. It never ships a PR or
    // artifact of its own, so the commits/dirty-worktree/PR machinery below
    // was built for a different task shape entirely. Most bookkeeping
    // creation sites already say so explicitly (outputRequirement: 'none'),
    // but several default to unset/'auto' and inherited builder semantics by
    // accident. An explicit pr_required/artifact_required is still honored —
    // e.g. the completed-work aggregator in task-dependencies.ts — this only
    // widens what 'auto' means for this task shape.
    const isBookkeepingTask = terminalTaskRow[0]?.taskClass === 'bookkeeping';

    // 'none' means "no deliverable required" — correct for a bookkeeping task
    // (every creation site that sets outputRequirement='none' explicitly is
    // taskClass='bookkeeping': heartbeats, criteria evaluators, the mission-PR
    // owner task) and also correct for a genuine investigation/diagnosis task
    // that concludes with nothing to ship. It is NOT a license for a
    // non-bookkeeping task to strand real code changes: a 'work' task has no
    // legitimate reason to declare 'none' while actually committing/dirtying
    // the worktree, since nothing in this codebase creates that combination on
    // purpose. Only the bookkeeping case skips this block outright; a
    // non-bookkeeping 'none' task still runs it so the commits-with-no-PR
    // check further below (which requires real commit/dirty-worktree evidence,
    // not just a fallback summary — see its own comment) can catch it.
    const bookkeepingSkipsGate = outputReq === 'none' && isBookkeepingTask;
    if (!bookkeepingSkipsGate) {
      const effectiveCommits = commitCount ?? worker.commitCount ?? 0;
      // Same precedence as effectiveCommits: this request's own report wins,
      // falling back to the worker row's last-synced value (kept fresh by the
      // runner's periodic sync — see worker-sync.ts computeDirtyWorktree).
      const effectiveDirtyWorktree = typeof dirtyWorktree === 'boolean' ? dirtyWorktree : (worker.dirtyWorktree ?? false);
      let hasPR = workerHasPR;

      // Resolve the workspace's GitHub repo/installation once — used both to
      // auto-detect an open PR on the worker's own branch and, for
      // pr_required, to check whether a PR the task text references by
      // number is already merged (see fallback below).
      let repoWithInstallation: { fullName: string; installation: { installationId: number } } | null = null;
      if (!hasPR && (worker.branch || outputReq === 'pr_required')) {
        const workspace = await db.query.workspaces.findFirst({
          where: eq(workspaces.id, worker.workspaceId),
        });
        if (workspace?.githubRepoId) {
          const repo = await db.query.githubRepos.findFirst({
            where: eq(githubRepos.id, workspace.githubRepoId),
            with: { installation: true },
          });
          if (repo?.installation) {
            repoWithInstallation = repo as unknown as { fullName: string; installation: { installationId: number } };
          }
        }
      }

      // Auto-detect: if no PR on worker but branch exists, check GitHub for open PRs
      //
      // This is the fourth door a PR can enter buildd through, and the one the
      // Option A′ derivation could not see: it adopts whatever open PR exists
      // on the worker's branch, however it got there. `gh pr create --base
      // <trunk>` followed by complete_task lands here — create_pr is never
      // called, so nothing derives or checks the base, and a mission task PR
      // pointed at trunk is recorded as this task's deliverable with its
      // review gate already gone. Refuse the adoption instead, with the same
      // retarget instruction the front door gives.
      let autoDetectRefusal: { error: string; hint: string } | null = null;
      if (!hasPR && worker.branch && repoWithInstallation) {
        try {
          const owner = repoWithInstallation.fullName.split('/')[0];
          const prs = await githubApi(
            repoWithInstallation.installation.installationId,
            `/repos/${repoWithInstallation.fullName}/pulls?head=${encodeURIComponent(owner + ':' + worker.branch)}&state=open`,
          );
          if (Array.isArray(prs) && prs.length > 0) {
            const guard = await loadMissionBaseGuard({
              task: terminalTaskRow[0]
                ? {
                    title: terminalTaskRow[0].title,
                    taskClass: terminalTaskRow[0].taskClass,
                    missionId: terminalTaskRow[0].missionId,
                    context: terminalTaskRow[0].context,
                    dependsOn: terminalTaskRow[0].dependsOn,
                  }
                : null,
              head: worker.branch,
            });
            // Same escape hatch as `create_pr` (POST /api/github/pr): a
            // multi-repo mission's integration branch may be real in the
            // mission's home repo and absent from THIS task's own repo, in
            // which case refusing the adoption for disagreeing with it would
            // refuse the only base that can actually exist here.
            let autoDetectIntegrationBaseMissing = false;
            if (guard.enforced && terminalTaskRow[0]?.missionId && guard.integrationBase) {
              const ready = await ensureIntegrationBaseForTaskPr({
                missionId: terminalTaskRow[0].missionId,
                integrationBase: guard.integrationBase,
                taskTitle: terminalTaskRow[0].title,
                workspaceId: worker.workspaceId,
                taskId: worker.taskId,
                workerId: worker.id,
              });
              autoDetectIntegrationBaseMissing = !ready.usable;
            }
            const detectedBaseRef = typeof prs[0].base?.ref === 'string' ? prs[0].base.ref : null;
            autoDetectRefusal = autoDetectIntegrationBaseMissing
              ? null
              : guard.refusal(detectedBaseRef, {
                  prNumber: prs[0].number,
                  action: 'adopt',
                });
            if (!autoDetectRefusal) {
              // Found PR — update worker and let validation pass
              await db.update(workers).set({
                prUrl: prs[0].html_url,
                prNumber: prs[0].number,
                // The base ref came straight from GitHub in this request and the
                // column is empty on this path by construction (we only get here
                // when the worker had no PR at all), so recording it is safe and
                // stops the merge-policy chain from having to guess later.
                ...(detectedBaseRef ? { prBaseRef: detectedBaseRef } : {}),
                updatedAt: new Date(),
              }).where(eq(workers.id, id));
              hasPR = true;
              workerHasPR = true;
            }
          }
        } catch { /* non-fatal — fall through to normal validation */ }
      }
      if (autoDetectRefusal) {
        const frictionSignature = fireGateEvent({
          gate: GATE_SLUGS.MISSION_BASE_ADOPTION,
          surface: 'PATCH /api/workers/[id]',
          outcome: 'rejected',
          reason: autoDetectRefusal.error,
          workspaceId: worker.workspaceId,
          missionId: taskMissionId,
          taskId: worker.taskId,
          workerId: worker.id,
          callerOrigin: 'worker',
        });
        return NextResponse.json({ ...autoDetectRefusal, gate: GATE_SLUGS.MISSION_BASE_ADOPTION, frictionSignature }, { status: 400 });
      }

      // pr_required fallback: a task scoped as "rebase/fix PR #N" doesn't own a
      // branch of its own — the worker pushes straight to PR #N's existing
      // branch, which the auto-detect above never sees because it only looks
      // up PRs whose head is `worker.branch`. Accept the referenced PR two
      // ways instead of demanding a fresh, empty PR:
      //   1. it's already merged — DONE = MERGED regardless of who merged it
      //      (handles the worker losing a race to a concurrent merge).
      //   2. it's still open, but its head SHA matches the last commit this
      //      worker reported — proof the worker's own push IS the PR's
      //      current state, not just that the task text happens to mention a
      //      number. A merge/review verdict can land after this worker's
      //      session ends, so completion can't wait for `merged` here.
      if (outputReq === 'pr_required' && !hasPR && repoWithInstallation) {
        const referencedText = `${terminalTaskRow[0]?.title ?? ''} ${terminalTaskRow[0]?.description ?? ''}`;
        const referencedPrNumbers = [...new Set(
          [...referencedText.matchAll(/#(\d+)/g)].map((m) => Number(m[1])),
        )].slice(0, 5);

        for (const prNumber of referencedPrNumbers) {
          try {
            const pr = await githubApi(
              repoWithInstallation.installation.installationId,
              `/repos/${repoWithInstallation.fullName}/pulls/${prNumber}`,
            );
            const effectiveLastCommitSha = lastCommitSha ?? worker.lastCommitSha;
            const headShaMatch = Boolean(
              effectiveLastCommitSha && pr?.head?.sha && pr.head.sha === effectiveLastCommitSha,
            );
            if (pr?.merged || headShaMatch) {
              // Named by the task, so it is owned unless its head is a
              // protected branch; it still needs the linked repo and the
              // mission base, like every other door.
              if (!(account as { sessionUserId?: string | null }).sessionUserId && worker.workspaceId) {
                const row = terminalTaskRow[0];
                const verdict = await verifyReportedWorkerPr({
                  worker: { id: worker.id, branch: worker.branch, workspaceId: worker.workspaceId, taskId: worker.taskId },
                  task: row && worker.taskId ? { ...row, id: worker.taskId } : null,
                  reported: { number: prNumber },
                  view: pr,
                });
                if (!verdict.accept) {
                  fireGateEvent({
                    gate: GATE_SLUGS.PR_OWNERSHIP,
                    surface: 'PATCH /api/workers/[id]',
                    outcome: 'rejected',
                    reason: verdict.reasonCode,
                    workspaceId: worker.workspaceId,
                    missionId: row?.missionId ?? null,
                    taskId: worker.taskId,
                    workerId: worker.id,
                    callerOrigin: 'worker',
                  });
                  continue;
                }
              }
              await db.update(workers).set({
                prUrl: pr.html_url,
                prNumber: pr.number,
                updatedAt: new Date(),
              }).where(eq(workers.id, id));
              hasPR = true;
              workerHasPR = true;
              break;
            }
          } catch { /* non-fatal — try the next referenced number */ }
        }
      }

      // pr_required, already shipped: the work the task asks for landed in a
      // merged PR the task neither owns nor names (another task got there
      // first). The caller names it with `alreadyShippedIn`; it counts only if
      // GitHub says it is merged in the linked repo. It is recorded on the
      // task result, not adopted onto this worker: the PR belongs to another
      // task, and this worker taking it over would confuse that PR's own
      // merge, supersession and shutdown handling.
      let alreadyShippedRefusal: string | null = null;
      const shippedPrNumber = alreadyShippedIn == null
        ? null
        : Number(String(alreadyShippedIn).trim().replace(/^#/, ''));
      if (outputReq === 'pr_required' && !hasPR && shippedPrNumber !== null) {
        if (!Number.isInteger(shippedPrNumber) || shippedPrNumber <= 0) {
          alreadyShippedRefusal = `alreadyShippedIn must be a PR number, got ${JSON.stringify(alreadyShippedIn)}.`;
        } else if (!repoWithInstallation) {
          alreadyShippedRefusal = `PR #${shippedPrNumber} cannot be verified: this workspace has no linked GitHub repo with the app installed.`;
        } else {
          try {
            const pr = await githubApi(
              repoWithInstallation.installation.installationId,
              `/repos/${repoWithInstallation.fullName}/pulls/${shippedPrNumber}`,
            );
            if (pr?.merged) {
              alreadyShipped = {
                prNumber: shippedPrNumber,
                prUrl: typeof pr.html_url === 'string' ? pr.html_url : `https://github.com/${repoWithInstallation.fullName}/pull/${shippedPrNumber}`,
              };
            } else {
              alreadyShippedRefusal = `PR #${shippedPrNumber} in ${repoWithInstallation.fullName} is not merged, so it does not show the work shipped.`;
            }
          } catch {
            alreadyShippedRefusal = `PR #${shippedPrNumber} could not be read from ${repoWithInstallation.fullName}.`;
          }
        }
      }

      // Standing ask from the outputRequirement-rejection bug: a gate-rejected
      // completion used to discard the agent's summary/structuredOutput with
      // zero persistence — a 60-turn run's only record was a 400 in the
      // runner's logs. Write what the agent actually sent onto this worker
      // row before refusing it; each rejection is its own worker row, so
      // there is nothing to reconcile against a later, successful attempt.
      const persistRejectedCompletionPayload = async (reason: string): Promise<string> => {
        // Salvage measurement before refusing the status write. `body` still
        // carries the full completion payload (costUsd, tokens, turns, git
        // stats, resultMeta) at this point — the gate returns 400 below without
        // ever reaching the `updates` write further down this handler, so
        // without this call every one of those numbers is lost with the
        // refusal. `applyMetricsOnlyPatch` writes measurement only (see its own
        // doc) — it cannot resurrect this worker or rewrite its outcome, so
        // running it ahead of a hard refusal is safe.
        await applyMetricsOnlyPatch(id, worker, body, reportedBasis).catch(() => null);

        // The gate row and the preserved payload are written from the same
        // place on purpose: every arm of this gate refuses through here, so a
        // future arm cannot be added that persists the payload and forgets the
        // ledger (or the reverse).
        const frictionSignature = fireGateEvent({
          gate: reason === 'silent_completion' ? GATE_SLUGS.SILENT_COMPLETION : GATE_SLUGS.OUTPUT_REQUIREMENT,
          surface: 'PATCH /api/workers/[id]',
          outcome: 'rejected',
          reason: `completion refused: outputRequirement ${reason} not satisfied`,
          workspaceId: worker.workspaceId,
          missionId: taskMissionId,
          taskId: worker.taskId,
          workerId: worker.id,
          callerOrigin: 'worker',
          detail: {
            outputRequirement: reason,
            category: terminalTaskRow[0]?.category ?? null,
            summarySource: typeof body.summarySource === 'string' ? body.summarySource : null,
          },
        });
        const rejectedSummary = isSensitive ? null : (typeof body.summary === 'string' ? body.summary.slice(0, 5000) : null);
        const rejectedSummarySource = typeof body.summarySource === 'string' ? body.summarySource : null;

        // 'fallback' means this PATCH came from the runner's own end-of-session
        // completion (apps/runner/src/workers.ts, the "Actually completed"
        // branch) — the SDK query loop already exited, so there is no agent
        // turn left to read this refusal's hint and retry (unlike an
        // agent-authored 'agent' call, which gets an actionable errorResult
        // back from mcp-tools.ts and can still call create_artifact itself).
        // That makes this refusal terminal by construction — salvage the
        // summary as an artifact now, or it is gone with the failed worker.
        // Deliberately NOT a satisfier: the task still fails below, and the
        // artifact is titled/metadata-tagged 'salvaged' so it never reads as
        // a produced deliverable.
        let salvagedArtifactId: string | null = null;
        if (rejectedSummarySource === 'fallback' && rejectedSummary && worker.workspaceId) {
          const [salvaged] = await db.insert(artifacts).values({
            workerId: worker.id,
            workspaceId: worker.workspaceId,
            missionId: taskMissionId ?? null,
            type: 'summary',
            title: `Salvaged completion (rejected: ${reason})`,
            content: rejectedSummary,
            metadata: { salvaged: true, rejectedReason: reason },
          }).returning({ id: artifacts.id });
          salvagedArtifactId = salvaged?.id ?? null;
        }

        await db.update(workers).set({
          rejectedCompletionPayload: {
            reason,
            summary: rejectedSummary,
            structuredOutput: isSensitive ? null : (body.structuredOutput ?? null),
            summarySource: rejectedSummarySource,
            rejectedAt: new Date().toISOString(),
            ...(salvagedArtifactId ? { salvagedArtifactId } : {}),
          },
          updatedAt: new Date(),
        }).where(eq(workers.id, id));

        // Every terminal signal gets a record, including this one — a gate
        // refusal is a session end (the runner's query loop already exited by
        // the time this PATCH lands), just not a completed one. `shipped` is
        // hardcoded false: the gate refused precisely because nothing shipped.
        fireTerminalRecord({
          workerId: worker.id,
          taskId: worker.taskId,
          workspaceId: worker.workspaceId,
          outcome: 'refused',
          exitCause: `outputRequirement ${reason} not satisfied`,
          turns: typeof turns === 'number' ? turns : worker.turns,
          inputTokens: typeof inputTokens === 'number' ? inputTokens : worker.inputTokens,
          outputTokens: typeof outputTokens === 'number' ? outputTokens : worker.outputTokens,
          costUsd: typeof costUsd === 'number' ? costUsd : Number(worker.costUsd ?? 0),
          durationMs: worker.startedAt ? Date.now() - new Date(worker.startedAt).getTime() : null,
          shipped: false,
          summaryProvenance: rejectedSummarySource === 'agent' || rejectedSummarySource === 'fallback' ? rejectedSummarySource : null,
          detail: { outputRequirement: reason, salvagedArtifactId },
        });

        return frictionSignature;
      };

      if (isSilentCompletion({
        status, outputRequirement: outputReq, kind: terminalTaskRow[0]?.kind,
        pathManifest: terminalTaskRow[0]?.pathManifest, taskClass: terminalTaskRow[0]?.taskClass,
        isReviewer: isReviewerTask, commitCount: effectiveCommits,
        filesChanged: Math.max(filesChanged ?? 0, worker.filesChanged ?? 0),
        dirtyWorktree: effectiveDirtyWorktree,
        observedTouches: sessionObservedTouches,
        hasPR: hasPR || !!alreadyShipped, mergedAt: worker.mergedAt, discardEdits,
        summary: body.summary, summarySource: body.summarySource,
      }) && !(await hasDeliverableArtifact(true))) {
        const frictionSignature = await persistRejectedCompletionPayload('silent_completion');
        const message = 'Silent completion refused: no editing evidence or deliverable, and the summary is unauthored narration or a fragment.';
        // Fence on the active worker: duplicate completion requests cannot spend
        // the retry budget twice or overwrite another attempt's outcome.
        const failed = await db.update(workers).set({
          status: 'failed', error: message, exitCause: 'code_failure',
          completedAt: new Date(), updatedAt: new Date(),
        }).where(and(eq(workers.id, id), not(inArray(workers.status, TERMINAL_WORKER_STATUSES)))).returning({ id: workers.id });
        if (!failed.length) return workerConflictResponse(id);
        await accumulateTerminalSpend();
        // Persist metrics before the mission's spend aggregation reads them.
        await db.update(workers).set({ ...updates, status: 'failed', error: message,
          exitCause: 'code_failure', completedAt: new Date() }).where(eq(workers.id, id));
        await releaseTerminalSeat();
        if (taskMissionId) {
          try { await checkAndExhaustMissionBudget(taskMissionId); }
          catch (err) { console.error(`[Worker ${id}] Mission budget check failed:`, err); }
        }
        if (worker.taskId) {
          const previousContext = (terminalTaskRow[0]?.context ?? {}) as Record<string, unknown>;
          const next = silentCompletionRetryContext(previousContext);
          const settled = await db.update(tasks).set({
            status: next.retry ? 'pending' : 'failed', context: next.context,
            claimedBy: null, claimedAt: null, startAt: null,
            result: { summarySource: 'fallback' },
            updatedAt: new Date(),
          }).where(and(
            eq(tasks.id, worker.taskId),
            eq(tasks.status, terminalTaskRow[0]!.status),
            sql`COALESCE(${tasks.context}->>'silentCompletionRetryCount', '0') = ${String(previousContext.silentCompletionRetryCount ?? 0)}`,
          )).returning({ id: tasks.id });
          if (settled.length && !next.retry) {
            await db.insert(missionNotes).values({
              missionId: taskMissionId, taskId: worker.taskId,
              authorType: 'system', type: 'warning', status: 'open',
              title: 'Silent completion retry exhausted', body: message,
            });
          }
          await releaseAndNotify(worker.taskId, 'abandoned');
          if (settled.length) {
            await triggerEvent(channels.workspace(worker.workspaceId), events.TASK_UPDATED, { taskId: worker.taskId, status: next.retry ? 'pending' : 'failed' });
            if (!next.retry) await resolveCompletedTask(worker.taskId, worker.workspaceId);
          }
          await triggerEvent(channels.worker(id), events.WORKER_FAILED, { workerId: id, taskId: worker.taskId, status: 'failed', error: message });
          await triggerEvent(channels.workspace(worker.workspaceId), events.WORKER_FAILED, { workerId: id, taskId: worker.taskId, status: 'failed', error: message });
        }
        return NextResponse.json({ error: message, hint: 'silent_completion', gate: GATE_SLUGS.SILENT_COMPLETION, frictionSignature }, { status: 400 });
      }

      // Evidence slot (lib/completion-policy.ts). A task the evidence policy
      // owns (a visual-auditor's [surface audit]) is judged on its own
      // evidence, which REPLACES the output-requirement gates below: a summary,
      // a PR or a sibling's mission artifact must not pass an audit that never
      // looked. Checked ahead of every outputRequirement arm so no `hasPR`
      // shortcut can satisfy it.
      const evidenceVerdict = worker.taskId
        ? await COMPLETION_POLICIES.evidence({
          workerId: id,
          taskId: worker.taskId,
          missionId: taskMissionId,
          workspaceId: worker.workspaceId,
          roleSlug: terminalTaskRow[0]?.roleSlug ?? null,
          workerStartedAt,
        })
        : null;
      const evidenceIsDeliverable = evidenceVerdict !== null;
      if (evidenceVerdict?.kind === 'fail') {
        const frictionSignature = await persistRejectedCompletionPayload(evidenceVerdict.hint);
        return NextResponse.json({
          error: evidenceVerdict.reason,
          hint: evidenceVerdict.hint,
          gate: GATE_SLUGS.OUTPUT_REQUIREMENT,
          frictionSignature,
        }, { status: 400 });
      }
      // The evidence is the deliverable; there is nothing to merge.
      if (evidenceVerdict?.kind === 'pass') skipRelease = true;

      // pr_required: always require a PR (regardless of commits)
      if (outputReq === 'pr_required' && !hasPR && !evidenceIsDeliverable) {
        // A merged PR elsewhere does not ship this worker's own edits, so they
        // need the same explicit discard the `auto` arm asks for.
        const discardReason = typeof discardEdits === 'string' ? discardEdits.trim() : '';
        const strandsOwnEdits = (effectiveCommits > 0 || effectiveDirtyWorktree) && !discardReason;
        if (!alreadyShipped || strandsOwnEdits) {
          const frictionSignature = await persistRejectedCompletionPayload('pr_required');
          const error = alreadyShipped
            ? `PR #${alreadyShipped.prNumber} is merged, but this worker has ${effectiveCommits > 0 ? `${effectiveCommits} commit(s)` : 'uncommitted changes'} of its own that would be left unshipped. Open a PR for them with create_pr, or call complete_task again with \`discardEdits\` explaining why they are not needed.`
            : alreadyShippedRefusal
              ? `This task requires a pull request before completing. ${alreadyShippedRefusal}`
              : 'This task requires a pull request before completing. Use create_pr to open one. If the work already landed in a merged PR this task does not own, call complete_task with `alreadyShippedIn` set to that PR number.';
          return NextResponse.json({
            error,
            hint: 'create_pr',
            // Machine-readable identity of the refusal, so the runner reports
            // this as the output-gate decision it is instead of unwinding into
            // its crash handler. Same slug the gate_events row above carries —
            // one vocabulary, not two.
            gate: GATE_SLUGS.OUTPUT_REQUIREMENT,
            frictionSignature,
          }, { status: 400 });
        }
        fireGateEvent({
          gate: GATE_SLUGS.OUTPUT_REQUIREMENT,
          surface: 'PATCH /api/workers/[id]',
          outcome: 'accepted',
          reason: 'completion accepted under pr_required: work already shipped in a merged PR',
          workspaceId: worker.workspaceId,
          missionId: taskMissionId,
          taskId: worker.taskId,
          workerId: worker.id,
          callerOrigin: 'worker',
          detail: {
            outputRequirement: 'pr_required',
            alreadyShippedIn: alreadyShipped.prNumber,
            commits: effectiveCommits,
            dirtyWorktree: effectiveDirtyWorktree,
            ...(discardReason ? { discardEdits: discardReason.slice(0, 500) } : {}),
          },
        });
        // Nothing of this worker's own branch is meant to ship.
        skipRelease = true;
      }

      // artifact_required: require PR or artifact (regardless of commits)
      if (outputReq === 'artifact_required' && !hasPR && !evidenceIsDeliverable) {
        if (!(await hasDeliverableArtifact())) {
          const frictionSignature = await persistRejectedCompletionPayload('artifact_required');
          return NextResponse.json({
            error: 'This task requires a deliverable before completing. Use create_pr or create_artifact.',
            hint: 'create_pr or create_artifact',
            // Machine-readable identity of the refusal, so the runner reports
            // this as the output-gate decision it is instead of unwinding into
            // its crash handler. Same slug the gate_events row above carries —
            // one vocabulary, not two.
            gate: GATE_SLUGS.OUTPUT_REQUIREMENT,
            frictionSignature,
          }, { status: 400 });
        }
        // Artifact is the satisfier (no PR). Nothing was committed/pushed to the
        // remote, so a branch-merge release would fail on a missing branch.
        skipRelease = true;
      }

      // auto (default): commits — or, same failure shape, uncommitted edits
      // sitting in the worktree — with neither a PR nor an artifact must not
      // complete silently. That combination — work done, nothing to review or
      // merge, completion reported as done — leaves the change stranded (on
      // the branch, or never even committed) while the summary asserts it
      // landed. The GitHub auto-detect above already covers a branch whose PR
      // was opened by a different worker row (retries/CI-fix continuations
      // push to the same branch as an earlier attempt), so this only fires
      // when no PR exists anywhere for the branch.
      //
      // A fallback-provenance summary (body.summarySource === 'fallback', see
      // #2270) gates independently of commits/dirtyWorktree. It means the SDK
      // session ended without the agent ever calling complete_task, so the
      // "summary" is the runner's own last-assistant-message capture, not a
      // decision the agent made — a stalled session, not a conclusion. A
      // genuine "nothing to ship" outcome is something the agent states
      // deliberately (summarySource='agent'); commitCount/dirtyWorktree alone
      // are also exactly the signals a worktree that never diverged from its
      // base can misreport as "nothing happened" (see collectGitStats in
      // apps/runner/src/git-operations.ts), so they must not be the only gate
      // for this outcome.
      //
      // A non-empty, object-shaped structuredOutput is a confirmed outcome in
      // its own right: a session with an outputSchema delivers its result as
      // the SDK's structured output and never calls complete_task, so the
      // runner's end-of-session PATCH can still carry a fallback-tagged summary
      // alongside a complete, valid result. Treating that as "never reported"
      // 400'd payloads holding complete plans.
      const hasStructuredOutcome = !!body.structuredOutput
        && typeof body.structuredOutput === 'object'
        && !Array.isArray(body.structuredOutput)
        && Object.keys(body.structuredOutput as Record<string, unknown>).length > 0;
      const isFallbackSummary = !isSensitive && body.summarySource === 'fallback' && !hasStructuredOutcome;

      // A bookkeeping task's only confirmed outcome is a real complete_task
      // call — it has no PR/artifact to fall back on, so a fallback-provenance
      // summary here means the session ended with nothing to show at all.
      // Fail with a message this task shape can act on (the session needs to
      // actually report), not the create_pr hint below, which asks a task
      // that will never open a PR to open one.
      //
      // This only widens what a MISSING confirmed outcome looks like for
      // 'auto' bookkeeping tasks — it must not override an already-satisfied
      // pr_required/artifact_required outcome. Those modes returned earlier
      // in this function when unsatisfied, so by the time we get here a task
      // with one of those requirements has already proven hasPR or an
      // artifact; re-checking both here keeps this branch from discarding a
      // confirmed deliverable just because the session's own complete_task
      // call never landed.
      if (isBookkeepingTask && isFallbackSummary && !hasPR && !(await hasDeliverableArtifact())) {
        const frictionSignature = await persistRejectedCompletionPayload('bookkeeping_no_report');
        return NextResponse.json({
          error: 'Task has no confirmed outcome — the session ended without the agent calling complete_task to report its status. This is a bookkeeping/organizer task: report the outcome via complete_task (summary or structuredOutput), not a pull request or artifact.',
          hint: 'organizer_did_not_report',
          // Machine-readable identity of the refusal, so the runner reports
          // this as the output-gate decision it is instead of unwinding into
          // its crash handler. Same slug the gate_events row above carries —
          // one vocabulary, not two.
          gate: GATE_SLUGS.OUTPUT_REQUIREMENT,
          frictionSignature,
        }, { status: 400 });
      }

      if (outputReq === 'auto' && !isReviewerTask && !isBookkeepingTask && !hasPR && (effectiveCommits > 0 || effectiveDirtyWorktree || isFallbackSummary)) {
        // A coordination/conflict-resolution task legitimately ships nothing on
        // its own branch — its deliverable is action taken against OTHER PRs
        // (a merge, a dispatched release). merge_pr stamps mergedAt on the
        // CALLING worker's row on a GitHub-confirmed merge regardless of whose
        // PR was actually merged (see the PUT handler in
        // apps/web/src/app/api/github/pr/route.ts), so a worker with no PR of
        // its own that still has mergedAt set has a real, verified
        // cross-branch deliverable — not a self-reported claim in the summary.
        const hasCrossBranchDeliverable = !!worker.mergedAt;
        // Explicit, auditable acknowledgement that these edits are scratch and
        // meant to be thrown away — a legitimate success, not the failure
        // shape `error` produces.
        const discardReason = typeof discardEdits === 'string' ? discardEdits.trim() : '';
        if (!hasCrossBranchDeliverable && !discardReason && !(await hasDeliverableArtifact())) {
          // Each variant is a complete leading sentence. The no-work variant
          // used to be spliced into "Task has … but no pull request or
          // artifact", which read "…without the agent calling complete_task
          // but no pull request or artifact".
          const workDescription = effectiveCommits > 0
            ? `Task has ${effectiveCommits} commit(s) on branch but no pull request or artifact.`
            : effectiveDirtyWorktree
              ? 'Task has uncommitted changes in the worktree but no pull request or artifact.'
              : 'Task has no confirmed outcome: the session ended without the agent calling complete_task, and there is no pull request or artifact.';
          const frictionSignature = await persistRejectedCompletionPayload('auto');
          return NextResponse.json({
            error: `${workDescription} Use create_pr to open one for the branch (committing first if needed), or call complete_task with \`discardEdits\` explaining why these edits are being intentionally discarded.`,
            hint: 'create_pr',
            // Machine-readable identity of the refusal, so the runner reports
            // this as the output-gate decision it is instead of unwinding into
            // its crash handler. Same slug the gate_events row above carries —
            // one vocabulary, not two.
            gate: GATE_SLUGS.OUTPUT_REQUIREMENT,
            frictionSignature,
          }, { status: 400 });
        }
        // `discardEdits` is the caller talking the gate out of a refusal it
        // would otherwise have made — the same shape as a lint bypass, and the
        // number that says whether the `auto` gate is asking for a deliverable
        // this class of task can never produce. (A cross-branch deliverable is
        // NOT a bypass: merge_pr verified it against GitHub, so the gate was
        // satisfied rather than overridden.)
        if (discardReason && !hasCrossBranchDeliverable) {
          fireGateEvent({
            gate: GATE_SLUGS.OUTPUT_REQUIREMENT,
            surface: 'PATCH /api/workers/[id]',
            outcome: 'bypassed',
            reason: 'completion accepted under auto: edits discarded by explicit acknowledgement',
            workspaceId: worker.workspaceId,
            missionId: taskMissionId,
            taskId: worker.taskId,
            workerId: worker.id,
            callerOrigin: 'worker',
            detail: {
              outputRequirement: 'auto',
              category: terminalTaskRow[0]?.category ?? null,
              commits: effectiveCommits,
              dirtyWorktree: effectiveDirtyWorktree,
              discardEdits: discardReason.slice(0, 500),
            },
          });
        }
        // Neither satisfier put anything on this worker's own branch — a
        // branch-merge release would find nothing of this worker's own to ship.
        if ((hasCrossBranchDeliverable || discardReason) && !hasPR) skipRelease = true;
      }

      // A non-bookkeeping task declaring outputRequirement='none' (see
      // bookkeepingSkipsGate above — every intentional 'none' creation site is
      // taskClass='bookkeeping') is trusted to conclude with nothing to ship,
      // including via a bare fallback summary: unlike the `auto` arm, a
      // fallback summary ALONE is not the trigger here, because a genuine
      // investigation/diagnosis task ending without complete_task is exactly
      // what 'none' is for. What 'none' never licenses is stranding REAL code
      // changes — a commit or a dirty worktree is concrete evidence of work
      // that needs to land somewhere, and no legitimate 'none' task produces
      // one. A mis-declared 'none' work task that commits real changes and
      // ends on a fallback summary with no PR used to sail through here
      // entirely uninspected, because the whole block used to be skipped for
      // any 'none' task regardless of taskClass.
      if (outputReq === 'none' && !isReviewerTask && !isBookkeepingTask && !hasPR && (effectiveCommits > 0 || effectiveDirtyWorktree)) {
        const hasCrossBranchDeliverable = !!worker.mergedAt;
        const discardReason = typeof discardEdits === 'string' ? discardEdits.trim() : '';
        if (!hasCrossBranchDeliverable && !discardReason && !(await hasDeliverableArtifact())) {
          const workDescription = effectiveCommits > 0
            ? `${effectiveCommits} commit(s) on branch`
            : 'uncommitted changes in the worktree';
          const frictionSignature = await persistRejectedCompletionPayload('none');
          return NextResponse.json({
            error: `Task has ${workDescription} but no pull request or artifact, and outputRequirement is 'none'. Use create_pr to open one for the branch (committing first if needed), or call complete_task with \`discardEdits\` explaining why these edits are being intentionally discarded.`,
            hint: 'create_pr',
            // Machine-readable identity of the refusal, so the runner reports
            // this as the output-gate decision it is instead of unwinding into
            // its crash handler. Same slug the gate_events row above carries —
            // one vocabulary, not two.
            gate: GATE_SLUGS.OUTPUT_REQUIREMENT,
            frictionSignature,
          }, { status: 400 });
        }
        if (discardReason && !hasCrossBranchDeliverable) {
          fireGateEvent({
            gate: GATE_SLUGS.OUTPUT_REQUIREMENT,
            surface: 'PATCH /api/workers/[id]',
            outcome: 'bypassed',
            reason: 'completion accepted under none: edits discarded by explicit acknowledgement',
            workspaceId: worker.workspaceId,
            missionId: taskMissionId,
            taskId: worker.taskId,
            workerId: worker.id,
            callerOrigin: 'worker',
            detail: {
              outputRequirement: 'none',
              category: terminalTaskRow[0]?.category ?? null,
              commits: effectiveCommits,
              dirtyWorktree: effectiveDirtyWorktree,
              discardEdits: discardReason.slice(0, 500),
            },
          });
        }
        if (hasCrossBranchDeliverable || discardReason) skipRelease = true;
      }

      // Handoff gate: tasks with dependents must include handoff.delivered.
      // Lives in this scope (not a standalone `if (isTerminalStatus)` below)
      // because it refuses through the same persistRejectedCompletionPayload
      // ledger every other gate arm here uses.
      try {
        // Check if this task has any dependents (other tasks whose depends_on names this id).
        // The predicate lives in @/lib/handoff-gate so it can be rendered and
        // asserted on — this file's tests stub `drizzle-orm` outright, and the
        // fail-open catch below makes a malformed one indistinguishable from
        // "no dependents".
        const hasDependent = await hasUnfinishedDependent(worker.taskId);

        if (hasDependent) {
          const structuredOutput = body.structuredOutput as { handoff?: TaskHandoff } | null;
          const handoffDelivered = structuredOutput?.handoff?.delivered;
          const isEmptyHandoff = !handoffDelivered || (typeof handoffDelivered === 'string' && !handoffDelivered.trim());

          if (isEmptyHandoff) {
            await persistRejectedCompletionPayload('handoff_required');
            const frictionSignature = fireGateEvent({
              gate: GATE_SLUGS.HANDOFF_REQUIRED,
              surface: 'PATCH /api/workers/[id]',
              outcome: 'rejected',
              reason: 'This task has downstream dependents and must include handoff.delivered in structuredOutput before completing.',
              workspaceId: worker.workspaceId,
              missionId: taskMissionId,
              taskId: worker.taskId,
              workerId: worker.id,
              callerOrigin: 'worker',
              detail: {
                category: terminalTaskRow[0]?.category ?? null,
                summarySource: typeof body.summarySource === 'string' ? body.summarySource : null,
              },
            });
            return NextResponse.json({
              error: 'This task has dependent(s) waiting on it. You must include `handoff.delivered` in your structured output (`structuredOutput.handoff.delivered`) with a one-line summary of what you delivered before completing.',
              hint: 'handoff_required',
              gate: GATE_SLUGS.HANDOFF_REQUIRED,
              frictionSignature,
            }, { status: 400 });
          }
        }
      } catch (err) {
        // Handoff gate is best-effort: a DB error does not block completion
        console.error(`[Worker ${id}] Error checking handoff dependents:`, err);
      }
    }
  }

  // Reserve terminal ownership before mutating the task or running completion
  // hooks. Human interrupt uses the same status CAS, so exactly one path can
  // terminate the lease and produce reviewer outcome side effects.
  //
  // The guard is "the row is still live", not "the row still holds the exact
  // status I read at handler entry". Both express the same exactly-once
  // property — the first terminal write moves the row out of the live set and
  // every later one misses — but the equality form also lost to benign,
  // non-terminal status changes (the runner's own concurrent startup PATCHes),
  // turning a real failure report into a bare `abort` that killed the session.
  let terminalTransitionReserved = false;
  if (isTerminalStatus && worker.status !== status) {
    const [reserved] = await db
      .update(workers)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(workers.id, id), not(inArray(workers.status, TERMINAL_WORKER_STATUSES))))
      .returning({ id: workers.id });

    if (!reserved) {
      // Most commonly: `/respond` already marked this worker `superseded`
      // after a human answered its question, and this PATCH is the runner's
      // own (now-late) terminal report for the same session — see
      // recordPostSupersessionError for why that report must not vanish.
      let postSupersessionErrorRecorded = false;
      if ((status === 'failed' || status === 'error') && typeof error === 'string' && error.trim()) {
        try {
          postSupersessionErrorRecorded = await recordPostSupersessionError(id, error, isSensitive);
        } catch (err) {
          console.error(`[Worker ${id}] Failed to record post-supersession error:`, err);
        }
      }
      return workerConflictResponse(id, postSupersessionErrorRecorded ? { postSupersessionErrorRecorded: true } : undefined);
    }
    terminalTransitionReserved = true;
  }

  // Per-session dollar cap (the SDK's maxBudgetUsd): a ceiling THIS task hit.
  // Nothing about the provider pool is implied, so it is an ordinary task
  // failure: no backend pause, no seat exhaustion flag, no pacing episode, no
  // failover. The runner will send `sessionBudgetCapped` (that half is not
  // shipped yet); a runner without the flag sends only the text, alongside the
  // old `budgetExhausted: true`, which is why the text is checked too and why
  // this beats that flag. A report that also carries a real provider-wall text
  // is a wall, whichever signal marked it as a cap.
  const isSessionBudgetCap = (status === 'failed' || status === 'error') &&
    (body.sessionBudgetCapped === true || isSessionBudgetCapError(error)) &&
    !isBudgetExhaustionError(error);

  // Budget exhaustion detection: a provider wall (session/weekly/quota cap)
  const isBudgetError = status === 'failed' && !isSessionBudgetCap && (
    body.budgetExhausted === true ||
    isBudgetExhaustionError(error)
  );

  // Classify exit cause for taxonomy — written to the worker record on terminal update.
  // budget_limited:    task auto-resumes; not a real failure; excluded from retry caps.
  // sandbox_mount_gap: bwrap path missing; task requeued; excluded from retry caps.
  // infra_failure:     set by stale-worker cleanup, steeringDelivery=true, OR a
  //                    server-side concurrency conflict (the session was killed
  //                    by coordination bookkeeping, not by the work).
  // code_failure:      default for any other terminal failure.
  const isSandboxMountGap = body.sandboxMountGap === true;
  const isSteeringDelivery = body.steeringDelivery === true;
  const isConcurrencyConflict = body.concurrencyConflict === true || isConcurrencyConflictError(error);
  // The runner is reporting that WE refused one of its mutations, rather than
  // that the session crashed. Before this existed, the completion PATCH (the
  // one runner call with no `.catch`) unwound into the runner's crash handler
  // on any 4xx, arrived back here as a plain `failed` whose error was the
  // stringified refusal body, and fell through to code_failure — charging the
  // task a retry for a decision this server made.
  //
  // The refusal's own gate slug is read rather than regex-matched out of the
  // error text: the server minted that slug, so re-deriving it here would be a
  // second vocabulary that can drift from GATE_SLUGS.
  const refusal = (body.refusal ?? null) as
    { status?: number; gate?: string; hint?: string; method?: string; endpoint?: string } | null;
  const isServerRefusal = body.serverRefused === true;
  // An output-gate refusal is about the session's DELIVERABLES (it ran and
  // shipped nothing reviewable), so it stays chargeable under its own cause.
  // Every other refusal is about the REQUEST — a dead credential, a missing
  // row, a malformed body — and says nothing about the work.
  const isOutputGateRefusal = isServerRefusal && refusal?.gate === GATE_SLUGS.OUTPUT_REQUIREMENT;
  const isNonGateRefusal = isServerRefusal && !isOutputGateRefusal;
  // Codex sequential-enforcement deferral: the runner allows only one active
  // Codex worker per workspace and reports extras as failed with a "Deferred:"
  // error. These aren't real failures — re-queue the task so it's retried once
  // the active Codex worker frees, instead of marking it permanently failed.
  // (Matters most under budget failover, which funnels tasks onto Codex.)
  //
  // This has to be decided BEFORE the classification below, not after it: the
  // predicate used to live below the classify call, so a deferred worker —
  // concurrency control working exactly as designed — was booked as
  // `code_failure`, which consumesRetryAttempt() charges. Enough deferrals in a
  // row and a task that was never actually attempted is permanently failed.
  const isCodexDeferral = status === 'failed' && typeof error === 'string' && error.startsWith('Deferred:');
  // A worker correctly asking a human a question should almost never reach
  // this branch — the runner reports `waiting_input`, not `failed`, for that
  // abort. This exists for the remaining terminal paths (the waiting_input
  // timeout in cleanupStuckWaitingInput's sibling case here, or any future
  // producer of the same 'needs_input:' prefix) so a parked question can never
  // fall through classifyReportedFailure's code_failure default.
  const isNeedsInput = (status === 'failed' || status === 'error') && typeof error === 'string' && error.startsWith('needs_input');
  // The runner reconciling a session its own previous process lost (boot-time
  // `Process restarted` report). A runner restart says nothing about the task:
  // it is infra, and it rides the infra retry budget below rather than the
  // task's retry count — which is 0 for a non-mission task.
  const isCrashReconciled = status === 'failed' && crashReconciled === true;
  // The runner's clone of the workspace repo was throttled by GitHub (429 or a
  // secondary rate limit) after its own bounded retries (apps/runner/src/
  // git-clone.ts). Nothing ran; rides the infra retry budget below, with its
  // backoff, so the next attempt lands after GitHub's window instead of the
  // task failing outright.
  const isGithubThrottled = status === 'failed' && body.githubThrottled === true;
  // The CLI's model version gate: this runner cannot serve the model the task
  // was routed to. A deterministic 400 before the first turn, so it is infra
  // and rides the infra retry budget below; the claim route's capability gate
  // routes the next claim around it.
  //
  // The other rejection — the CLI not knowing the id at all — is a config fault
  // the claim route cannot route around (the id comes from a tier row or a
  // pin), so it is NOT retried: the task fails once with the id named, and the
  // attempt is stamped so a CI-fix budget does not count it. The runner flags
  // it because the marker is on stderr and the thrown error is only the exit.
  const isModelIdRejected = (status === 'failed' || status === 'error') &&
    (body.unrecognizedModel === true || isModelIdRejectedError(error));
  const rejectedModel = isModelIdRejected
    ? (typeof body.rejectedModel === 'string' && body.rejectedModel ? body.rejectedModel : rejectedModelId(error))
    : null;
  const isUnrecognizedModel = isModelIdRejected ||
    ((status === 'failed' || status === 'error') && isUnrecognizedModelError(error));
  if (isUnrecognizedModel && !isModelIdRejected && error) {
    void reportWorkerModelIncident(worker.taskId, error);
  }
  if (status === 'failed' || status === 'error') {
    updates.exitCause = classifyReportedFailure({
      taskCancelled: taskCancelledUnderSession,
      crashReconciled: isCrashReconciled,
      githubThrottled: isGithubThrottled,
      unrecognizedModel: isUnrecognizedModel,
      needsInput: isNeedsInput,
      budgetLimited: isBudgetError,
      sandboxMountGap: isSandboxMountGap,
      steeringDelivery: isSteeringDelivery,
      concurrencyConflict: isConcurrencyConflict,
      conditionUnmet: isCodexDeferral,
      serverRefused: isServerRefusal,
      outputGateRefused: isOutputGateRefusal,
    });
  }
  // A non-gate refusal is exempt from the task's retry budget, so record it —
  // an exemption nobody counts is how a runner bug becomes invisible. The
  // output-gate refusals already wrote their own OUTPUT_REQUIREMENT row when
  // the completion was refused; re-recording them here would report one
  // refusal as two gate events.
  if (isNonGateRefusal) {
    fireGateEvent({
      gate: GATE_SLUGS.WORKER_PATCH_REFUSED,
      surface: 'PATCH /api/workers/[id]',
      outcome: 'rejected',
      // RAW on purpose — recordGateEvent normalizes, and pre-normalizing here
      // would make this site disagree with every other gate about sameness.
      reason: `runner reported a refused mutation: HTTP ${refusal?.status ?? '?'} ${error ?? ''}`,
      workspaceId: worker.workspaceId,
      taskId: worker.taskId,
      workerId: worker.id,
      callerOrigin: 'worker',
      detail: {
        status: refusal?.status ?? null,
        method: refusal?.method ?? null,
        endpoint: refusal?.endpoint ?? null,
        hint: refusal?.hint ?? null,
      },
    });
  }
  // Held = task goes back to pending and is NOT treated as a real failure
  // (no failure notification, no task-status overwrite below).
  let isBudgetReset = false;
  let isAuthFailover = false;

  if (isCodexDeferral && worker.taskId) {
    // Guard: a cancelled task must not be re-queued even by a deferral report from
    // its aborted worker. Read the current status first so we can skip the update
    // entirely for cancelled tasks (WHERE clause alone prevents the DB write, but
    // we want to avoid the call when we already know the task is gone).
    const deferralTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, worker.taskId),
      columns: { status: true },
    });
    if (deferralTask?.status !== 'cancelled') {
      await db
        .update(tasks)
        .set({ status: 'pending', claimedBy: null, claimedAt: null, expiresAt: null, updatedAt: new Date() })
        .where(and(eq(tasks.id, worker.taskId), not(eq(tasks.status, 'cancelled'))));
      // An enforce-mode path collision: make the requeue wait for the holder
      // (collided path joins the manifest, so the claim route's lease
      // backstop defers it) and resume from the pushed checkpoint.
      if (reportedPathCollision && typeof reportedPathCollision === 'object') {
        const recorded = await recordPathCollisionDeferral({
          taskId: worker.taskId,
          collision: reportedPathCollision,
          branch: worker.branch ?? null,
        });
        if (recorded) {
          fireGateEvent({
            gate: GATE_SLUGS.PATH_CLAIM,
            surface: 'PATCH /api/workers/[id]',
            outcome: 'deferred',
            reason: 'checkpoint path collision: task deferred behind the holder',
            workspaceId: worker.workspaceId,
            taskId: worker.taskId,
            workerId: worker.id,
            callerOrigin: 'worker',
            detail: {
              path: (reportedPathCollision as Record<string, unknown>).path ?? null,
              blockingTaskId: (reportedPathCollision as Record<string, unknown>).blockingTaskId ?? null,
              source: (reportedPathCollision as Record<string, unknown>).source ?? null,
            },
          });
        }
      }
      // Wake now: the claim route's single-flight and path-lease gates decide
      // whether it may run yet, and re-evaluating is all a wake asks for.
      await wakeTask(worker.taskId, 'task.requeued');
    }
    isBudgetReset = true; // reuse the "held for retry" machinery (no fail notif, re-broadcast pending)
  }

  if (isBudgetError && worker.taskId) {
    // Read the reset time out of the error string, falling back to a full
    // session window when it is absent, unparseable, or stated in a timezone we
    // will not guess at. Extraction lives in @/lib/budget-errors so there is
    // one pattern to keep in step with the agent's wording — this route used to
    // carry a second copy that had to be widened separately (#1678) when the
    // "resets 11:10am (UTC)" form showed up.
    const budgetResetsAt = extractResetTime(error) ?? new Date(Date.now() + SESSION_WINDOW_MS);

    // Fetch the task to get tenant context and workspace teamId
    const taskForBudget = await db.query.tasks.findFirst({
      where: eq(tasks.id, worker.taskId),
      columns: { context: true, workspaceId: true, title: true, backend: true, startAt: true, status: true },
      with: { workspace: { columns: { teamId: true, name: true } } },
    });
    const budgetTaskCtx = (taskForBudget?.context || {}) as Record<string, unknown>;
    const tenantCtx = budgetTaskCtx.tenantContext as { tenantId?: string } | undefined;
    const teamId = (taskForBudget?.workspace as any)?.teamId as string | undefined;

    // WHICH pool ran dry matters. Every provider has its own; recording a Codex
    // rate-limit on accounts.budget_exhausted_at (the Claude/OAuth pool) used to
    // pause Claude as well, so a Codex wall left failover with nowhere to go and
    // the task sat until the Codex reset. The pause log is per backend.
    // The backend THIS run used: a budget-failover flip leaves the stored
    // column on 'claude', so reading it filed a Codex wall as a Claude one and
    // the claim route kept flipping tasks onto the walled Codex pool.
    const walledBackend = claimedBackendOf(taskForBudget?.backend, taskForBudget?.context);
    const budgetScope = {
      teamId,
      accountId: account.id,
      workspaceId: taskForBudget?.workspaceId,
      tenantId: tenantCtx?.tenantId,
    };
    await recordBackendPause({
      backend: walledBackend,
      scope: budgetScope,
      resetsAt: budgetResetsAt,
      reason: 'budget',
      sourceWorkerId: id,
    });

    // The account/tenant flags and the OAuth pacing episode describe Claude
    // session capacity only, so they are written for Claude walls exclusively.
    const isClaudePoolWall = walledBackend === 'claude';
    if (isClaudePoolWall && tenantCtx?.tenantId && teamId) {
      // Tenant-level budget exhaustion: upsert into tenantBudgets
      await db
        .insert(tenantBudgets)
        .values({
          tenantId: tenantCtx.tenantId,
          teamId,
          budgetExhaustedAt: new Date(),
          budgetResetsAt,
        })
        .onConflictDoUpdate({
          target: [tenantBudgets.tenantId, tenantBudgets.teamId],
          set: {
            budgetExhaustedAt: new Date(),
            budgetResetsAt,
            updatedAt: new Date(),
          },
        });
    } else if (isClaudePoolWall && account.authType === 'oauth') {
      // Account-level budget exhaustion: set flag (first-writer wins)
      const exhaustedAt = new Date();
      const flipped = await db
        .update(accounts)
        .set({
          budgetExhaustedAt: exhaustedAt,
          budgetResetsAt,
        })
        .where(and(
          eq(accounts.id, account.id),
          isNull(accounts.budgetExhaustedAt),
        ))
        .returning({ id: accounts.id });

      // Propagate exhaustion to all sibling accounts sharing the same seatId so
      // pacing engages for every registration, not just the one that hit the wall.
      if (flipped.length > 0 && account.seatId && account.teamId) {
        await db
          .update(accounts)
          .set({ budgetExhaustedAt: exhaustedAt, budgetResetsAt })
          .where(and(
            eq(accounts.teamId, account.teamId),
            eq(accounts.seatId, account.seatId),
            eq(accounts.authType, 'oauth'),
            isNull(accounts.budgetExhaustedAt),
          ));
      }

      // Only the request that actually flipped the flag records the episode, so
      // N concurrent budget failures in the same window yield exactly one row.
      // Seat auth has no cost signal, so this measured usage is the only way to
      // learn where the wall is — see packages/core/oauth-budget.ts.
      if (flipped.length > 0) {
        try {
          // Measure across the full seatId group so the episode reflects the
          // combined window usage, not just this account's slice.
          const accountIds = await resolveSeatIdPeers({
            id: account.id,
            teamId: account.teamId ?? '',
            seatId: account.seatId ?? null,
          });
          const prior = await db.query.oauthBudgetEpisodes.findFirst({
            where: inArray(oauthBudgetEpisodes.accountId, accountIds),
            orderBy: (t, { desc }) => [desc(t.exhaustedAt)],
            columns: { resetsAt: true },
          });
          // Same measurement the claim route paces against: window start inferred
          // by sessionizing worker history, usage weighted per model.
          const { windowStartedAt, usage } = await measureOauthWindow({
            accountIds,
            now: exhaustedAt,
            lastResetsAt: prior?.resetsAt ?? null,
          });

          await db.insert(oauthBudgetEpisodes).values({
            accountId: account.id,
            windowStartedAt,
            exhaustedAt,
            resetsAt: budgetResetsAt,
            workerCount: usage.workerCount,
            turns: usage.turns,
            // Raw token split is not recoverable per-direction from the window
            // aggregate; the combined total is what the learner uses.
            inputTokens: usage.tokens,
            outputTokens: 0,
            weightedTurns: usage.weightedTurns,
            weightedTokens: usage.weightedTokens,
          });
          console.log(
            `[workers PATCH] Recorded OAuth budget episode for account ${account.id}: ` +
            `${usage.workerCount} workers / ${usage.turns} turns ` +
            `(${usage.weightedTurns} sonnet-equivalent) since ${windowStartedAt.toISOString()}`,
          );
        } catch (err) {
          // Non-fatal: losing an episode only slows learning, it must never break
          // the budget-exhaustion path that re-queues the task.
          console.warn(`[workers PATCH] Failed to record OAuth budget episode for account ${account.id}:`, err);
        }
      }
    }

    // Provider failover, either direction: move the task to any other enabled,
    // configured, un-walled backend so it is claimable NOW instead of waiting
    // out this provider's reset. Each provider has its own pool, so a Codex wall
    // is escaped via Claude exactly as a Claude wall is escaped via Codex.
    // Non-fatal: with no usable alternative the task stays put and retries on reset.
    let failoverBackend: 'claude' | 'codex' | undefined;
    // Earliest moment ANY other provider frees up. When nothing can take the task
    // now, waking at that moment beats sleeping through our own (later) reset —
    // the claim route re-runs the same failover decision when the task wakes.
    let earliestAlternateReset: Date | null = null;
    // A backend the creator asked for explicitly is never failed over: the task
    // waits out its own provider's reset (provider-failover spec, pinned backends).
    if (taskForBudget?.workspaceId && teamId && !isBackendPinned(taskForBudget?.context)) {
      try {
        const decision = await resolveFailoverBackend({
          from: walledBackend,
          scope: budgetScope,
          enabledBackends: await teamEnabledBackends(teamId),
        });
        for (const blocked of decision.blocked) {
          if (blocked.reason !== 'paused' || !blocked.pausedUntil) continue;
          if (!earliestAlternateReset || blocked.pausedUntil < earliestAlternateReset) {
            earliestAlternateReset = blocked.pausedUntil;
          }
        }
        if (decision.backend) failoverBackend = decision.backend;
        else if (decision.blocked.length > 0) {
          console.log(
            `[workers PATCH] No failover for task ${worker.taskId} (${walledBackend} walled): ` +
            decision.blocked.map(b => `${b.backend}=${b.reason}`).join(', '),
          );
        }
      } catch (err) {
        console.warn(`[workers PATCH] Failover resolution failed for task ${worker.taskId}:`, err);
      }
    }

    // Reset task to pending (not failed) — retried when budget resets, or
    // immediately on Codex when a failover backend was resolved.
    // Guard: don't re-queue a cancelled task even when its worker hit a budget wall.
    const existingCtx = (taskForBudget?.context || {}) as Record<string, unknown>;
    const budgetStartAt = failoverBackend ? null : (() => {
      const wakeAt = earliestAlternateReset && earliestAlternateReset < budgetResetsAt
        ? earliestAlternateReset
        : budgetResetsAt;
      // An explicit deferral floor already on the task still wins.
      return taskForBudget?.startAt && taskForBudget.startAt > wakeAt ? taskForBudget.startAt : wakeAt;
    })();
    if (taskForBudget?.status !== 'cancelled') await db
      .update(tasks)
      .set({
        status: 'pending',
        claimedBy: null,
        claimedAt: null,
        expiresAt: null,
        updatedAt: new Date(),
        ...(failoverBackend && { backend: failoverBackend }),
        ...(budgetStartAt && { startAt: budgetStartAt }),
        context: {
          ...existingCtx,
          budgetExhausted: true,
          // Persisted so every UI surface (detail banner, list/sidebar/mobile
          // badges) can show WHEN it retries without an account join.
          budgetResetsAt: budgetResetsAt.toISOString(),
          previousWorkerId: id,
          ...(failoverBackend && { failedOverFrom: taskForBudget?.backend || 'claude', failoverReason: 'budget_exhausted' }),
        },
      })
      .where(and(eq(tasks.id, worker.taskId), not(eq(tasks.status, 'cancelled'))));

    // A failover is claimable on the other provider now. A deferral wakes at
    // the reset and not before: an instant wake would re-claim straight into
    // the same wall (the 2026-06-25 session-limit storm). notBefore keys the
    // wake onto the trigger's start_at row and publishes its timer.
    if (taskForBudget?.status !== 'cancelled') {
      await wakeTask(
        worker.taskId,
        budgetStartAt ? 'budget.available' : 'task.requeued',
        budgetStartAt ? { notBefore: budgetStartAt } : {},
      );
    }

    if (failoverBackend) {
      console.log(
        `[workers PATCH] Task ${worker.taskId} failed over from ${walledBackend} to ${failoverBackend} ` +
        'after budget/session exhaustion',
      );
    }

    isBudgetReset = true;

    // Distinct alert: this is a budget/rate-limit PAUSE (task reset to pending,
    // auto-retries on reset) — not a generic failure. The normal completion-notify
    // block below is skipped for budget resets, so alert here with the backend +
    // reset time so the operator sees "paused until X", not a misleading failure.
    const walledLabel = backendLabel(walledBackend);
    void notifyTeamOf({ workspaceId: worker.workspaceId }, 'needsAttention', {
      title: `⏳ ${walledLabel} budget/rate-limit hit`,
      message: failoverBackend
        ? `${(taskForBudget as any)?.title || 'Task'}\n${(taskForBudget?.workspace as any)?.name || 'unknown'} — ${walledLabel} paused, re-queued on ${backendLabel(failoverBackend)}.`
        : `${(taskForBudget as any)?.title || 'Task'}\n${(taskForBudget?.workspace as any)?.name || 'unknown'} — claims paused, resets ~${budgetResetsAt.toISOString().slice(11, 16)} UTC. Auto-retries.`,
      url: `https://buildd.dev/app/tasks/${worker.taskId}`,
      urlTitle: 'View task',
      priority: 0,
    });
  }

  // sandbox_mount_gap: a bwrap allowlist path was missing (npm postinstall, config file,
  // or tool binary). Task is infra-class — reset to pending so it can be retried once
  // the operator adds the path via BUILDD_MOUNT_ALLOWLIST_EXTRA. Does NOT count against
  // code-retry attempts (stale-workers mirrors this via the chargeableFailures exclusion).
  //
  // PRECEDENCE RULE — mission-level budget exhaustion wins over task-level requeue.
  // If the task belongs to a budget_exhausted mission, do NOT reset to pending. A pending
  // task in an exhausted mission is silently skipped by the claim loop (PR #1457 refuses to
  // dispatch into exhausted missions), making it invisible to the operator. Instead, fall
  // through to the normal failure path so the mount-gap error surfaces and the failure
  // notification fires. The task becomes retryable once the user raises the mission budget
  // (mission transitions active → tasks claimable again).
  //
  // This flag is also checked in the mission auto-retry block below so that the general
  // 1-retry requeue path for mission tasks is similarly suppressed when budget is exhausted.
  //
  // Coupling note: budget_exhausted status is introduced by PR #1457 (mission cost-budget
  // enforcement). This guard is a no-op on branches that lack that status but becomes
  // load-bearing once #1457 lands; #1457 should rebase onto this branch.
  let sandboxGapMissionExhausted = false; // lifted so the auto-retry block can read it
  if (isSandboxMountGap && worker.taskId) {
    const gapTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, worker.taskId),
      columns: { status: true, missionId: true },
    });

    // Check whether the task's mission has exhausted its cost budget before deciding
    // to requeue — budget exhaustion takes precedence over the mount-gap infra requeue.
    const gapMissionId = (gapTask as any)?.missionId as string | null | undefined;
    if (gapMissionId) {
      const missionRow = await db.query.missions.findFirst({
        where: eq(missions.id, gapMissionId),
        columns: { status: true },
      });
      sandboxGapMissionExhausted = missionRow?.status === 'budget_exhausted';
    }

    if (!sandboxGapMissionExhausted) {
      if (gapTask?.status !== 'cancelled') {
        await db
          .update(tasks)
          .set({ status: 'pending', claimedBy: null, claimedAt: null, updatedAt: new Date() })
          .where(and(eq(tasks.id, worker.taskId), not(eq(tasks.status, 'cancelled'))));
        await wakeTask(worker.taskId, 'task.requeued');
      }
      isBudgetReset = true; // reuse hold-for-retry UX: skip fail notification, re-broadcast pending
    }
    // sandboxGapMissionExhausted=true: fall through so the failure notification fires and
    // the mount-gap error is visible. Task resumes when the mission budget is raised.
  }

  // Auth failover: if a code_failure was caused by an OAuth/auth error and Codex
  // credentials are available, flip the task to Codex instead of permanently failing.
  // Uses the existing auth-error classifier — no new classifier needed.
  // Guard: context.authFailoverApplied prevents flip→fail→flip ping-pong (max 1 flip per chain).
  if (status === 'failed' && !isBudgetReset && !isCodexDeferral && worker.taskId) {
    const isCodeFailure = !isBudgetError && !isSandboxMountGap;
    if (isCodeFailure) {
      // Primary check: classify the body error using the existing auth-error classifier.
      // Fallback: scan error traces if the body error is absent (runner may have
      // classified the auth error only in appendErrorTraces, not in the top-level error field).
      let authSeverity = classifyAuthErrorSeverity(error ?? '');
      if (authSeverity === 'none') {
        try {
          const traces = await db.query.workerErrorTraces.findMany({
            where: eq(workerErrorTraces.workerId, worker.id),
            columns: { pattern: true, excerpt: true },
          });
          for (const trace of traces) {
            const sev = classifyAuthErrorSeverity(trace.excerpt || trace.pattern || '');
            if (sev !== 'none') { authSeverity = sev; break; }
          }
        } catch {
          // Non-fatal: fall through to normal failure if traces unavailable
        }
      }

      if (authSeverity !== 'none') {
        const authTask = await db.query.tasks.findFirst({
          where: eq(tasks.id, worker.taskId),
          columns: { backend: true, workspaceId: true, context: true, status: true },
          with: { workspace: { columns: { teamId: true } } },
        });
        const authTaskCtx = (authTask?.context || {}) as Record<string, unknown>;
        const alreadyFlipped = authTaskCtx.authFailoverApplied === true;
        const currentBackend = authTask?.backend;
        const authTeamId = (authTask?.workspace as any)?.teamId as string | undefined;

        if (
          !alreadyFlipped &&
          !isBackendPinned(authTaskCtx) &&
          authTeamId &&
          authTask?.workspaceId &&
          authTask?.status !== 'cancelled'
        ) {
          try {
            // Same registry-driven choice as the budget path: the credential that
            // was rejected belongs to ONE provider, so any other enabled and
            // configured backend can carry the task.
            const authDecision = await resolveFailoverBackend({
              from: currentBackend,
              scope: {
                teamId: authTeamId,
                accountId: account.id,
                workspaceId: authTask.workspaceId,
                tenantId: (authTaskCtx.tenantContext as { tenantId?: string } | undefined)?.tenantId,
              },
              enabledBackends: await teamEnabledBackends(authTeamId),
            });
            const authFailoverBackend = authDecision.backend;
            if (authFailoverBackend) {
              await db
                .update(tasks)
                .set({
                  status: 'pending',
                  backend: authFailoverBackend,
                  claimedBy: null,
                  claimedAt: null,
                  expiresAt: null,
                  updatedAt: new Date(),
                  context: {
                    ...authTaskCtx,
                    authFailoverApplied: true,
                    failedOverFrom: currentBackend || 'claude',
                    failoverReason: 'auth_failure',
                    previousWorkerId: id,
                  },
                })
                .where(and(eq(tasks.id, worker.taskId), not(eq(tasks.status, 'cancelled'))));

              // Another provider can carry it now; no delay to honour.
              await wakeTask(worker.taskId, 'task.requeued');
              isAuthFailover = true;
              isBudgetReset = true; // gates normal task-update block + skips fail notifications
              console.log(`[workers PATCH] Task ${worker.taskId} failed over to ${authFailoverBackend} after auth failure (${authSeverity})`);
              void notifyTeamOf({ workspaceId: worker.workspaceId }, 'credentialExpired', {
                title: `🔑 Auth failure — failing over to ${backendLabel(authFailoverBackend)}`,
                message: `Task re-queued on ${backendLabel(authFailoverBackend)} after ${backendLabel(currentBackend)} auth failure.\n${(error || '').slice(0, 150)}`,
                url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev'}/app/tasks/${worker.taskId}`,
                urlTitle: 'View task',
                priority: 0,
              });
            }
          } catch (err) {
            console.warn(`[workers PATCH] Auth failover check failed for task ${worker.taskId}:`, err);
          }
        }
      }
    }
  }

  let shouldAutoRetry = false;
  /** A kernel review round that broke its output contract: the T27 reason T4 sends (§6.6). */
  let kernelReviewFailure: 'prose_verdict' | 'no_verdict' | 'infra' | null = null;
  if (status === 'completed' || status === 'failed' || status === 'error') {
    updates.completedAt = new Date();

    await accumulateTerminalSpend();

    // Update task status + snapshot deliverables
    // Skip task update for budget errors — already handled above
    if (worker.taskId && !isBudgetReset) {
      // ── Loop slot ────────────────────────────────────────────────────────────
      // A loop task's exit condition is evaluated here, at completion time, by
      // the loop policy (lib/completion-policy.ts): the ONLY authority that may
      // evaluate it and advance loopIteration. Stale cleanup and webhooks never do.
      let loop: LoopVerdict = null;
      // A slot that fails a task its worker reported completed (loop exhausted,
      // release failed), or a release held for CI. The outcome event below
      // follows these, never the reported status alone.
      let slotFailure: SlotFailure | null = null;
      let releaseHeld = false;
      // Declared here so the requeue case (inside the loop block below) can populate it.
      let taskCtxForRetry: Record<string, unknown> = {};
      if (status === 'completed') {
        loop = await COMPLETION_POLICIES.loop({
          taskId: worker.taskId,
          workerId: id,
          workerBranch: worker.branch ?? null,
          workerLastCommitSha: worker.lastCommitSha ?? null,
          // The runner's own completion carries evidence in the body; the
          // agent's complete_task does not, so use what the runner recorded
          // on the row before that call (see the verificationEvidence column).
          verificationEvidence: verificationEvidence ?? worker.verificationEvidence ?? undefined,
          structuredOutput: body.structuredOutput,
        });

        // condition_unmet is expected control flow — does NOT consume retry attempts.
        if (loop && loop.kind !== 'pass') {
          updates.exitCause = 'condition_unmet';
        }

        // Requeue: piggyback on the shouldAutoRetry machinery to reset to pending.
        if (loop?.kind === 'hold') {
          shouldAutoRetry = true;
          taskCtxForRetry = loop.retryContext;
        }
      }
      // ────────────────────────────────────────────────────────────────────────

      // Auto-retry: mission tasks get 1 automatic retry before permanently failing
      let infraStalledFail = false;
      // A visual-auditor mission task that fails for good (see below).
      let auditStalledFail = false;
      let infraRetryStartAt: Date | null = null;
      const MAX_INFRA_RETRIES_PATCH = 3;
      const INFRA_BACKOFF_MINUTES_PATCH = [5, 15, 30] as const;
      if (status === 'failed') {
        const taskForRetry = await db.query.tasks.findFirst({
          where: eq(tasks.id, worker.taskId),
          columns: { missionId: true, context: true, status: true, roleSlug: true },
        });
        taskCtxForRetry = (taskForRetry?.context || {}) as Record<string, unknown>;
        const retryCount = (taskCtxForRetry.retryCount as number) || 0;
        const maxRetries = taskForRetry?.missionId ? 1 : 0;
        shouldAutoRetry = retryCount < maxRetries;
        // A cancelled task must not be auto-retried — the user explicitly cancelled it.
        if (taskForRetry?.status === 'cancelled') shouldAutoRetry = false;
        // A parked question must never be blind-requeued into the same
        // unanswered question before a human sees it — that both wastes a
        // worker and discards the question. This should be structurally
        // unreachable now that the runner reports waiting_input for this
        // abort, but the exemption stays as the guard against any path that
        // still reports it as a reported `failed` outcome.
        if (isNeedsInput) shouldAutoRetry = false;
        // A session dollar cap is terminal: the retry runs under the same cap
        // and would spend another cap's worth to hit it again.
        if (isSessionBudgetCap) shouldAutoRetry = false;
        // A model id the CLI rejects is rejected identically on every attempt,
        // including a mission task's one automatic retry.
        if (isModelIdRejected) shouldAutoRetry = false;
        // Precedence rule: budget_exhausted mission wins over auto-retry requeue.
        // Same guard as the sandbox_mount_gap block above — a pending task in an
        // exhausted mission is skipped by the claim loop and would be silently stuck.
        if (isSandboxMountGap && sandboxGapMissionExhausted) shouldAutoRetry = false;
        if (shouldAutoRetry) {
          taskCtxForRetry = { ...taskCtxForRetry, retryCount: retryCount + 1 };
        }

        // Provision-gate policy. A worker blocked by the runner's env-verify gate
        // reports a stable failure code (resultMeta.provisionFailure) and spent no
        // agent budget. Act on the KIND of failure:
        //   • transient (flaky readiness probe, install blip) → ONE auto-retry; the
        //     next claim may land after the env settles (e.g. a secret finished
        //     refreshing). Bounded by its own counter so a broken manifest can't loop.
        //   • permanent (missing secret/toolchain, deterministic provision command)
        //     → let it fail so a human / the organizer acts (escalate). No retry.
        // Independent of the mission retry above; setting shouldAutoRetry inherits the
        // held-for-retry UX (task → pending, no fail notification, re-broadcast claimable).
        const provisionCode = (resultMeta as { provisionFailure?: { code?: string } } | undefined)?.provisionFailure?.code;
        const TRANSIENT_PROVISION_CODES = new Set(['provision_readiness_failed', 'provision_install_failed']);
        if (provisionCode && !shouldAutoRetry && TRANSIENT_PROVISION_CODES.has(provisionCode)) {
          const provisionRetryCount = (taskCtxForRetry.provisionRetryCount as number) || 0;
          if (provisionRetryCount < 1) {
            shouldAutoRetry = true;
            taskCtxForRetry = { ...taskCtxForRetry, provisionRetryCount: provisionRetryCount + 1 };
          }
        }

        // Infra failure override (steeringDelivery = true, a non-gate server
        // refusal, or a crash-reconciled runner restart):
        // CLI startup errors (session collision, env collision) are infra — not code bugs.
        // Use a separate infraRetryCount so infra burns don't consume code-failure retry
        // slots. Apply exponential backoff and cap at MAX_INFRA_RETRIES_PATCH attempts.
        //
        // A non-gate refusal rides the same budget deliberately. It is exempt
        // from consumesRetryAttempt, and an exemption with no ceiling is how a
        // task retries forever — so the ceiling is this one, already built,
        // already backed off, already ending in infraStalledFail. An
        // output-gate refusal is excluded: that one IS charged, so it belongs
        // to the ordinary retry budget. A crash-reconciled restart rides it for
        // the same reason: without it, one runner self-update permanently
        // failed every in-flight non-mission task. A model version-gate 400
        // rides it too: bounded, backed off, and uncharged. So does a clone GitHub
        // throttled: the backoff is the point, GitHub needs time.
        if ((isSteeringDelivery || isNonGateRefusal || isCrashReconciled || isGithubThrottled || (isUnrecognizedModel && !isModelIdRejected)) && !isBudgetReset && taskForRetry?.status !== 'cancelled') {
          const infraRetryCount = (taskCtxForRetry.infraRetryCount as number) || 0;
          if (infraRetryCount < MAX_INFRA_RETRIES_PATCH) {
            shouldAutoRetry = true;
            const backoffMins = INFRA_BACKOFF_MINUTES_PATCH[infraRetryCount] ?? 30;
            infraRetryStartAt = new Date(Date.now() + backoffMins * 60_000);
            taskCtxForRetry = { ...taskCtxForRetry, infraRetryCount: infraRetryCount + 1 };
          } else {
            shouldAutoRetry = false;
            infraStalledFail = true;
          }
        }

        if (isModelIdRejected) {
          taskCtxForRetry = {
            ...taskCtxForRetry,
            [MODEL_REJECTION_CONTEXT_KEY]: { model: rejectedModel, at: new Date().toISOString() },
          };
        }

        // Visual auditor (docs/design/visual-qa-auditor.md): an audit that
        // errors before it can park a question has seen nothing. A plain
        // `failed` is terminal in canCompleteMission and would RELEASE the
        // mission, so once its retries are spent it is recorded infra_stalled,
        // which holds the mission until a human looks. A cancel is a human's
        // call and is left alone.
        if (
          !shouldAutoRetry && !infraStalledFail &&
          taskForRetry?.missionId && taskForRetry.roleSlug === VISUAL_AUDITOR_ROLE_SLUG &&
          taskForRetry.status !== 'cancelled'
        ) {
          auditStalledFail = true;
        }

        // Capture branch coordinates from the failing worker for retry continuity.
        // Written for both auto-retry and permanent-failure paths so that CI retry
        // and reviewer-loop retry can read resumeBranch from the task record.
        if (worker.branch) {
          taskCtxForRetry = {
            ...taskCtxForRetry,
            resumeBranch: worker.branch,
            ...(worker.lastCommitSha ? { lastCommitSha: worker.lastCommitSha } : {}),
            failureContext: {
              // Sensitive: drop prose summary, keep errorType code only
              summary: isSensitive
                ? 'runtime_error'
                : (body.error ?? worker.error ?? 'Worker failed without an error message'),
              errorType: 'runtime_error',
              ...(worker.lastCommitSha ? { commitSha: worker.lastCommitSha } : {}),
            },
          };
        }
      }

      // Planning contract guard: a planning task that completes without
      // structuredOutput is not a legitimate completion — the plan came back as
      // free-form text, so no child tasks can be created and the mission would
      // silently produce nothing and re-plan forever. Override to failed.
      //
      // Do NOT attribute a cause here. All the server observes is the absence of
      // structuredOutput; it has no visibility into whether the runner requested
      // outputFormat, and the earlier text asserting it hadn't was probably
      // wrong — the claim route hands the runner the full task row, so
      // resolveOutputFormat() does receive mode:'planning' and does request the
      // schema. Other live candidates: the SDK returned no validated JSON, or
      // the task reached the runner through a path that bypasses claim.
      //
      // Second clause: a schedule-driven, mission-linked heartbeat/organizer
      // cycle whose mode drifted away from 'planning' (e.g. a schedule template
      // edited to drop the mode field — the fccbc723 incident, PR #2045).
      // scheduleId is the positive signal: it is populated ONLY by the cron
      // dispatcher (apps/web/src/app/api/cron/schedules/route.ts) for the tasks
      // it creates itself. creationSource='orchestrator' alone is NOT enough —
      // ordinary execution work created by approvePlan() (mission plan
      // decomposition, the dominant source of mission-linked work tasks) and
      // mission-run.ts's manual "Plan now" cycle both also carry
      // creationSource='orchestrator', but neither is ever dispatched under the
      // planning contract and neither sets scheduleId. The prior version of this
      // clause inferred "owed a plan" from the mere absence of outputSchema and
      // unconditionally failed every such task — including ones that opened a
      // PR (see PR #2074 / task 739cf1e0, reported as friction task f9893aa9).
      const orchestratorTaskRow = terminalTaskRow[0];
      const expectsStructuredPlan = Boolean(
        orchestratorTaskRow?.mode === 'planning' ||
        (orchestratorTaskRow?.creationSource === 'orchestrator' &&
          Boolean(orchestratorTaskRow?.scheduleId) &&
          !orchestratorTaskRow?.outputSchema)
      );
      // A provider/SDK error result (budget wall, session cap, rate limit) never
      // reaches the planning contract at all — the agent didn't get a turn to
      // write a plan, prose or otherwise. The runner can report that as a
      // `completed` PATCH with no structuredOutput (the SDK's error result
      // surfaces as an ordinary terminal message, not a thrown exception), which
      // looks identical to an organizer that ran and silently produced nothing —
      // exactly the shape #2045/#2076 exist to catch. Distinguish them by the
      // positive signal (the error text itself), not by re-deriving intent from
      // absence: check this BEFORE the contract guard fires, the same way
      // `isBudgetError` is checked for a `status:'failed'` report above.
      const completionBudgetError = status === 'completed' && isBudgetExhaustionError(error);
      // A worker that produced a PR or artifact delivered something — the
      // contract this guard polices was satisfied by that deliverable even
      // though it did not arrive as structuredOutput. Silently reclassifying a
      // delivering worker as failed is worse than not enforcing the contract:
      // the stale-worker reaper learned this for termination
      // (checkWorkerDeliverables, task #1594) and this guard needs the same
      // check before overriding a completion.
      const workerDeliveredSomething = expectsStructuredPlan
        ? workerHasPR || (await hasDeliverableArtifact())
        : false;
      // A session that never produced a turn (≤2 turns — or any turn count
      // with an empty terminal usage record — no tokens, $0: the reaper's
      // silent_start shape) did not break either contract below: it
      // never got to write a plan or a verdict, prose or otherwise. Evaluated on
      // this PATCH's values merged over the row, after the budget check (a
      // budget wall is the more specific diagnosis). A turns-less PATCH
      // auto-increments the row by one, so count that turn here too.
      // Never for an interactive (claim_task, runner = 'mcp') worker: no runner
      // streams turns or spend for it, so its zeros say nothing about whether a
      // session died — judging it by this shape discarded real verdicts.
      const isSilentStartCompletion = status === 'completed' && !shouldAutoRetry && !completionBudgetError &&
        worker.runner !== INTERACTIVE_WORKER_RUNNER &&
        isSilentStartShape({
          turns: typeof updates.turns === 'number'
            ? updates.turns
            : (worker.turns ?? 0) + (updates.turns !== undefined ? 1 : 0),
          costUsd: (updates.costUsd as string | undefined) ?? worker.costUsd,
          inputTokens: (updates.inputTokens as number | undefined) ?? worker.inputTokens,
          outputTokens: (updates.outputTokens as number | undefined) ?? worker.outputTokens,
          // Terminal usage record (merged over the row's): lets a many-turn
          // session that never billed a model token count as silent_start.
          resultMeta: (updates.resultMeta ?? worker.resultMeta) as Parameters<typeof isSilentStartShape>[0]['resultMeta'],
        });
      const planningContractViolation = (
        status === 'completed' &&
        !shouldAutoRetry &&
        expectsStructuredPlan &&
        !completionBudgetError &&
        !body.structuredOutput &&
        !workerDeliveredSomething
      );
      // Same shape as the contract guard above, minus the completionBudgetError
      // exclusion — this is what fires instead of it.
      const planningBudgetLimited = (
        status === 'completed' &&
        !shouldAutoRetry &&
        expectsStructuredPlan &&
        completionBudgetError &&
        !body.structuredOutput &&
        !workerDeliveredSomething
      );
      if (planningContractViolation) {
        console.error(
          `[planning-contract-enforcement] task ${worker.taskId} (worker ${id}) ` +
          `overriding completed→failed: orchestrator/planning task returned no ` +
          `structuredOutput, so the plan could not be materialized into child tasks. ` +
          `Cause is not determined server-side — check whether the SDK returned ` +
          `validated JSON for this session (see @buildd/shared resolveOutputFormat ` +
          `for the request side).`
        );
        // Also mark the worker row failed so UI shows the correct terminal state.
        updates.status = 'failed';
        updates.error = isSilentStartCompletion
          ? SILENT_START_ERROR
          : 'Planning task completed without structuredOutput — the plan was not returned as validated JSON, so no child tasks could be created';
        // The classification block above only runs for a *reported* terminal
        // failure, so a completed→failed override arrives here with exitCause
        // still unset. NULL is chargeable (consumesRetryAttempt treats it as
        // an unclassified failure) but it is also indistinguishable from a
        // genuinely unclassified one, so state the cause instead of inheriting
        // the default by accident: not returning the contract's output is the
        // agent's own failure, so it is a code_failure and it should be charged
        // — unless the session never produced a turn at all (silent_start).
        updates.exitCause = isSilentStartCompletion ? 'silent_start' : 'code_failure';
      } else if (planningBudgetLimited) {
        console.error(
          `[planning-contract-enforcement] task ${worker.taskId} (worker ${id}) ` +
          `overriding completed→failed as budget_limited: the SDK returned a ` +
          `provider budget/session error before the organizer produced a plan. ` +
          `Not a planning-contract violation — the agent never got a turn.`
        );
        updates.status = 'failed';
        updates.error = error;
        // Not chargeable: the agent never ran, so this is not its failure —
        // mirrors the `status:'failed'` budget path's `budget_limited` exitCause,
        // which consumesRetryAttempt excludes from retry caps.
        updates.exitCause = 'budget_limited';
        if (taskMissionId) {
          try {
            await db.insert(missionNotes).values({
              missionId: taskMissionId,
              taskId: worker.taskId,
              authorType: 'system',
              type: 'warning',
              title: 'Heartbeat cycle hit a provider budget wall',
              body: `The organizer cycle ended before it could plan: ${error}`,
              status: 'open',
            });
          } catch (err) {
            console.warn(
              `[planning-contract-enforcement] failed to post budget-wall mission note for task ${worker.taskId}:`, err,
            );
          }
        }
      }

      // Review contract guard: a reviewer verdict only reaches
      // handleReviewerOutcomeIfNeeded through structuredOutput.verdict. When the
      // agent writes the verdict as prose instead, the verdict is dropped — no
      // mission note, no auto-merge, no request-changes retry — and the task is
      // recorded as a clean completion, so nothing ever revisits the PR. An
      // unparsed verdict is not a verdict, so fail the task and let the reviewer
      // loop redo it rather than leaving an approved PR open forever.
      //
      // "Unparsed" includes malformed: the verdict is validated against the
      // output contract (enum verdict, confidence a number in [0, 1], string
      // summary), because complete_task passes structuredOutput through
      // unchanged. An out-of-enum verdict used to fall through the outcome
      // switch doing nothing, which reads as review_failed and lets the merge
      // gate pass.
      const reviewTaskRow = terminalTaskRow[0];
      const reviewTaskCtx = (reviewTaskRow?.context ?? {}) as Record<string, unknown>;
      const isReviewerCompletion = (
        status === 'completed' &&
        !shouldAutoRetry &&
        reviewTaskRow?.category === 'review' &&
        Boolean(reviewTaskCtx.reviewerFor)
      );
      const hasVerdictKey = Boolean((body.structuredOutput as { verdict?: unknown } | undefined)?.verdict);
      let parsedReview = isReviewerCompletion ? parseReviewerOutput(body.structuredOutput) : null;
      let reviewContractViolation = isReviewerCompletion && parsedReview?.ok === false;
      // Persist the canonical spelling (request_changes → request-changes), not
      // the variant the agent typed.
      if (parsedReview?.ok) body.structuredOutput = parsedReview.output;
      // Prose (no verdict at all) and a malformed verdict fail the same
      // contract; only the message differs.
      const malformedVerdictReason = reviewContractViolation && hasVerdictKey && parsedReview?.ok === false
        ? parsedReview.reason
        : null;

      // A review round of a kernel-owned delivery: the contract failure is T27
      // (docs/specs/workflow-state-kernel.md §6.3, §6.6). A prose verdict is a
      // failure, never a verdict, so none of the legacy handling below runs for
      // it — no prose fallback, no same-task requeue, no legacy escalation. T4
      // further down sends ReviewRoundFailed with this reason, and T27's
      // bounded re-queue then ESCALATED(review_unavailable) decides what's next.
      const kernelReviewRound = reviewContractViolation
        ? await isKernelReviewRound({ deliveryId: reviewTaskRow?.deliveryId ?? null, context: reviewTaskCtx }).catch((err) => {
            console.error(`[review-contract-enforcement] kernel ownership read failed for task ${worker.taskId}:`, err);
            return false;
          })
        : false;
      if (kernelReviewRound) {
        kernelReviewFailure = isSilentStartCompletion
          ? 'infra'
          : !malformedVerdictReason && extractVerdictFromProse(body.summary).verdict
            ? 'prose_verdict'
            : 'no_verdict';
      }

      // Fallback: if structured output parsing failed and it's due to missing
      // verdict (not malformed), try to extract from prose summary. Legacy
      // reviews only: on a kernel round the prose fallback can only propose.
      if (reviewContractViolation && !malformedVerdictReason && !isSilentStartCompletion && !kernelReviewRound) {
        const proseExtraction = extractVerdictFromProse(body.summary);
        if (proseExtraction.verdict) {
          const fallbackOutput = constructFallbackStructuredOutput(body.summary, proseExtraction);
          if (fallbackOutput) {
            // Use the fallback verdict instead of failing.
            parsedReview = { ok: true, output: fallbackOutput };
            reviewContractViolation = false;
            // Update body.structuredOutput so that handleReviewerOutcomeIfNeeded
            // and other downstream code see the fallback verdict.
            body.structuredOutput = fallbackOutput;
            console.log(
              `[reviewer-prose-fallback] task ${worker.taskId} (worker ${id}) ` +
              `extracted '${proseExtraction.verdict}' verdict from prose: ${proseExtraction.reason}. ` +
              `PR #${reviewTaskCtx.prNumber ?? '?'}`
            );
          }
        }
      }

      // A reviewer task is dispatched only on pull_request action='opened', so
      // nothing re-reviews a PR whose review ended without a verdict. Requeue the
      // same task once — it re-reads the PR from scratch, so a second attempt is
      // idempotent — and only fail if the retry also returns prose.
      const MAX_REVIEW_CONTRACT_RETRIES = 1;
      const reviewContractRetryCount =
        typeof reviewTaskCtx.reviewContractRetryCount === 'number'
          ? reviewTaskCtx.reviewContractRetryCount
          : 0;
      // A reviewer that never produced a turn did not write its verdict as
      // prose, so it must not spend the one contract retry that exists for
      // that. It rides the infra budget (same cap and backoff as a steering
      // crash) so it still cannot requeue forever.
      const reviewSilentStart = reviewContractViolation && isSilentStartCompletion;
      const reviewInfraRetryCount =
        typeof reviewTaskCtx.infraRetryCount === 'number' ? reviewTaskCtx.infraRetryCount : 0;
      if (reviewContractViolation) {
        // A kernel round is re-queued by T27 at the same round, never by the task's own requeue.
        const willRequeue = kernelReviewRound
          ? false
          : reviewSilentStart
            ? reviewInfraRetryCount < MAX_INFRA_RETRIES_PATCH
            : reviewContractRetryCount < MAX_REVIEW_CONTRACT_RETRIES;
        console.error(
          `[review-contract-enforcement] task ${worker.taskId} (worker ${id}) ` +
          `overriding completed→${willRequeue ? 'pending (requeue)' : 'failed'}: review task ` +
          (malformedVerdictReason ? `returned a malformed structuredOutput verdict (${malformedVerdictReason}). ` : `returned no structuredOutput.verdict. `) +
          `The verdict was dropped, so ` +
          `PR #${reviewTaskCtx.prNumber ?? '?'} would sit unmerged.`
        );
        // This worker's review is discarded either way.
        updates.status = 'failed';
        updates.error = reviewSilentStart
          ? SILENT_START_ERROR
          : malformedVerdictReason
            ? `Review task completed with a malformed structuredOutput verdict: ${malformedVerdictReason}`
            : 'Review task completed without structuredOutput.verdict: the verdict was returned as prose and dropped';
        // Same override-after-classification shape as the planning guard: state
        // the cause rather than leaving exitCause NULL. Writing the verdict as
        // prose is the agent's own contract violation, so it stays chargeable —
        // the requeue above has its own separate budget
        // (MAX_REVIEW_CONTRACT_RETRIES) and does not rely on this being exempt.
        updates.exitCause = reviewSilentStart ? 'silent_start' : 'code_failure';
        if (willRequeue && reviewSilentStart) {
          shouldAutoRetry = true;
          const backoffMins = INFRA_BACKOFF_MINUTES_PATCH[reviewInfraRetryCount] ?? 30;
          infraRetryStartAt = new Date(Date.now() + backoffMins * 60_000);
          taskCtxForRetry = {
            ...reviewTaskCtx,
            infraRetryCount: reviewInfraRetryCount + 1,
          };
        } else if (willRequeue) {
          // Piggyback on the shouldAutoRetry machinery to reset the task to pending
          // (same pattern as the loop requeue above).
          shouldAutoRetry = true;
          taskCtxForRetry = {
            ...reviewTaskCtx,
            reviewContractRetryCount: reviewContractRetryCount + 1,
            failureContext:
              (malformedVerdictReason
                ? `Your previous attempt returned a verdict that does not match the output contract (${malformedVerdictReason}), so it was discarded. `
                : 'Your previous attempt wrote the verdict as prose, so it was discarded. ') +
              'The verdict only counts when it is returned as structuredOutput matching ' +
              'the task outputSchema (verdict / confidence / summary). Review the PR again ' +
              'and return the verdict as structuredOutput.',
          };
        } else if (kernelReviewRound) {
          // T27 owns the retry budget and the escalation (review_unavailable);
          // a legacy reviewer_escalated note beside it would be a second authority.
        } else {
          // Retries exhausted and the reviewer contract is dead for this PR.
          // A reviewer task is dispatched only on the webhook's `opened`
          // action (see reviewer.ts), so nothing re-reviews this PR/head SHA
          // outside this task — a silent permanent failure here strands the
          // PR unreviewed forever, with only `get_pr_review` reporting
          // `review_failed`/terminal to anyone who happens to poll. Escalate
          // the same way an iteration-exhausted request-changes loop does.
          await escalateReviewContractFailure({
            taskId: worker.taskId as string,
            repoFullName: String(reviewTaskCtx.repoFullName ?? ''),
            prNumber: Number(reviewTaskCtx.prNumber ?? 0),
            headSha: String(reviewTaskCtx.headSha ?? ''),
            installationId: Number(reviewTaskCtx.installationId ?? 0),
          }).catch((err) => console.error(
            `[review-contract-enforcement] escalation failed for task ${worker.taskId}:`, err,
          ));
        }
      }

      // All three guards fail the task the same way; only the recorded reason differs.
      const contractViolation = planningContractViolation || reviewContractViolation || planningBudgetLimited;

      const taskUpdate: Record<string, unknown> = {
        status: shouldAutoRetry ? 'pending' : (contractViolation ? 'failed' : (status === 'completed' ? 'completed' : 'failed')),
        updatedAt: new Date(),
        ...(shouldAutoRetry ? {
          claimedBy: null,
          claimedAt: null,
          expiresAt: null,
          context: taskCtxForRetry,
          ...(infraRetryStartAt ? { startAt: infraRetryStartAt } : {}),
        } : (planningContractViolation || reviewContractViolation) && isSilentStartCompletion ? {
          result: {
            error: SILENT_START_ERROR,
            errorType: 'silent_start',
          },
        } : planningContractViolation ? {
          result: {
            error: 'Planning task completed without structuredOutput — the plan was not returned as validated JSON, so no child tasks could be created. Mission will retry.',
            errorType: 'planning_contract_violation',
          },
        } : planningBudgetLimited ? {
          result: {
            error,
            errorType: 'budget_limited',
          },
        } : reviewContractViolation ? {
          result: {
            error: malformedVerdictReason
              ? `Review task completed with a malformed structuredOutput verdict (${malformedVerdictReason}). Review will be redone.`
              : 'Review task completed without structuredOutput.verdict — the verdict was returned as prose and dropped. Review will be redone.',
            errorType: 'review_contract_violation',
            // Standing ask from the outputRequirement-rejection bug: a
            // rejected completion must not discard what the agent actually
            // sent. Redacted like every other prose field for a sensitive
            // workspace.
            rejectedSummary: isSensitive
              ? null
              : (typeof body.summary === 'string' ? body.summary.slice(0, 5000) : null),
            rejectedStructuredOutput: isSensitive ? null : (body.structuredOutput ?? null),
          },
        } : status === 'failed' ? {
          // Persist context for permanent failures so CI retry / reviewer-loop can read resumeBranch
          context: taskCtxForRetry,
          ...(infraStalledFail ? {
            result: {
              error: `Task stalled: infra errors prevented startup on ${MAX_INFRA_RETRIES_PATCH} consecutive attempts`,
              errorType: 'infra_stalled',
              infraRetryCount: MAX_INFRA_RETRIES_PATCH,
            },
          } : auditStalledFail ? {
            result: {
              error: isSensitive
                ? 'Visual audit ended without evidence'
                : `Visual audit ended without evidence: ${error ?? worker.error ?? 'worker failed without an error message'}`,
              errorType: 'infra_stalled',
            },
          } : isModelIdRejected ? {
            result: {
              error: `Claude Code on this runner does not recognise model ${rejectedModel ? `"${rejectedModel}"` : '(id not reported)'}; not retried. Fix the tier row or model pin that resolved to it, or update the runner's Claude Code.`,
              errorType: 'unrecognized_model',
              rejectedModel,
            },
          } : isSessionBudgetCap ? {
            result: {
              error: isSensitive ? 'session_budget_capped' : (error ?? 'Session budget cap reached'),
              errorType: 'session_budget_capped',
            },
          } : {}),
        } : {}),
      };

      // Snapshot worker stats into task.result on completion.
      // Skip for loop requeue: the task continues, so no terminal result snapshot yet.
      // Skip for contract violations (planning/review): error result set above.
      if (status === 'completed' && !contractViolation && loop?.kind !== 'hold') {
        // Clean summary: strip shell artifacts like HEREDOC syntax from commit commands
        let summary = body.summary || undefined;
        if (typeof summary === 'string') {
          summary = summary
            .replace(/\$\(cat\s*<<'?EOF'?\n?/g, '')
            .replace(/\nEOF\n?\)\s*"?\s*$/g, '')
            .replace(/\s*Co-Authored-By:.*$/gm, '')
            .trim() || undefined;
        }
        // Sensitive: replace prose summary with machine-generated structured line
        if (isSensitive) {
          const turns = body.turns ?? worker.turns ?? 0;
          const cost = body.costUsd ?? parseFloat(worker.costUsd as string ?? '0');
          const commits = body.commitCount ?? worker.commitCount ?? 0;
          const prNum = worker.prNumber ?? body.prNumber;
          summary = [
            `Completed in ${turns} turns`,
            cost > 0 ? `$${cost.toFixed(2)}` : null,
            prNum ? `PR #${prNum}` : null,
            commits > 0 ? `${commits} commit${commits === 1 ? '' : 's'}` : null,
          ].filter(Boolean).join(' · ');
        }
        // Provenance: 'agent' = passed explicitly to complete_task (or synthesized
        // by the sensitive-redaction branch above, which is structured and factual,
        // never a stray aside); 'fallback' = the runner's own end-of-session PATCH
        // captured the SDK's last assistant message because no complete_task call
        // ever happened (see apps/runner/src/workers.ts). A fallback summary is
        // frequently a conversational aside, not an outcome — downstream consumers
        // (KB ingestion, UI) must not present it as authored. Default to 'agent' when
        // the caller sent a summary but no source at all — both current writers (the
        // runner's fallback PATCH and complete_task) always send it explicitly, so
        // this only covers a caller that predates this field.
        const summarySource: 'agent' | 'fallback' | undefined = !summary
          ? undefined
          : (!isSensitive && body.summarySource === 'fallback' ? 'fallback' : 'agent');
        // Extract phase timeline from milestones for result snapshot
        const finalMilestones = (updates.milestones ?? worker.milestones ?? []) as any[];
        const phases = finalMilestones
          .filter((m: any) => m.type === 'phase')
          .map((m: any) => ({ label: m.label, toolCount: m.toolCount }));

        // Capture last question if worker was in waiting state
        const waitingForData = worker.waitingFor as { prompt?: string } | null;
        const lastQuestion = waitingForData?.prompt || undefined;

        // Re-read worker to pick up auto-detected PR fields
        const freshWorker = await db.query.workers.findFirst({
          where: eq(workers.id, id),
        });

        taskUpdate.result = {
          summary,
          ...(summarySource && { summarySource }),
          branch: worker.branch,
          commits: commitCount ?? worker.commitCount ?? 0,
          sha: lastCommitSha ?? worker.lastCommitSha ?? undefined,
          files: filesChanged ?? worker.filesChanged ?? 0,
          added: linesAdded ?? worker.linesAdded ?? 0,
          removed: linesRemoved ?? worker.linesRemoved ?? 0,
          prUrl: freshWorker?.prUrl ?? worker.prUrl ?? undefined,
          prNumber: freshWorker?.prNumber ?? worker.prNumber ?? undefined,
          ...(phases.length > 0 && { phases }),
          ...(lastQuestion && { lastQuestion }),
          // Structured output from SDK (validated JSON matching task.outputSchema)
          ...(body.structuredOutput && typeof body.structuredOutput === 'object' && { structuredOutput: body.structuredOutput }),
          // Artifact protocol: hint for the orchestrator on what to consider next
          ...(body.nextSuggestion && typeof body.nextSuggestion === 'string' && { nextSuggestion: body.nextSuggestion }),
          // Auditable record of the explicit discard acknowledgement (see the
          // 'auto' output-requirement gate above) — same sensitive treatment
          // as `summary`: a workspace flagged sensitive gets a structured
          // marker instead of the agent's raw prose reason.
          ...(typeof discardEdits === 'string' && discardEdits.trim() && {
            discardedEdits: isSensitive ? 'edits discarded' : discardEdits.trim(),
          }),
          // The merged PR the pr_required gate accepted as carrying this
          // task's work (see `alreadyShippedIn` above).
          ...(alreadyShipped && { alreadyShippedIn: alreadyShipped }),
        };

        // Snapshot unique MCP servers into task result
        const allMcpCalls = (updates.mcpCalls ?? worker.mcpCalls ?? []) as any[];
        if (allMcpCalls.length > 0) {
          (taskUpdate.result as any).mcpServers = [...new Set(allMcpCalls.map((c: any) => c.server))];
        }
      }

      // Inject loop state columns into taskUpdate.
      if (loop) {
        taskUpdate.loopIteration = loop.progress.iteration;
        if (loop.kind === 'pass') {
          taskUpdate.loopState = 'satisfied';
          const existingResult = (taskUpdate.result ?? {}) as Record<string, unknown>;
          taskUpdate.result = { ...existingResult, loopHistory: loop.progress.history };
        } else if (loop.kind === 'hold') {
          taskUpdate.loopState = 'condition_unmet';
          if (loop.startAt) {
            taskUpdate.startAt = loop.startAt;
          }
        } else {
          // Worker reported completed but loop iterations are exhausted → task is failed.
          taskUpdate.status = 'failed';
          slotFailure = { slot: 'loop', label: 'Loop attempts exhausted', reason: loop.reason };
          taskUpdate.loopState = 'exhausted';
          taskUpdate.result = {
            error: loop.reason,
            loopHistory: loop.progress.history,
          };
        }
      }

      // Guard: a cancelled task must not be re-queued (shouldAutoRetry path) nor have
      // its terminal status overridden by a worker that was aborted mid-flight.
      await db
        .update(tasks)
        .set(taskUpdate)
        .where(and(eq(tasks.id, worker.taskId), not(eq(tasks.status, 'cancelled'))));

      // The routing-outcome analytics row this report produces, minus the
      // outcome. Built here so a release held for CI can keep it on the task:
      // the release PR's CI records it with the real outcome
      // (lib/task-outcome-event.ts), not this PATCH.
      const durationMs = worker.startedAt
        ? Date.now() - new Date(worker.startedAt).getTime()
        : null;
      const outcomeAnalytics: HeldOutcomeAnalytics = {
        accountId: worker.accountId,
        actualModel: sessionActualModel,
        totalCostUsd: updates.costUsd ?? worker.costUsd ?? null,
        totalTurns: typeof updates.turns === 'number' ? updates.turns : (worker.turns ?? null),
        durationMs,
        wasRetried: ((taskCtxForRetry.retryCount as number | undefined) ?? 0) > 0,
        // Taxonomy follow-up: code_failure is still the catch-all here, so a
        // readout must treat it as "unclassified", not "the model's fault".
        exitCause: (updates.exitCause as string | null | undefined) ?? worker.exitCause ?? null,
        workerId: id,
      };

      // Run release sequence on successful completion.
      // IMPORTANT: a failed release overrides the task status to 'failed' — the
      // task is not truly done until the release PR lands and prod is healthy.
      // Skip when skipRelease is set (artifact_required satisfied by artifact, no PR).
      if (status === 'completed' && !shouldAutoRetry && !skipRelease && loop?.kind !== 'fail') {
        const releaseInput = { taskId: worker.taskId, workerId: id, workspaceId: worker.workspaceId, missionId: taskMissionId };
        try {
          const release = await COMPLETION_POLICIES.release.evaluate(releaseInput);
          const releaseResult = release.record;
          const resultWithRelease = {
            ...((taskUpdate.result ?? {}) as Record<string, unknown>),
            releaseSummary: release.summary,
          };

          if (release.kind === 'fail') {
            // Release explicitly failed (CI red, merge conflict, no PR found…) —
            // flip the task to FAILED so it never shows as "completed" successfully.
            await db
              .update(tasks)
              .set({
                status: 'failed',
                releaseResult,
                result: resultWithRelease,
                updatedAt: new Date(),
              })
              .where(eq(tasks.id, worker.taskId));
            taskUpdate.result = resultWithRelease;
            slotFailure = { slot: 'release', label: 'Release failed', reason: release.reason };

            // Alert: release failure needs immediate human attention.
            const prLink = release.prUrl ? ` ${release.prUrl}` : '';
            void notifyTeamOf({ workspaceId: worker.workspaceId }, 'needsAttention', {
              title: 'Release failed',
              message: `${release.reason}${prLink}`,
              priority: 1,
              url: release.prUrl || `https://buildd.dev/app/tasks/${worker.taskId}`,
              urlTitle: release.prUrl ? 'Open PR' : 'View task',
            });
          } else if (release.kind === 'hold') {
            // Release PR found but CI not yet green — store tracking info and let
            // the check_suite webhook complete/fail the task when CI resolves.
            // That resolution emits the outcome event; this PATCH emits none.
            releaseHeld = true;
            const existingCtx = (
              await db
                .select({ context: tasks.context })
                .from(tasks)
                .where(eq(tasks.id, worker.taskId))
                .limit(1)
            )[0]?.context as Record<string, unknown> | null ?? {};
            await db
              .update(tasks)
              .set({
                releaseResult,
                result: resultWithRelease,
                context: {
                  ...existingCtx,
                  releasePrPending: true,
                  releasePrNumber: release.prNumber,
                  releasePrUrl: release.prUrl,
                  heldReleaseOutcome: outcomeAnalytics,
                },
                updatedAt: new Date(),
              })
              .where(eq(tasks.id, worker.taskId));
            taskUpdate.result = resultWithRelease;
          } else {
            await db
              .update(tasks)
              .set({ releaseResult, result: resultWithRelease, updatedAt: new Date() })
              .where(eq(tasks.id, worker.taskId));
            taskUpdate.result = resultWithRelease;
          }
        } catch (releaseErr) {
          console.error(`[Worker ${id}] Release execution failed:`, releaseErr);
        }
        // Whatever the verdict: the release policy's follow-up (the mission-level
        // release once every mission task is terminal). Fire-and-forget.
        COMPLETION_POLICIES.release.settled(releaseInput);
      }

      // The outcome is settled: not going back to the queue, and not a release
      // still waiting on CI (its resolution emits this, once, when the status
      // is real: the evidence record reads the task's status off the row).
      // Subscribers (the evidence record) are awaited — a serverless function
      // may freeze an un-awaited write — and isolated by emit, which never throws.
      if (!shouldAutoRetry && loop?.kind !== 'hold' && !releaseHeld) {
        await emit({ type: 'task.terminal', taskId: worker.taskId, workerId: id, workspaceId: worker.workspaceId, sensitive: isSensitive });
      }

      // Record routing outcome for analytics/calibration. Skipped on retry
      // (we only want one row per terminal outcome) and while a release is
      // held (its CI resolution records the row). The outcome is the FINAL
      // status: a contract guard or a completion-policy slot that failed a
      // reported completion records failed. Fire-and-forget.
      const effectiveOutcome = contractViolation || slotFailure ? 'failed' : status;
      if (!shouldAutoRetry) {
        if (!releaseHeld) {
          recordTaskOutcome({ ...outcomeAnalytics, taskId: worker.taskId, outcome: effectiveOutcome }).catch(() => {});
        }
        // Model policy: the run's duration and cost against the policy decision
        // the claim stored. A no-op unless a policy service issued it.
        await reportTaskPolicyOutcome(worker.taskId, codingRunObservations({
          durationMs,
          costUsd: updates.costUsd ?? worker.costUsd ?? null,
        }));
        // Systemic-failure detector: pages (critical) when tasks start failing
        // in a row, so an "all tasks failing on the runner" outage is caught fast.
        if (!releaseHeld) {
          recordRunnerOutcome(effectiveOutcome === 'completed' ? 'completed' : 'failed').catch(() => {});
        }
      }

      // Post-completion side effects (non-fatal — must not block worker update).
      // Each step is guarded independently so one failure can't mask the others,
      // and every silent failure pages via reportOps instead of dying in logs.
      // Capture under the active non-null narrowing: inside the closures below,
      // control-flow narrowing of worker.taskId (string | null) is dropped.
      const taskId = worker.taskId;
      const runStep = async (label: string, fn: () => Promise<void>) => {
        try {
          await fn();
        } catch (stepErr) {
          const msg = stepErr instanceof Error ? stepErr.message : String(stepErr);
          console.error(`[Worker ${id}] post-completion ${label} failed:`, stepErr);
          void reportOps({ source: `worker-completion:${label}`, severity: 'error', message: `${label} failed`, detail: msg });
        }
      };

      // Log triage outcome for planning tasks (evaluation telemetry)
      await runStep('triage-log', async () => {
        if (status === 'completed' && body.structuredOutput?.triageOutcome) {
          const [taskForTriage] = await db
            .select({ mode: tasks.mode, missionId: tasks.missionId, context: tasks.context })
            .from(tasks)
            .where(eq(tasks.id, taskId))
            .limit(1);
          if (taskForTriage?.mode === 'planning' && taskForTriage.missionId) {
            const ctx = (taskForTriage.context || {}) as Record<string, unknown>;
            const planArr = body.structuredOutput.plan as unknown[] | undefined;
            console.log('[triage]', JSON.stringify({
              missionId: taskForTriage.missionId,
              triageOutcome: body.structuredOutput.triageOutcome,
              tasksCreated: Array.isArray(planArr) ? planArr.length : body.structuredOutput.tasksCreated,
              missionComplete: body.structuredOutput.missionComplete,
              cycleNumber: ctx.cycleNumber,
            }));
          }
        }
      });

      // Resolve dependencies (check if parent's children all completed)
      await runStep('resolve-dependencies', async () => {
        await resolveCompletedTask(taskId, worker.workspaceId);
      });

      // Re-arm any schedule that was deferred by its per-schedule concurrent cap
      // if the cap is now freed because this task just completed.
      await runStep('rearm-cap-deferred-schedules', async () => {
        const taskScheduleId = terminalTaskRow[0]?.scheduleId ?? null;
        if (!taskScheduleId || !worker.workspaceId) return;

        // Find the schedule only if it is currently cap-deferred with a future nextRunAt.
        const [schedule] = await db
          .select({
            id: taskSchedules.id,
            maxConcurrentFromSchedule: taskSchedules.maxConcurrentFromSchedule,
          })
          .from(taskSchedules)
          .where(and(
            eq(taskSchedules.id, taskScheduleId),
            eq(taskSchedules.lastDeferralReason, 'concurrent_cap'),
            gt(taskSchedules.nextRunAt, new Date()),
          ))
          .limit(1);

        if (!schedule) return;

        // Count tasks still active from this schedule after the current completion.
        const [countRow] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(tasks)
          .where(and(
            eq(tasks.workspaceId, worker.workspaceId),
            inArray(tasks.status, ['pending', 'assigned', 'in_progress']),
            eq(tasks.scheduleId, taskScheduleId),
          ));

        const remaining = countRow?.count ?? 0;
        if (remaining < schedule.maxConcurrentFromSchedule) {
          await db
            .update(taskSchedules)
            .set({ nextRunAt: new Date(), updatedAt: new Date() })
            .where(eq(taskSchedules.id, taskScheduleId));
        }
      });

      // Module reactions to the report: the criteria verdict handlers, the
      // mission completion attempt and the subject-anchor sweep
      // (lib/mission-subscribers.ts), in that order. Each runs under runStep,
      // so a failure pages under its own label and the next one still runs.
      await emit({
        type: 'worker.reported',
        taskId,
        workerId: id,
        workspaceId: worker.workspaceId,
        missionId: taskMissionId,
        status,
        finalStatus: shouldAutoRetry || releaseHeld ? null : effectiveOutcome === 'completed' ? 'completed' : 'failed',
        releaseHeld,
        structuredOutput: body.structuredOutput,
        verificationEvidence,
      }, { isolate: runStep });

      // Dead-PR shutdown on retry completion: if this worker's PR was merged,
      // close any competing buildd-authored PRs for the same subject.
      // Only fires when the workspace has autoCloseBuilddSupersededPrs=true.
      // Best-effort, error-isolated — same guarantee as the sweep above.
      await runStep('dead-pr-shutdown', async () => {
        const workerPrNumber = worker.prNumber;
        const workerMerged = worker.prLifecycleStatus === 'merged';
        if (!worker.workspaceId || !workerPrNumber) return;

        // Resolve GitHub installation for API calls
        const wsForShutdown = await db.query.workspaces.findFirst({
          where: eq(workspaces.id, worker.workspaceId),
          columns: { githubRepoId: true },
        });
        if (!wsForShutdown?.githubRepoId) return;

        const repoForShutdown = await db.query.githubRepos.findFirst({
          where: eq(githubRepos.id, wsForShutdown.githubRepoId),
          with: { installation: true },
        });
        if (!repoForShutdown?.installation) return;

        await shutdownDeadBuilddPrs(
          worker.workspaceId,
          workerPrNumber,
          workerMerged,
          repoForShutdown.installation.installationId,
          repoForShutdown.fullName,
        );
      });

      // The task's "What shipped" record (lede + change type from the PR diff),
      // which the completed task page leads with. Merged into result, never
      // a rewrite; a failure leaves the page on its title-only fallback.
      await runStep('task-shipped', async () => {
        if (status === 'completed' && loop?.kind !== 'hold') {
          const { storeTaskShippedRecord } = await import('@/lib/task-shipped-store');
          await storeTaskShippedRecord({ taskId, structuredOutput: body.structuredOutput, summarySource: body.summarySource });
        }
      });

      // Auto-create/upsert artifact from structured output or summary.
      // Skip for loop requeue — the task is still running; artifact will be created on final completion.
      await runStep('auto-artifact', async () => {
        if (status === 'completed' && loop?.kind !== 'hold') {
          const [taskForArtifact] = await db
            .select({ context: tasks.context, missionId: tasks.missionId, title: tasks.title })
            .from(tasks)
            .where(eq(tasks.id, taskId))
            .limit(1);
          const ctx = (taskForArtifact?.context || {}) as Record<string, unknown>;
          const structuredOutput = body.structuredOutput;
          const summary = body.summary;

          if (structuredOutput || summary) {
            const isHeartbeat = ctx.heartbeat === true;
            const missionId = taskForArtifact?.missionId as string | undefined;
            const missionTitle = ctx.missionTitle as string | undefined;
            const scheduleId = ctx.scheduleId as string | undefined;
            const scheduleName = ctx.scheduleName as string | undefined;

            let artifactKey: string | null = null;
            let artifactTitle: string | null = null;

            if (isHeartbeat) {
              // Heartbeats are coordination — structured output is logged but doesn't need a standalone artifact
            } else if (missionId) {
              artifactKey = `mission-${missionId}`;
              artifactTitle = `${missionTitle || 'Mission'} — Latest`;
            } else if (scheduleId) {
              artifactKey = `schedule-${scheduleId}`;
              artifactTitle = `${scheduleName || 'Schedule'} — Latest`;
            }

            if (artifactKey && artifactTitle) {
              const content = formatStructuredOutput(
                structuredOutput && typeof structuredOutput === 'object' ? structuredOutput as Record<string, unknown> : undefined,
                typeof summary === 'string' ? summary : undefined
              );

              // Sensitive: never persist prose or the raw structured output —
              // same rule as POST /api/workers/[id]/artifacts.
              await upsertAutoArtifact({
                workerId: id,
                workspaceId: worker.workspaceId,
                key: artifactKey,
                type: structuredOutput ? 'report' : 'summary',
                title: artifactTitle,
                content: isSensitive ? null : (content || null),
                metadata: {
                  autoGenerated: true,
                  taskId,
                  ...(!isSensitive && structuredOutput && typeof structuredOutput === 'object' ? { structuredOutput } : {}),
                  ...(isHeartbeat && structuredOutput ? { heartbeatStatus: (structuredOutput as any)?.status } : {}),
                },
                taskId,
              });
            }
          }
        }
      });

      // BT-7/8/9: Reviewer outcome handling — runs when a reviewer task completes.
      await runStep('reviewer-outcome', async () => {
        // Skip for loop requeue — reviewer logic only applies to terminal completions.
        // A kernel round that broke its contract has no verdict to act on (T27 below).
        if (status !== 'completed' || loop?.kind === 'hold' || kernelReviewFailure) return;
        await handleReviewerOutcomeIfNeeded(taskId, worker.workspaceId, body.structuredOutput);
        // AFTER the outcome is applied, so an on=merge callback sees the merge
        // this verdict may just have triggered. Single-fire and best-effort.
        await deliverReviewCallbackIfRequested(taskId, worker.workspaceId);
      });

      // Workflow kernel T4 (docs/specs/workflow-state-kernel.md §6.5): the owner
      // or fix attempt of a kernel delivery ended. The kernel decides what is
      // next (review round, push recovery, re-dispatch, escalation) from a live
      // GitHub read; an infra requeue is not an attempt end (§5.7 rule 2).
      await runStep('workflow-attempt-ended', async () => {
        // A runner hand-off failure says `outcome: 'unproven'` (S30, §6.6); an old runner omits it.
        const row = terminalTaskRow[0];
        const end = attemptEndFromPatch({
          status: (contractViolation || slotFailure ? 'failed' : status) === 'completed' ? 'completed' : 'failed',
          outcome: body.outcome, localHeadSha: body.localHeadSha, commitCount,
          fallbackLocalHeadSha: lastCommitSha ?? worker.lastCommitSha ?? null,
          fallbackCommitCount: worker.commitCount ?? 0,
        });
        if (!row?.deliveryId || taskRetryCoversAttemptEnd(end, shouldAutoRetry, row?.deliveryRole ?? null) || loop?.kind === 'hold' || releaseHeld) return;
        await workflowAttemptEnded({
          task: { id: taskId, workspaceId: worker.workspaceId, deliveryId: row.deliveryId, deliveryRole: row.deliveryRole ?? null, context: row.context },
          workerId: id,
          ...end,
          source: 'runner',
          taskRetryBudgetLeft: shouldAutoRetry,
          ...(kernelReviewFailure ? { reviewFailure: kernelReviewFailure } : {}),
        });
      });

      // Notify on task completion/failure — routed to the OWNING team's channel.
      await runStep('notify', async () => {
        const taskRecord = await db.query.tasks.findFirst({
          where: eq(tasks.id, taskId),
          // startAt feeds the auto-retry wake below.
          columns: {
            id: true, title: true, description: true, workspaceId: true, mode: true, priority: true,
            missionId: true, backend: true, roleSlug: true, runnerPreference: true, startAt: true,
          },
          with: {
            workspace: {
              columns: {
                id: true, name: true, teamId: true, repo: true, webhookConfig: true,
                githubInstallationId: true, githubRepoId: true,
              },
            },
          },
        });
        if (shouldAutoRetry && taskRecord) {
          // The requeue is already durable (tasks trigger); this labels it and
          // kicks delivery. A backoff/loop startAt keys the wake onto the
          // trigger's scheduled row instead of spending an immediate no-op one.
          const retryAt = taskRecord.startAt ? new Date(taskRecord.startAt) : null;
          const deferred = retryAt && retryAt.getTime() > Date.now() ? retryAt : undefined;
          await wakeTask(worker.taskId!, 'task.requeued', deferred ? { notBefore: deferred } : {});
        }
        const notifyTeamId = (taskRecord?.workspace as { teamId?: string } | undefined)?.teamId;
        if (taskRecord && notifyTeamId) {
          // A contract violation (planning/review) reports `status:'completed'`
          // in the request body — that's what the agent claimed — but the task
          // was overridden to failed/requeued above. Using the raw body status
          // here reported a permanently-failed review-contract violation as
          // "Task done" (see recordTaskOutcome's `effectiveOutcome`, which
          // already applies this same correction).
          // A completion-policy slot overrides the report the same way: a
          // loop that ran out of attempts or a failed release is a failure,
          // and a release held for CI is not an outcome yet (the release
          // PR's CI emits it, github/webhook).
          const isDone = status === 'completed' && !contractViolation && !slotFailure;
          if (releaseHeld && !shouldAutoRetry) return;
          // Who hears about it (the team's channel, the subscriptions ledger,
          // a chat-filed mission's conversation) is the modules' business.
          await emit({
            type: shouldAutoRetry ? 'task.retrying' : isDone ? 'task.completed' : 'task.failed',
            via: 'worker',
            taskId,
            workerId: id,
            workspaceId: worker.workspaceId,
            missionId: taskMissionId,
            title: taskRecord.title,
            sensitive: isSensitive,
            teamId: notifyTeamId,
            workspaceName: taskRecord.workspace?.name ?? null,
            error: error ?? null,
            failure: shouldAutoRetry ? null : slotFailure,
          }, { isolate: (_label, fn) => runStep('notify', fn) });
        }
      });

      // Credential health tracking: update health state on auth failure or success.
      await runStep('credential-health', () => recordCredentialHealthForOutcome(taskId, status, error));
    }
  }

  // ── Human instruction hand-off / delivery confirmation ─────────────────────
  //
  // `pendingInstructions` is served to a consumer and cleared only once that
  // consumer confirms the text reached the agent. `instructionsAck` in the
  // response tells the consumer exactly what to echo back.
  const queuedInstructions = worker.pendingInstructions;
  // Text to hand to this caller (undefined = nothing to hand over).
  let pendingInstructions: string | null = null;
  // Echo token for the confirmation round-trip (declared consumers only).
  let instructionsAck: string | null = null;

  if (instructionAckText) {
    // A consumer confirmed delivery: this is the ONLY place 'delivered' is written.
    updates.instructionHistory = markInstructionsDelivered(worker.instructionHistory, instructionAckText);

    // Clear the queue only while it still holds exactly the text that was
    // delivered. A fresh instruction may have been appended after the hand-off;
    // clearing then would destroy text nobody has seen. Atomic compare-and-set
    // (neon-http has no interactive transactions) — losing the race just means
    // the next check-in serves the queue again, and the runner skips text it
    // has already injected.
    if (queuedInstructions && instructionAckText.includes(queuedInstructions)) {
      const [cleared] = await db
        .update(workers)
        .set({ pendingInstructions: null })
        .where(and(eq(workers.id, id), eq(workers.pendingInstructions, queuedInstructions)))
        .returning({ id: workers.id });
      if (!cleared) {
        console.log(`[workers PATCH] worker ${id}: instruction queue changed during delivery — keeping it queued`);
      }
    }
  } else if (queuedInstructions) {
    pendingInstructions = queuedInstructions;
    if (declaresInstructionConsumer) {
      // Held until confirmed. Nothing is cleared here.
      instructionsAck = queuedInstructions;
    } else if (legacyInstructionConsumer) {
      // Pre-confirmation runner: drain on read, as before. It cannot confirm, so
      // holding the queue would re-inject the same text on every 10s sync.
      updates.pendingInstructions = null;
      updates.instructionHistory = markInstructionsDelivered(worker.instructionHistory, queuedInstructions);
    }
    // else: read-only copy — no state change, the queue survives for the runner.
  }

  // Guard for the final write:
  //  - terminal transition: we already reserved the lease above, so only the row
  //    we reserved may be written (nobody else may steal a terminal outcome).
  //  - reactivation: deliberately writing over the terminal row we read.
  //  - everything else (the hot path): tolerate a concurrent NON-terminal status
  //    change. The runner fires several non-awaited startup PATCHes, so a
  //    branch-only update routinely reads `idle` and writes after a sibling
  //    committed `running`. Gating that on the stale value made the update lose
  //    a race it never conflicted with. Terminated workers are still protected.
  const finalWriteGuard = terminalTransitionReserved
    ? eq(workers.status, status)
    : reactivatingTerminalWorker
      ? eq(workers.status, worker.status)
      : not(inArray(workers.status, TERMINAL_WORKER_STATUSES));

  const [updated] = await db
    .update(workers)
    .set(updates)
    .where(and(eq(workers.id, id), finalWriteGuard))
    .returning();

  if (!updated) {
    return workerConflictResponse(id);
  }

  // Subscriptions ledger: "tell me when this task needs input". Only after the
  // worker write landed, so a conflicted PATCH records nothing. The key is per
  // question, so the runner re-sending the same waitingFor writes one row.
  // Fire-and-forget: emit never throws, and the ledger write adds no latency.
  // Only an admitted park: a held question records nothing now (the resurface
  // pass records it), a recovered one never.
  if (waitingFor?.type === 'question' && worker.taskId && parkAdmitted) {
    void emit({ type: 'task.needs_input', taskId: worker.taskId, workerId: id, prompt: waitingFor.prompt });
  }
  // A held question's deadline, for the resurface sweep's gated tick. After
  // the write landed, like the ledger row; best effort, the floor tick re-seeds.
  if (hold?.held === true) void markHoldDue(id, hold.resurfaceAtMs);

  // One terminal record per worker, on every path that lands here: a real
  // completion, a real failure, a runner-reconciled process death reported as
  // status:'failed' with crashReconciled:true (see
  // apps/runner/src/worker-sync.ts restoreWorkersFromDisk), and a refusal the
  // runner is reporting back to us. The outputRequirement gate's own refusal
  // path writes its row from persistRejectedCompletionPayload above, since a
  // refused completion never reaches this write at all — so the row this
  // branch's `refused` outcome actually creates is the NON-GATE one (a dead
  // credential, a missing row, a rate limit), which has no earlier row to
  // dedupe against. For a gate refusal the row written at 400-time wins on
  // workerId uniqueness, which is correct: it is the write closest to the
  // session end.
  //
  // `crashReconciled` is checked first and the two are mutually exclusive: it
  // is only ever set by the startup reconciliation of a session whose process
  // died, which never had a refusal to report.
  if (isTerminalStatus) {
    fireTerminalRecord({
      workerId: worker.id,
      taskId: worker.taskId,
      workspaceId: worker.workspaceId,
      outcome: crashReconciled === true
        ? 'crashed'
        : isServerRefusal
          ? 'refused'
          : (status === 'completed' ? 'completed' : 'failed'),
      exitCause: updated.error ?? error ?? null,
      turns: updated.turns,
      inputTokens: updated.inputTokens,
      outputTokens: updated.outputTokens,
      costUsd: Number(updated.costUsd ?? 0),
      durationMs: worker.startedAt ? Date.now() - new Date(worker.startedAt).getTime() : null,
      shipped: workerHasPR,
      summaryProvenance: body.summarySource === 'agent' || body.summarySource === 'fallback' ? body.summarySource : null,
    });
  }

  // A conflict retry the runner finished itself (derived files only, no agent).
  // After the write landed, so a refused completion is never counted.
  const derivedMergeEvent = derivedMergeGateEvent(status, body.derivedMergeFinish, {
    workspaceId: worker.workspaceId,
    missionId: taskMissionId,
    taskId: worker.taskId,
    workerId: worker.id,
  });
  if (derivedMergeEvent) fireGateEvent(derivedMergeEvent);

  // The worker's terminal write landed. Module reactions: memory use labels
  // (lib/knowledge-subscribers.ts), scheduled after the response. The first
  // subscriber starts synchronously, so its after() is inside this request.
  if (isTerminalStatus && worker.taskId) {
    void emit({
      type: 'worker.finished',
      taskId: worker.taskId,
      workerId: id,
      accountId: account.id,
      status,
      previousStatus: worker.status,
      serverRefusal: isServerRefusal,
      summary: typeof body.summary === 'string' ? body.summary : null,
      workspace: wsForSensitivity ? { dataClass: wsForSensitivity.dataClass, gitConfig: wsForSensitivity.gitConfig as { dataClass?: string } | null } : null,
    });
  }

  // Release the concurrency seat for OAuth accounts on terminal worker transitions.
  // activeSessions is incremented at claim time; every path that moves a live worker
  // to a terminal state must decrement it so Gate B (maxConcurrentSessions) doesn't
  // permanently block claims after all real work is done.
  if (isTerminalStatus) await releaseTerminalSeat();

  // This worker's terminal transition also frees a slot against the
  // account's maxConcurrentWorkers cap (apps/web/src/app/api/workers/claim/
  // route.ts) — the capacity wall a cloud container's claim can be refused
  // for. Nothing else proactively re-checks a task deferred for exactly that
  // reason; wake the oldest pending claimable task in the SAME workspace so a
  // cloud-dispatched workspace gets a fresh attempt within seconds rather
  // than waiting for the cloud runner's own backoff retry or a slow sweep.
  // No-ops for a workspace with no active cloud-dispatch webhook.
  if (isTerminalStatus) await wakeOldestPendingTaskOnCapacityFreed(worker.workspaceId, worker.taskId ?? null);
  // A managed run ending frees a slot against the team's commercial
  // entitlement, pooled across its workspaces: wake the oldest task waiting on
  // it, wherever it is (lib/entitlements/managed-runner.ts).
  if (isTerminalStatus && (account as { managedRunner?: boolean }).managedRunner) await onManagedWorkerTerminal(worker.workspaceId);

  // Release path claims on terminal status so waiting tasks can proceed.
  //
  // The reason matters more than the release: `pr_required` only requires a PR
  // to EXIST, so a completed worker's PR is normally still open here. Reporting
  // 'merged' would tell the waiter to rebase onto work that has not landed.
  if (isTerminalStatus && worker.taskId) {
    const mergedNow = Boolean(updated.mergedAt ?? worker.mergedAt)
      || (updated.prLifecycleStatus ?? worker.prLifecycleStatus) === 'merged';
    const hasOpenPr = Boolean(updated.prNumber ?? worker.prNumber);
    const releaseReason = mergedNow
      ? 'merged' as const
      : status === 'completed' && hasOpenPr
        ? 'pending_merge' as const
        : 'abandoned' as const;
    // PR handoff: the worker is gone but its PR is open. Its leases are the
    // PR's actual changed files; promote them into the open-PR overlap
    // surface (claim route layer 1 reads the manifest) before letting them
    // go, or a manifest-less task's PR would be invisible to every later
    // claim. Merge/close releases that scope with the PR.
    if (releaseReason === 'pending_merge' && worker.workspaceId) {
      await handoffPrScope({
        workspaceId: worker.workspaceId, taskId: worker.taskId, workerId: id,
        prNumber: (updated.prNumber ?? worker.prNumber ?? null) as number | null,
      });
    }
    await releaseAndNotify(worker.taskId, releaseReason);
  }

  // A fix attempt (review fix, CI retry) just ended. The claim route wrote
  // `Fixing` on the PR comment; close it here, or the comment keeps a spinner
  // on a task that is no longer running. A later red CI result appends its own
  // entry after this one. Only on the transition into a terminal status.
  if (isTerminalStatus && worker.taskId && terminalTaskRow[0] && !isTerminalWorkerStatus(worker.status)) {
    await announceFixEnded(
      { id: worker.taskId, workspaceId: worker.workspaceId, ...terminalTaskRow[0] },
      taskCancelledUnderSession ? 'cancelled' : status === 'completed' ? 'completed' : 'failed',
    );
  }

  // Mission cost-budget gate: check whether the mission's cumulative spend has
  // crossed its costBudgetUsd cap. Only fires on terminal worker status so we
  // read a stable, post-update cost from the DB. Never kills running workers —
  // it transitions the mission to budget_exhausted so future CLAIMS are blocked
  // (enforced in the claim loop's mission budget_exhausted check).
  if (isTerminalStatus && taskMissionId) {
    try {
      const missionBudgetExhausted = await checkAndExhaustMissionBudget(taskMissionId);
      // A sandbox mount gap is normally held pending for infrastructure retry.
      // If this terminal worker's newly-recorded cost exhausts its mission, that
      // pending row would be skipped forever by the claim loop. Preserve the
      // authoritative budget-over-requeue precedence by making the failure visible.
      if (missionBudgetExhausted && isSandboxMountGap && worker.taskId) {
        await db
          .update(tasks)
          .set({ status: 'failed', updatedAt: new Date() })
          .where(and(eq(tasks.id, worker.taskId), not(eq(tasks.status, 'cancelled'))));
      }
    } catch (err) {
      console.error(`[Worker ${id}] Mission budget check failed:`, err);
    }
  }

  // Detect heartbeat-ok suppression: silent completion for heartbeat tasks with status "ok"
  const taskContext = worker.taskId
    ? (await db.query.tasks.findFirst({
        where: eq(tasks.id, worker.taskId),
        columns: { context: true },
      }))?.context as Record<string, unknown> | null
    : null;

  // Serve pending worker-to-worker messages in the response. Written by
  // send_worker_message (MCP), the §6d overlap notifier below, and
  // releaseAndNotify (path_released).
  //
  // SERVE, not drain: the queue used to be emptied by every PATCH that carried
  // touched paths, whether or not anything read the response — which destroyed
  // every message the overlap notifier ever produced. A message now leaves the
  // queue only when a consumer sends `workerMessagesDelivered: [<id>, …]` back,
  // exactly as `instructionsDelivered` confirms the human steering queue.
  // Re-serving an unacked message on the next check-in is the intended
  // behaviour: a client that never acks displays nothing to anyone.
  const pendingWorkerMessages = Array.isArray(taskContext?.pendingWorkerMessages)
    ? (taskContext.pendingWorkerMessages as Array<{ id?: string }>)
    : [];

  // What the response should report after this request's ack is applied. The
  // removal itself runs in SQL against the live column (clearWorkerMessages), so
  // an ack for an id that is not queued writes nothing and a message that
  // arrived after this snapshot is never dropped.
  const retainedWorkerMessages = deliveredMessageIds.length > 0
    ? pendingWorkerMessages.filter(m => !deliveredMessageIds.includes(m?.id ?? ''))
    : pendingWorkerMessages;

  // §6d-derived lease: the observed touch is also a claim.
  //
  // This is the only place the three overlap mechanisms actually meet, and the
  // reason it exists is that two of them were each missing the other's half:
  //
  //   - `tasks.pathManifest` is declared at authoring time and gates claims
  //     (findBlockingPr, layer 1), but only describes what the author *thought*
  //     the scope was — hence the `'**'` sentinel for the common case where
  //     nobody declared one.
  //   - `path_claims` sits ahead of the write and is the only mechanism that can
  //     stop a second agent from starting (the layer-2 backstop in
  //     POST /api/workers/claim), but nothing wrote a row unless an agent
  //     volunteered a `check_path_claim` call — so the gate was rarely holding
  //     a lease when a claim came past it.
  //   - §6d below has the opposite problem: the touch signal is automatic and
  //     complete, but its only output is an advisory message, and it can only
  //     fire once both sides have already edited the file.
  //
  // Leasing the touch converts §6d's after-the-fact report into a lock the next
  // claim is deferred on. `claimObservedPaths` goes through the same locked
  // acquisition as check_path_claim, so it never leases a path another live
  // task holds, nor anything for a task that has closed. It drops regenerable
  // paths (a generated file is not a mutex) and the sentinel; release is keyed to
  // taskId, so every terminal signal frees these with the correct reason —
  // merged / pending_merge / abandoned — with no new plumbing.
  //
  // Fire-and-forget: a lease is a coordination nicety, the progress report is
  // the contract, so a failure here must never reject the sync.
  //
  // A read-only reviewer is skipped: it checks out the PR branch, so the runner
  // reports the whole PR diff as touched, and it never edits any of it. A
  // reviewer *fix* attempt is not a review and still leases.
  //
  // A path the acquisition could not lease because another live task holds it
  // was already written: that is a checkpoint collision
  // (conflict-aware-orchestration.md §2). It comes back on the response as
  // `pathCollisions`, naming the holder, so an enforcing runner stops and
  // defers. Advisory runners only log it; §6d below still messages the holder.
  let pathCollisions: PathCollisionNotice[] = [];
  // A checkpoint sweep (pre-push/completion) re-offers everything it saw: an
  // earlier acquisition that failed or lost a race left the path in
  // observedTouches without a lease, and the diff-against-column rule would
  // never offer it again — yet this is the sweep right before it ships.
  // Own leases are no-ops in acquireObservedPaths.
  // Every reported path is offered, whether or not the sample had room for
  // it: the sample is a diagnostic, the lease is the coverage.
  //
  // With a `workingSet` delta on the request this legacy block is skipped:
  // the delta is applied through lib/working-set-sync.ts below, which also
  // releases reverted paths and records the checkpoint proof.
  let workingSetAck: import('@buildd/shared').WorkingSetAck | null = null;
  const offeredPaths = workingSetDelta
    ? []
    : checkpointSweep === true && Array.isArray(touchedPaths)
      ? [...new Set((touchedPaths as unknown[]).filter((p): p is string => typeof p === 'string'))]
      : newlyObservedPaths;
  if (workingSetDelta && worker.workspaceId && worker.taskId && !isTerminalStatus) {
    const leaseTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, worker.taskId),
      columns: { category: true, context: true },
    }).catch(() => null);
    const applied = await applyWorkingSetSync({
      worker: { id, workspaceId: worker.workspaceId, taskId: worker.taskId },
      delta: workingSetDelta,
      readOnly: isReadOnlyReview(leaseTask?.category, leaseTask?.context),
    });
    workingSetAck = applied.ack;
    pathCollisions = applied.collisions;
  }
  if (offeredPaths.length > 0 && worker.workspaceId && worker.taskId && !isTerminalStatus) {
    try {
      const leaseTask = await db.query.tasks.findFirst({
        where: eq(tasks.id, worker.taskId),
        columns: { category: true, context: true },
      });
      const { inserted: leased, blocked } = isReadOnlyReview(leaseTask?.category, leaseTask?.context)
        ? { inserted: [] as string[], blocked: [] as Array<{ path: string; blockingTaskId: string; blockingPath: string }> }
        : await acquireObservedPaths(worker.workspaceId, worker.taskId, offeredPaths);
      if (leased.length > 0) {
        console.log(`[path-claim] auto-lease: worker ${id} holds ${leased.length} observed path(s) for task ${worker.taskId}`);
      }
      // Declaration denominators (conflict-aware-orchestration.md §3).
      recordPathDeclaration({
        result: blocked.length > 0 ? 'denied' : 'succeeded', provenance: 'observed', surface: 'PATCH /api/workers/[id]',
        workspaceId: worker.workspaceId, taskId: worker.taskId, workerId: id, callerOrigin: 'worker',
        pathCount: newlyObservedPaths.length, detail: { leased: leased.length, blocked: blocked.length },
      });
      if (blocked.length > 0) {
        const holderIds = [...new Set(blocked.map(b => b.blockingTaskId))];
        const holders = await db.query.tasks.findMany({
          where: inArray(tasks.id, holderIds),
          columns: { id: true, title: true },
        }).catch(() => [] as Array<{ id: string; title: string | null }>);
        const titles = new Map((holders ?? []).map(h => [h.id, h.title ?? null]));
        pathCollisions = blocked.map(b => ({
          path: b.path,
          blockingTaskId: b.blockingTaskId,
          blockingTaskTitle: titles.get(b.blockingTaskId) ?? null,
          blockingPath: b.blockingPath,
        }));
      }
    } catch (err) {
      console.error(`[path-claim] auto-lease failed for worker ${id}:`, err);
    }
  }

  if (
    typeof reportedPathClaimDegraded === 'number' && Number.isInteger(reportedPathClaimDegraded)
    && reportedPathClaimDegraded > 0 && reportedPathClaimDegraded <= 10_000 && worker.taskId
  ) {
    // Attributed by cause (timeout vs network/5xx) so a slow round trip is
    // never read as a backend outage — PR #3487's distinction, kept.
    const causes = (body.pathClaimDegradedByCause ?? {}) as Record<string, unknown>;
    const causeCount = (k: string) => (typeof causes[k] === 'number' && Number.isFinite(causes[k]) ? Math.max(0, Math.floor(causes[k] as number)) : 0);
    recordPathDeclaration({
      result: 'degraded', provenance: 'hook', surface: 'PATCH /api/workers/[id]',
      workspaceId: worker.workspaceId ?? null, taskId: worker.taskId, workerId: id, callerOrigin: 'worker',
      pathCount: reportedPathClaimDegraded,
      detail: { causes: { timeout: causeCount('timeout'), error: causeCount('error') } },
    });
  }
  const shipReports = parseShipCheckpointReports(rawShipCheckpoints);
  if (shipReports.length > 0 && worker.taskId) {
    recordShipCheckpointReports({ id, workspaceId: worker.workspaceId ?? null, taskId: worker.taskId }, shipReports);
  }

  // Worker self-classification (Rule K2-15/K2-16).
  //
  // Reported on update_progress rather than complete_task: a kind learned at
  // completion is too late for the claim-time model router, too late for anyone
  // watching the rail while the task runs, and arrives after the row has already
  // rendered unlabelled for its whole life.
  //
  // The write is guarded on `kind IS NULL`, so a worker reporting a kind for an
  // already-classified task gets a no-op and a success, never an error — and an
  // out-of-vocabulary value is ignored here rather than rejecting a progress
  // report, which is the contract this call actually exists to deliver.
  if (isTaskKind(reportedKind) && worker.taskId) {
    try {
      await stampTaskKindIfAbsent(worker.taskId, reportedKind);
    } catch (err) {
      console.error(`[task-kind] self-classification failed for worker ${id}:`, err);
    }
  }

  // §6d Passive overlap detection: compare accumulated observedTouches against active siblings.
  // Advisory-only — never rejects the update_progress call.
  const accumulatedTouches = (updates.observedTouches as string[] | null | undefined) ?? null;
  if (accumulatedTouches && accumulatedTouches.length > 0 && worker.workspaceId && worker.taskId && !isTerminalStatus) {
    try {
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const siblings = await db.query.workers.findMany({
        where: and(
          eq(workers.workspaceId, worker.workspaceId),
          not(eq(workers.id, id)),
          not(inArray(workers.status, TERMINAL_WORKER_STATUSES)),
          isNull(workers.mergedAt),
          gt(workers.updatedAt, twentyFourHoursAgo),
          not(isNull(workers.observedTouches)),
        ),
        columns: {
          id: true,
          taskId: true,
          branch: true,
          lastCommitSha: true,
          observedTouches: true,
          runner: true,
        },
        with: {
          task: { columns: { pathManifest: true } },
        },
      });

      const notifiedOverlaps: Array<{ path: string; siblingTaskId: string }> =
        Array.isArray(taskContext?.notifiedOverlaps)
          ? (taskContext.notifiedOverlaps as Array<{ path: string; siblingTaskId: string }>)
          : [];
      const newNotifications: Array<{ path: string; siblingTaskId: string }> = [];

      for (const sibling of siblings) {
        if (!sibling.taskId) continue;
        const siblingTouches = Array.isArray(sibling.observedTouches) ? sibling.observedTouches as string[] : [];
        if (siblingTouches.length === 0) continue;

        // Wildcard guard: skip siblings with advisory pathManifest (**).
        const siblingManifest = (sibling.task as any)?.pathManifest as string[] | null | undefined;
        if (isAdvisoryManifest(siblingManifest)) continue;

        if (!pathsOverlap(accumulatedTouches, siblingTouches)) continue;

        // Identify overlapping paths for this sibling.
        const normalizeP = (p: string) => p.replace(/\/+$/, '');
        const overlappingPaths = accumulatedTouches.filter(p => {
          const np = normalizeP(p);
          return siblingTouches.some(sp => {
            const nsp = normalizeP(sp);
            return np === nsp || np.startsWith(nsp + '/') || nsp.startsWith(np + '/');
          });
        });

        // Dedupe gate: skip pairs already notified this session.
        const newPaths = overlappingPaths.filter(p =>
          !notifiedOverlaps.some(n => n.path === p && n.siblingTaskId === sibling.taskId),
        );
        if (newPaths.length === 0) continue;

        for (const p of newPaths) {
          newNotifications.push({ path: p, siblingTaskId: sibling.taskId! });
        }

        // A generated file is not a mutex. `docs/specs/INDEX.md` and the drizzle
        // journal are among the most contended files in this repo by
        // concurrent-PR overlap, and none of those overlaps is something the two
        // agents need to agree about — whoever pushes second re-runs one command.
        // Splitting here keeps the block message about real work while still
        // passing the generated-file overlap along, with the right verb.
        const { contended, regenerable } = partitionRegenerableOverlaps(newPaths);

        // Emit Pusher event on workspace channel.
        const overlapEvent = {
          detectedWorkerId: id,
          detectedTaskId: worker.taskId,
          siblingWorkerId: sibling.id,
          siblingTaskId: sibling.taskId,
          overlappingPaths: contended,
          regenerablePaths: regenerable.map(r => r.path),
          detectedByBranch: updated.branch ?? worker.branch,
          detectedBySha: updated.lastCommitSha ?? worker.lastCommitSha ?? null,
        };
        await triggerEvent(channels.workspace(worker.workspaceId), 'path_overlap_detected', overlapEvent);

        // Deliver structured WorkerMessage to sibling's task via pendingWorkerMessages.
        // One atomic append (capped in SQL): the sibling is checking in and
        // writing its own context, so a read-modify-write here loses whichever
        // of the two wrote second.
        //
        // That queue is read only by an interactive session (update_progress
        // surfaces `workerMessages`); a runner-managed session never reads it,
        // so every message to one was lost. For those the same text also goes
        // on the instruct queue, which the runner injects at its next check-in.
        const deliver = async (message: WorkerMessage) => {
          await enqueueWorkerMessage(sibling.taskId!, message);
          if (sibling.runner !== INTERACTIVE_WORKER_RUNNER) {
            await queueSystemInstruction(sibling.id, formatWorkerMessages([message]))
              .catch(err => console.error(`[Worker ${id}] overlap instruction to ${sibling.id} failed:`, err));
          }
        };
        if (contended.length > 0) {
          await deliver(buildWorkerMessage({
            type: 'path_blocked_on_you',
            fromTaskId: worker.taskId,
            toTaskId: sibling.taskId!,
            body: {
              overlappingPaths: contended,
              detectedByBranch: updated.branch ?? worker.branch,
              detectedBySha: updated.lastCommitSha ?? worker.lastCommitSha ?? null,
              funcNames: [] as string[],
            },
          }));
        }
        if (regenerable.length > 0) {
          await deliver(buildWorkerMessage({
            type: 'path_regenerable_overlap',
            fromTaskId: worker.taskId,
            toTaskId: sibling.taskId!,
            body: {
              overlappingPaths: regenerable.map(r => r.path),
              commands: [...new Set(regenerable.map(r => r.command))],
              detectedByBranch: updated.branch ?? worker.branch,
              detectedBySha: updated.lastCommitSha ?? worker.lastCommitSha ?? null,
            },
          }));
        }
      }

      // Persist notifiedOverlaps as a jsonb merge, NOT a spread of the snapshot
      // read before this loop began. The loop above does several round trips and
      // a Pusher call, so a message enqueued by a sibling in that window would be
      // reverted by a whole-column overwrite — the same loss this PR removes,
      // arriving by a different route.
      if (newNotifications.length > 0) {
        await db
          .update(tasks)
          .set({
            context: sql`COALESCE(${tasks.context}, '{}'::jsonb) || jsonb_build_object('notifiedOverlaps', ${JSON.stringify([...notifiedOverlaps, ...newNotifications])}::jsonb)`,
          })
          .where(eq(tasks.id, worker.taskId));
      }
      if (deliveredMessageIds.length > 0) {
        await clearWorkerMessages(worker.taskId, deliveredMessageIds);
      }
    } catch (err) {
      console.error(`[Worker ${id}] Passive overlap detection failed:`, err);
      // Fall through — an ack still has to be honoured.
      if (deliveredMessageIds.length > 0) {
        await clearWorkerMessages(worker.taskId, deliveredMessageIds);
      }
    }
  } else if (deliveredMessageIds.length > 0 && worker.taskId) {
    // No overlap detection this tick — honour the delivery ack on its own.
    await clearWorkerMessages(worker.taskId, deliveredMessageIds);
  }

  const isHeartbeatOk =
    taskContext?.heartbeat === true &&
    status === 'completed' &&
    body.structuredOutput?.status === 'ok';

  // Trigger realtime events.
  // Thin-event pattern: send only identifiers + status, never the full worker
  // row. The full row can exceed Pusher's 10 KB limit (instructionHistory,
  // mcpCalls, milestones). Clients that need fresh row data call router.refresh()
  // or re-fetch; clients that only need status use the fields below.
  const eventName = status === 'completed' ? events.WORKER_COMPLETED
    : status === 'failed' ? events.WORKER_FAILED
    : events.WORKER_PROGRESS;

  const pusherPayload: Record<string, unknown> = {
    workerId: id,
    taskId: worker.taskId,
    status: updated.status,
    updatedAt: updated.updatedAt,
  };
  // The mission page's live store patches the MOVING row's line from this
  // (knowledge-base: buildd/design/mission-feed-mobile-continuity.md, S7) instead of re-rendering.
  // `updates.currentAction` is the persisted value: already secret-redacted and
  // masked to 'working' for a sensitive workspace. Capped for Pusher's 10 KB.
  if (typeof updates.currentAction === 'string' && updates.currentAction) {
    pusherPayload.currentAction = updates.currentAction.slice(0, 200);
  }
  if (taskProgress && Array.isArray(taskProgress) && taskProgress.length > 0) {
    // taskProgress is transient (not persisted) — must travel via Pusher
    pusherPayload.taskProgress = taskProgress;
  }
  if (isHeartbeatOk) {
    pusherPayload.heartbeatOk = true;
  }

  await triggerEvent(channels.worker(id), eventName, pusherPayload);

  if (worker.workspaceId) {
    await triggerEvent(channels.workspace(worker.workspaceId), eventName, pusherPayload);
  }

  // Broadcast budget-reset task status change for dashboard visibility.
  // Not a wake: each requeue above already called wakeTask. A budget deferral
  // wakes at its reset (notBefore = startAt), never now — an instant re-claim
  // into the same wall was the 2026-06-25 session-limit storm.
  if (isBudgetReset && worker.taskId) {
    // Auth failover: signal backend change, not a budget pause
    const taskResetPayload = isAuthFailover
      ? { task: { id: worker.taskId, workspaceId: worker.workspaceId, status: 'pending', backend: 'codex' } }
      : { task: { id: worker.taskId, workspaceId: worker.workspaceId, status: 'pending', budgetExhausted: true } };
    await triggerEvent(
      channels.workspace(worker.workspaceId),
      events.TASK_UPDATED,
      taskResetPayload,
    );
  }

  // Send the webhook callback on completion/failure
  // Smart suppression: skip notifications for heartbeat tasks with status "ok", auto-retried failures, or budget resets
  if ((status === 'completed' || status === 'failed') && worker.taskId && !isHeartbeatOk && !shouldAutoRetry && !isBudgetReset) {
    try {
      const taskForNotify = await db.query.tasks.findFirst({
        where: eq(tasks.id, worker.taskId),
        with: { workspace: true },
      });

      if (taskForNotify?.workspace) {
        const result = (taskForNotify as any).result as {
          summary?: string;
          prUrl?: string;
          structuredOutput?: unknown;
        } | null;
        // Webhook callback (enriched with worker performance data)
        // Sensitive: redacted stub — no summary or structured output in payload
        const completedAt = updates.completedAt ?? worker.completedAt;
        const startedAt = updates.startedAt ?? worker.startedAt;
        const durationMs = startedAt && completedAt
          ? new Date(completedAt as any).getTime() - new Date(startedAt as any).getTime()
          : null;
        sendTaskCallback(taskForNotify as any, {
          status,
          summary: isSensitive ? undefined : result?.summary,
          prUrl: result?.prUrl,
          structuredOutput: isSensitive ? undefined : (result as any)?.structuredOutput,
        }, {
          turns: updates.turns ?? worker.turns,
          inputTokens: updates.inputTokens ?? worker.inputTokens,
          outputTokens: updates.outputTokens ?? worker.outputTokens,
          costUsd: updates.costUsd ?? worker.costUsd,
          durationMs,
          commitCount: updates.commitCount ?? worker.commitCount,
          filesChanged: updates.filesChanged ?? worker.filesChanged,
          linesAdded: updates.linesAdded ?? worker.linesAdded,
          linesRemoved: updates.linesRemoved ?? worker.linesRemoved,
        }).catch((err) => console.error('Task callback error:', err));
      }
    } catch (err) {
      // Non-fatal — don't block the response
      console.error('Notification dispatch error:', err);
    }
  }

  // ── Deliver undelivered user replies / mission guidance to this worker ──────
  //
  // Selection is by delivery state, not by note status. Answered questions stay
  // 'answered' and guidance stays 'open' forever, so re-selecting them on every
  // check-in re-injected the same replies and guidance every ~10 seconds — each
  // injection adding a chat message and a milestone, which visibly filled the
  // task timeline with duplicates. `mission_notes.delivered_to` records the
  // workers a note has already been handed to; a note is served once per worker,
  // so mission-wide guidance still reaches each worker exactly once.
  //
  // Only a consumer is served: a milestone-only PATCH that ignores the response
  // would otherwise mark notes delivered that nothing ever injected.
  let noteInstructions = '';
  if (instructionConsumer && status !== 'completed' && status !== 'failed' && worker.taskId) {
    try {
      const taskForNotes = await db.query.tasks.findFirst({
        where: eq(tasks.id, worker.taskId),
        columns: { missionId: true },
      });
      // Task-scoped notes (a task with no mission) are addressed by taskId. The
      // block used to require a missionId, so replies on mission-less tasks were
      // never delivered at all.
      const noteScope = taskForNotes?.missionId
        ? eq(missionNotes.missionId, taskForNotes.missionId)
        : and(isNull(missionNotes.missionId), eq(missionNotes.taskId, worker.taskId));
      // Not yet handed to THIS worker.
      const undeliveredToWorker = sql`NOT (COALESCE(${missionNotes.deliveredTo}, '[]'::jsonb) @> ${JSON.stringify([id])}::jsonb)`;
      const servedNoteIds: string[] = [];

      // Find this worker's answered questions
      const workerQuestions = await db.query.missionNotes.findMany({
        where: and(
          noteScope,
          eq(missionNotes.workerId, id),
          eq(missionNotes.type, 'question'),
          eq(missionNotes.status, 'answered'),
        ),
        columns: { id: true, title: true },
      });

      if (workerQuestions.length > 0) {
        // Fetch the undelivered replies to those questions
        const questionIds = workerQuestions.map(q => q.id);
        const replies = await db.query.missionNotes.findMany({
          where: and(
            noteScope,
            eq(missionNotes.type, 'reply'),
            eq(missionNotes.authorType, 'user'),
            inArray(missionNotes.replyTo, questionIds),
            undeliveredToWorker,
          ),
          orderBy: [desc(missionNotes.createdAt)],
        });

        if (replies.length > 0) {
          const replyLines = replies.map(r => {
            const q = workerQuestions.find(wq => wq.id === r.replyTo);
            return `- Re: "${q?.title || 'question'}": ${r.title}${r.body ? ` — ${r.body}` : ''}`;
          });
          servedNoteIds.push(...replies.map(r => r.id));
          noteInstructions += `\n\n**USER REPLIES:**\n${replyLines.join('\n')}`;
        }
      }

      // Also deliver mission-wide guidance notes this worker has not seen
      const guidance = await db.query.missionNotes.findMany({
        where: and(
          noteScope,
          eq(missionNotes.type, 'guidance'),
          eq(missionNotes.status, 'open'),
          undeliveredToWorker,
        ),
        orderBy: [desc(missionNotes.createdAt)],
        limit: 5,
      });

      if (guidance.length > 0) {
        const guidanceLines = guidance.map(g => `- ${g.title}${g.body ? `: ${g.body}` : ''}`);
        servedNoteIds.push(...guidance.map(g => g.id));
        noteInstructions += `\n\n**MISSION GUIDANCE:**\n${guidanceLines.join('\n')}`;
      }

      // Stamp at hand-off, with a per-row atomic append (no read-modify-write, so
      // two concurrent check-ins for different workers cannot clobber each other).
      if (servedNoteIds.length > 0) {
        await db
          .update(missionNotes)
          .set({
            deliveredTo: sql`COALESCE(${missionNotes.deliveredTo}, '[]'::jsonb) || ${JSON.stringify([id])}::jsonb`,
          })
          .where(inArray(missionNotes.id, servedNoteIds));
      }
    } catch (err) {
      console.error(`[Worker ${id}] Note delivery failed:`, err);
    }
  }

  const allInstructions = [pendingInstructions, noteInstructions].filter(Boolean).join('') || undefined;

  // Live sibling conflict probe: apply results, mark the workspace due on new
  // touches, hand this runner its probes. Never throws.
  const siblingProbes = worker.workspaceId
    ? await siblingProbeHeartbeat({
        workerId: id,
        workspaceId: worker.workspaceId,
        results: siblingProbeResults,
        supportsProbe: supportsSiblingProbe === true,
        touchesMoved: reportedTouches.length > 0,
        terminal: isTerminalStatus,
      })
    : [];

  // Return worker with any pending instructions, worker-to-worker messages, and output warnings
  return jsonResponse({
    ...updated,
    instructions: allInstructions,
    // Echo token: the consumer sends this back as `instructionsDelivered` once
    // the text is in the agent session, which is what clears the queue.
    ...(instructionsAck ? { instructionsAck } : {}),
    ...(retainedWorkerMessages.length > 0 ? { pendingMessages: retainedWorkerMessages } : {}),
    ...(pathCollisions.length > 0 ? { pathCollisions } : {}),
    // The working-set ACK: what this delta leased, released or found held,
    // and whether coverage is complete for its generation.
    ...(workingSetAck ? { workingSetAck } : {}),
    ...(siblingProbes.length > 0 ? { siblingProbes } : {}),
  }, undefined, { route: req.nextUrl.pathname });
}

// ── Reviewer outcome handling (BT-7, BT-8, BT-9) ────────────────────────────

/**
 * Push the review outcome to the URL the requester supplied, if any.
 *
 * Only on-demand reviews (`request_pr_review` with a `callbackUrl`) carry one;
 * for every other review this is a no-op read. Never throws — a caller waiting
 * on a callback can still poll, but a failed notification must not fail the
 * worker report.
 */
async function deliverReviewCallbackIfRequested(reviewerTaskId: string, workspaceId: string): Promise<void> {
  try {
    const reviewerTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, reviewerTaskId),
      columns: { category: true, context: true },
    });
    const ctx = (reviewerTask?.context ?? {}) as Record<string, unknown>;
    if (reviewerTask?.category !== 'review' || !ctx.reviewCallback) return;
    const prNumber = typeof ctx.prNumber === 'number' ? ctx.prNumber : null;
    if (!prNumber) return;

    const { deliverPrReviewCallback } = await import('@/lib/pr-review-request');
    const outcome = await deliverPrReviewCallback({
      workspaceId,
      prNumber,
      repoFullName: typeof ctx.repoFullName === 'string' ? ctx.repoFullName : undefined,
    });
    console.log(`[pr-review] verdict callback for PR #${prNumber}: ${outcome}`);
  } catch (error) {
    console.warn(
      `[pr-review] verdict callback for review task ${reviewerTaskId} failed:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Called in the post-completion `runStep` sequence when a reviewer task finishes.
 * Reads `context.reviewerFor` to identify this as a reviewer task, then
 * dispatches the appropriate outcome: approve → auto-merge, request-changes →
 * retry task on same branch, escalate → Pushover + mission note.
 */
async function handleReviewerOutcomeIfNeeded(
  reviewerTaskId: string,
  workspaceId: string,
  structuredOutput: unknown,
): Promise<void> {
  const reviewerTask = await db.query.tasks.findFirst({
    where: eq(tasks.id, reviewerTaskId),
    columns: { id: true, category: true, context: true, missionId: true, title: true, createdAt: true, deliveryId: true },
  });

  if (!reviewerTask) return;
  const ctx = (reviewerTask.context ?? {}) as Record<string, unknown>;

  // Only process tasks that are reviewer tasks (category='review' + reviewerFor in context)
  if (reviewerTask.category !== 'review' || !ctx.reviewerFor) return;

  // Backstop for the contract guard in PATCH, which already failed/requeued a
  // malformed verdict: nothing below may act on one, and nothing below has to
  // re-check the shape (e.g. `confidence.toFixed`).
  const parsed = parseReviewerOutput(structuredOutput);
  if (!parsed.ok) {
    console.warn(`[reviewer] Task ${reviewerTaskId} completed without a valid verdict in structuredOutput: ${parsed.reason}`);
    return;
  }
  const output: ReviewerTaskOutput = parsed.output;

  const originalTaskId = ctx.reviewerFor as string;
  const prNumber = ctx.prNumber as number;
  const prUrl = ctx.prUrl as string;
  const headSha = ctx.headSha as string;
  const repoFullName = ctx.repoFullName as string;
  const installationId = ctx.installationId as number;
  const workerBranch = ctx.workerBranch as string;
  const missionId = reviewerTask.missionId;

  // iteration is stored in context, not as a column
  const currentIteration = typeof ctx.iteration === 'number' ? ctx.iteration : 0;
  const maxIterations = typeof ctx.maxIterations === 'number' ? ctx.maxIterations : 3;

  console.log(`[reviewer] Verdict for PR #${prNumber}: ${output.verdict} (confidence ${output.confidence})`);

  // The mission-criteria side report, recorded before any of the verdict
  // handling below. It reads nothing the verdict path writes and writes nothing
  // the verdict path reads — and it is awaited rather than fired off so a
  // reviewer whose PR auto-merges on the very next line cannot race its own
  // finding into a mission that has already been evaluated.
  await recordReviewerCriteriaFindings({
    missionId,
    reviewerTaskId,
    reviewerContext: ctx,
    structuredOutput,
    prNumber,
    headSha,
    originalTaskId,
    verdict: output.verdict,
  }).catch(err =>
    console.error(`[criteria-reviewer] recording findings for PR #${prNumber} failed:`, err),
  );

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    // releaseConfig is read for prodBranch — one of the trunk branches a model
    // verdict may never merge into (see protectedBaseBranches).
    columns: { id: true, gitConfig: true, releaseConfig: true },
  });
  const missionForPolicy = missionId
    ? await db.query.missions.findFirst({
        where: eq(missions.id, missionId),
        columns: WORKERS_POLICY_MISSION_COLUMNS,
      })
    : null;

  // The PR being gated, read before the policy because the policy depends on it:
  // under Option A′ a task PR based on the mission's integration branch is not
  // the mission's review gate — the single PR from that branch into trunk is —
  // so the tier drops here and applies there instead.
  const gatedWorker = await db.query.workers.findFirst({
    where: and(eq(workers.workspaceId, workspaceId), eq(workers.prNumber, prNumber)),
    // `prBaseRef: null` means "unknown", which resolvePolicy treats as
    // not-the-integration-branch — i.e. it degrades to today's gate.
    columns: { id: true, taskId: true, prBaseRef: true },
  });

  const reviewPolicy = workspace
    ? resolvePolicy(workspace, missionForPolicy, null, { baseRef: gatedWorker?.prBaseRef ?? null })
    : null;

  // Re-derive the escalation gates from the PR's CURRENT file list. Pre-flight
  // ran at most once, on the webhook's `opened` action; a PR pushed to during a
  // request-changes iteration is never re-gated, and POST /api/github/pr/review
  // creates a reviewer task with no pre-flight at all. This is the last point
  // before the merge, and it reads files only — never the model's own
  // escalationReason, which is downstream of an untrusted diff.
  let effectiveVerdict = output.verdict;
  let serverOverrideReason: string | null = null;
  let serverOverrideSource: 'files' | 'confidence' | null = null;
  if (output.verdict === 'approve' && reviewPolicy) {
    let currentFiles: Array<{ filename: string }> = [];
    let migrationSafety: MigrationSafety | undefined;
    try {
      const { githubApi } = await import('@/lib/github');
      const fetched = await githubApi(
        installationId,
        `/repos/${repoFullName}/pulls/${prNumber}/files?per_page=300`,
      );
      if (Array.isArray(fetched)) currentFiles = fetched;
      const { inspectPullRequestMigrations } = await import('@/lib/migration-inspector');
      migrationSafety = await inspectPullRequestMigrations({
        installationId,
        repoFullName,
        prNumber,
        headSha,
        files: currentFiles as never,
      });
    } catch (err) {
      // Leave currentFiles empty: the helper treats an unreadable file list as
      // grounds to escalate, so a transient GitHub failure cannot grant a merge.
      console.warn(`[reviewer] Could not re-check PR #${prNumber} files at verdict time:`, err);
    }

    const enforced = enforceServerSideEscalation({
      verdict: output.verdict,
      prFiles: currentFiles,
      policy: reviewPolicy,
      policyConfig: workspace?.gitConfig?.policyConfig ?? undefined,
      migrationSafety,
    });
    effectiveVerdict = enforced.verdict;
    serverOverrideReason = enforced.overrideReason;
    if (serverOverrideReason) serverOverrideSource = 'files';
  }

  // The confidence bar applies to the VERDICT, not only to the unbounded
  // self-merge: every approve posts a GitHub APPROVE and may run the bounded
  // merge into a mission integration branch below. An approval under the
  // workspace threshold is an escalation. Checked after the file gates so a
  // file-list reason, the more specific one, wins when both apply.
  // For request-changes and escalate from prose extraction: apply the gate so
  // low-confidence verdicts (from fallback parsing) are escalated for human
  // confirmation rather than triggering automated actions immediately.
  const gated = applyConfidenceGate({
    verdict: effectiveVerdict,
    confidence: output.confidence,
    threshold: reviewPolicy?.agentReview?.maxConfidenceThreshold,
  });
  if (gated.overrideReason) {
    effectiveVerdict = gated.verdict;
    serverOverrideReason = gated.overrideReason;
    serverOverrideSource = 'confidence';
  }

  if (serverOverrideReason) {
    console.warn(
      `[reviewer] PR #${prNumber}: model said approve, server escalated — ${serverOverrideReason}`,
    );
    // Persist the verdict that ACTUALLY applies, alongside (never over) the
    // agent's own output. Without this the stored review still reads
    // `approve`, so `derivePrReviewStatus` reports `approved` — and both the
    // self-merge check and the review-verdict gate would clear a PR the
    // server just escalated to a human.
    await db
      .update(tasks)
      .set({
        result: sql`COALESCE(${tasks.result}, '{}'::jsonb) || jsonb_build_object('effectiveVerdict', ${effectiveVerdict}::text, 'effectiveVerdictReason', ${serverOverrideReason}::text)`,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, reviewerTaskId))
      .catch((err: unknown) =>
        console.error(`[reviewer] could not persist server escalation for PR #${prNumber}:`, err),
      );
  }

  // ── Workflow kernel (docs/specs/workflow-state-kernel.md T6) ────────────
  // A review round of a kernel delivery: the verdict is recorded against the
  // round's own head. Only an APPLIED verdict acts; a verdict for a superseded
  // head or round is kept on its round for audit and does nothing else (no
  // GitHub review, no fix, no merge). The kernel's effects post the review,
  // dispatch the fix and raise escalations; the legacy writes below do not run.
  let kernelOwnsVerdict = false;
  if (reviewerTask.deliveryId && ctx.workflowRoundId) {
    kernelOwnsVerdict = true;
    const kv = await recordReviewVerdict({
      reviewerTask: { id: reviewerTaskId, deliveryId: reviewerTask.deliveryId, context: ctx },
      verdict: output.verdict,
      effectiveVerdict,
      headSha,
      confidence: output.confidence,
    }).catch((err) => {
      console.error(`[reviewer] workflow kernel could not record the verdict for PR #${prNumber}:`, err);
      void reportOps({ source: 'workflow-kernel:verdict', severity: 'error', message: `verdict not recorded for PR #${prNumber}`, detail: err instanceof Error ? err.message : String(err) });
      return null;
    });
    if (!kv) return;
    if (!kv.handled) {
      kernelOwnsVerdict = false; // released to legacy (kill switch): the legacy path below decides
    } else if (kv.result.result !== 'applied') {
      console.log(`[reviewer] PR #${prNumber}: verdict ${output.verdict} at ${headSha.slice(0, 7)} ${kv.result.result} (${kv.result.reason}) — recorded, not applied`);
      return;
    }
  }

  // ── Corrected lede ───────────────────────────────────────────────────────
  // Applied HERE, server-side, because the reviewer agent is read-only and
  // never touches the PR — it proposes, this handler applies, the same division
  // as the verdict itself.
  //
  // Deliberately not awaited into any decision below: the verdict is already
  // fixed by this point, and nothing in this block can change it. A failure
  // resolves to `{ applied: false }` (the helper never throws), which the
  // mission note and the switch below simply ignore. The most common outcome by
  // far is `no correction proposed`, which touches GitHub not at all.
  const ledeCorrection = await applyReviewerLedeCorrection({
    installationId,
    repoFullName,
    prNumber,
    correctedLede: output.correctedLede,
    workspaceId,
  }).catch((err) => {
    console.warn(`[reviewer] lede correction threw unexpectedly for PR #${prNumber}:`, err);
    return { applied: false as const, reason: 'unexpected error' };
  });

  // Surfaced as SIGNAL, not a quiet patch. A lede that contradicts its own diff
  // usually means the agent misunderstood its own change, so the correction is
  // recorded on the decision note a human reads — alongside the reviewer's own
  // `summary`, which the prompt requires to name the contradiction.
  const ledeNote = ledeCorrection.applied
    ? `\n\nLede corrected: the PR's opening sentence contradicted the diff, and has been replaced. The author's original is preserved in the PR body: “${ledeCorrection.original}”`
    : '';

  // Audit event — every decision is persisted as a mission note
  if (missionId) {
    await db.insert(missionNotes).values({
      missionId,
      taskId: originalTaskId,
      authorType: 'system',
      type: effectiveVerdict === 'approve'
        ? 'reviewer_approved'
        : effectiveVerdict === 'request-changes'
          ? 'reviewer_request_changes'
          : 'reviewer_escalated',
      title: effectiveVerdict === 'approve'
        ? `PR #${prNumber} approved by reviewer (confidence ${output.confidence.toFixed(2)})`
        : effectiveVerdict === 'request-changes'
          ? `PR #${prNumber}: reviewer requested changes (iteration ${currentIteration + 1}/${maxIterations})`
          : `PR #${prNumber} escalated: ${serverOverrideReason ?? output.escalationReason ?? 'see details'}`,
      // Recommendation rides in the body behind a fixed marker so the escalation
      // card can lead with it (see selectReviewerEvidence).
      // A server override says so explicitly: the reviewer's own summary would
      // otherwise read as an approval on a card that escalated.
      body: (serverOverrideReason
        ? `The reviewer approved this PR, but the server escalated it to a human (${serverOverrideSource === 'confidence' ? 'the approval is below the confidence bar' : 'the file list requires a human'}): ${serverOverrideReason}.\n\nReviewer summary: ${output.summary}`
        : (output.feedback ?? output.escalationReason ?? output.summary))
        + ledeNote
        + (effectiveVerdict === 'escalate' && output.recommendation
            ? `${RECOMMENDATION_MARKER}${output.recommendation}`
            : ''),
      status: 'open',
    });
  }

  // Model policy: the verdict on the builder's run, as typed observations.
  await reportTaskPolicyOutcome(originalTaskId, reviewVerdictObservations(effectiveVerdict));

  // Post the verdict to GitHub as a real review — mission-scoped or not. Without
  // this, buildd's own store is the only place the verdict ever existed: GitHub
  // branch protection requiring an approving review can never be satisfied by an
  // agent verdict, and the PR page shows no trace a review happened at all.
  // postPrReview is idempotent per (PR, head SHA, resulting state), so a forced
  // re-review that reaches the same verdict on the same commit does not stack a
  // second approval.
  if (!kernelOwnsVerdict && (effectiveVerdict === 'approve' || effectiveVerdict === 'request-changes')) {
    const reviewPostResult = await postPrReview({
      installationId,
      repoFullName,
      prNumber,
      headSha,
      event: effectiveVerdict === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES',
      body: effectiveVerdict === 'approve'
        ? `Approved by buildd reviewer (confidence ${output.confidence.toFixed(2)}): ${output.summary}`
        : `Changes requested by buildd reviewer: ${output.feedback ?? output.summary}`,
    }).catch((err) => ({
      posted: false as const,
      reason: err instanceof Error ? err.message : 'unknown error',
    }));
    // postPrReview never throws on a GitHub-side failure — it resolves
    // `{ posted: false, reason }` — so a plain `.catch` on the call above only
    // ever fires for a genuinely unexpected rejection. Without checking
    // `posted` here, a real post failure (bad token, deleted PR, API outage)
    // resolved successfully and silently: buildd's own store had the verdict
    // but GitHub never showed a review at all, with nothing in the logs to
    // say so.
    if (
      !reviewPostResult.posted &&
      reviewPostResult.reason !== 'a matching review already exists for this commit'
    ) {
      console.error(
        `[reviewer] failed to post GitHub review for PR #${prNumber}: ${reviewPostResult.reason}`,
      );
      if (missionId) {
        await db.insert(missionNotes).values({
          missionId,
          taskId: originalTaskId,
          authorType: 'system',
          type: 'warning',
          title: `Reviewer verdict could not be posted to GitHub for PR #${prNumber}`,
          body: `buildd recorded a ${effectiveVerdict} verdict, but posting it to GitHub as a review failed: ${reviewPostResult.reason ?? 'unknown error'}`,
          status: 'open',
        });
      }
    }
  }

  // The verdict is recorded: let the supersession table cancel what it made
  // obsolete — every open review fix on an approve, and on any verdict a
  // not-yet-started fix that answers an older round. Before the switch, so an
  // approve's merge below never races a fix that is about to push. Never throws.
  const verdictEvent: SubjectEvent = {
    kind: 'verdict',
    verdict: effectiveVerdict,
    workspaceId,
    prNumber,
    reviewerTaskId,
    headSha,
    roundCreatedAt: reviewerTask.createdAt ?? null,
    originalTaskId,
    door: 'PATCH /api/workers/[id] (reviewer verdict)',
    pr: { installationId, repoFullName },
  };
  if (!kernelOwnsVerdict) await reconcileSubjectEvent(verdictEvent);

  // Kernel deliveries: the fix dispatch, exhaustion and escalation were the
  // kernel's effects. Only an approval continues, into the landing doors,
  // which stay legacy until the landing slice (§14 Slice C).
  if (kernelOwnsVerdict && effectiveVerdict !== 'approve') return;

  switch (effectiveVerdict) {
    case 'approve': {
      // BT-7: Approve path — trigger auto-merge (unless gateCondition is 'approve-only')
      const approvePolicy = reviewPolicy;

      if (approvePolicy?.agentReview?.gateCondition === 'approve-only') {
        // Reviewer approved but gateCondition requires human to press merge.
        // Post a note and surface in escalation inbox — do NOT auto-merge.
        if (missionId) {
          await db.insert(missionNotes).values({
            missionId,
            taskId: originalTaskId,
            authorType: 'system',
            type: 'reviewer_approved',
            title: approvedAwaitingMergeTitle(prNumber),
            body: `Reviewer approved (confidence ${output.confidence.toFixed(2)}): ${output.summary}\n\nGate condition is 'approve-only'. Merge from the escalation inbox.`,
            status: 'open',
          });
        }
        await appendPrActivity({
          installationId,
          repoFullName,
          prNumber,
          entry: { kind: 'review_approved_awaiting_human', note: output.summary },
          workspaceId,
        });
        console.log(`[reviewer] PR #${prNumber} approved (approve-only) — leaving merge to human`);
        break;
      }

      // Find original worker to get its id (needed for tryAutoMergeWorkerPr signature)
      const originalWorker = await db.query.workers.findFirst({
        where: and(
          eq(workers.workspaceId, workspaceId),
          eq(workers.prNumber, prNumber),
        ),
        columns: { id: true, taskId: true },
      });

      if (!workspace || !originalWorker) {
        console.warn(`[reviewer] Cannot auto-merge PR #${prNumber}: missing workspace or worker`);
        return;
      }

      await appendPrActivity({
        installationId,
        repoFullName,
        prNumber,
        entry: { kind: 'review_approved', note: output.summary },
        workspaceId,
      });

      // This merge is authorised by a MODEL verdict, so it is bounded by the
      // branch it lands in: a quarantined mission integration branch, never
      // the workspace's trunk. Keyed off the PR's real base ref inside
      // evaluateAutoMergeSafety — not off a workspace-level flag, so a
      // workspace whose task PRs still target dev cannot inherit unattended
      // merges by accident.
      const approveBound = {
        protectedBranches: protectedBaseBranches({
          gitConfig: workspace.gitConfig,
          releaseConfig: workspace.releaseConfig,
        }),
      };

      // ONE landing call replaces the two attempts below once the workspace is
      // in `enforce`. It evaluates the LIVE head (eventHeadSha null), not the
      // SHA the reviewer read: if the branch moved since, carry-forward decides
      // whether this approval still covers it, and a behind PR is refreshed
      // once with a marker — there is no second attempt against a superseded
      // head to misread its update-branch refusal as a conflict. The bound's
      // fallback to the unbounded self-merge rule is a branch inside landPr.
      const landingMode = resolveLandingMode(workspace.gitConfig);
      if (landingMode !== 'off') {
        const outcome = await landPr({
          workspaceId,
          installationId,
          repoFullName,
          prNumber,
          eventHeadSha: null,
          door: 'approve',
          actor: { kind: 'system' },
          mode: landingMode,
          policy: approvePolicy!,
          owner: { taskId: originalWorker.taskId ?? null, workerId: originalWorker.id },
          bound: approveBound,
          releaseConfig: workspace.releaseConfig ?? null,
          gitConfig: workspace.gitConfig ?? null,
        });
        if (landingMode === 'enforce') {
          console.log(`[reviewer] approve for PR #${prNumber}: landing outcome ${outcome.kind}`);
          break;
        }
      }

      const boundMergeResult = await tryAutoMergeWorkerPr({
        installationId,
        repoFullName,
        prNumber,
        headSha,
        worker: { id: originalWorker.id, taskId: originalWorker.taskId },
        policy: approvePolicy!,
        bound: approveBound,
        surfaceOrderingConfig: workspace.gitConfig ?? null,
      });

      // The bound above only ever authorises landing in a quarantined mission
      // integration branch — an ordinary PR based on trunk is refused there
      // by design. Under tier=agent-review the arrival of THIS approve is the
      // only event that will ever re-check the stored verdict for such a PR
      // (check_suite already fired, possibly before the review finished), so
      // it is the trigger for the SAME unbounded self-merge authorisation the
      // check_suite CI-green retry and merge_pr's escape hatch use —
      // `isApprovalSelfMergeable`, the one definition of "does this verdict
      // clear the confidence bar" all three call sites share.
      if (
        !boundMergeResult.merged &&
        approvePolicy?.tier === 'agent-review' &&
        isApprovalSelfMergeable(
          { verdict: 'approve', confidence: output.confidence, merged: false },
          approvePolicy.agentReview?.maxConfidenceThreshold,
        )
      ) {
        const selfMergeResult = await tryAutoMergeWorkerPr({
          installationId,
          repoFullName,
          prNumber,
          headSha,
          worker: { id: originalWorker.id, taskId: originalWorker.taskId },
          policy: approvePolicy,
          surfaceOrderingConfig: workspace.gitConfig ?? null,
        });
        if (!selfMergeResult.merged) {
          console.log(
            `[reviewer] approve for PR #${prNumber} did not self-merge: ${selfMergeResult.reason}`,
          );
        }
      }
      break;
    }

    case 'request-changes': {
      // BT-8: Request-changes path — create retry task on the SAME branch
      if (currentIteration >= maxIterations) {
        // Iteration cap exceeded — escalate using the shared reviewer exhaustion path.
        // escalateReviewerExhaustion is CAS-deduped on (taskId, headSha) so concurrent
        // reviewer completions on the same SHA fire exactly one escalation.
        console.log(`[reviewer] Iteration cap (${maxIterations}) reached for PR #${prNumber} — escalating`);
        await escalateReviewerExhaustion(
          originalTaskId,
          repoFullName,
          prNumber,
          headSha,
          maxIterations,
          output.feedback ?? null,
        );
        await appendPrActivity({
          installationId,
          repoFullName,
          prNumber,
          entry: {
            kind: 'review_escalated',
            detail: `after ${maxIterations} fixes`,
            note: output.feedback ?? null,
          },
          workspaceId,
        });
        return;
      }

      // Fetch original task data for the retry
      const originalTask = await db.query.tasks.findFirst({
        where: eq(tasks.id, originalTaskId),
        columns: {
          id: true, title: true, description: true, missionId: true, pathManifest: true,
          // The attempt's identity (see attemptIdentityFrom): read in the same
          // query rather than a second one.
          backend: true, roleSlug: true, kind: true, complexity: true,
          missionPhaseIndex: true, missionPhaseLabel: true,
          context: true,
        },
      });
      if (!originalTask) {
        console.warn(`[reviewer] Cannot create retry: original task ${originalTaskId} not found`);
        return;
      }

      // An explicitly-reviewed dependency-bot PR gets its verdict, not a
      // builder: a fix commit would take the branch away from the bot. The
      // feedback stays on the review for a human (or the bot's next bump).
      if (isDependencyBotPrContext(originalTask.context)) {
        const reason = dependencyBotPushRefusal(prNumber);
        console.log(`[reviewer] request-changes on PR #${prNumber}: ${reason} — no follow-up builder`);
        fireGateEvent({
          gate: GATE_SLUGS.DEPENDENCY_BOT_PR,
          surface: 'PATCH /api/workers/[id]',
          outcome: 'rejected',
          reason,
          workspaceId,
          taskId: originalTaskId,
          callerOrigin: 'system',
          detail: { prNumber, headSha, stage: 'review_followup' },
        });
        await appendPrActivity({
          installationId,
          repoFullName,
          prNumber,
          entry: {
            kind: 'review_escalated',
            detail: 'dependency-bot PR · no fix pushed',
            note: output.feedback ?? output.summary ?? null,
          },
          workspaceId,
        });
        return;
      }

      // Dispatch guard: the supersession table in skip_dispatch mode. A newer
      // round (finished or not), an approve, or a merged/closed PR means this
      // fix would be cancelled the moment it existed — so it is never created.
      const fixProposal: DispatchProposal = {
        kind: 'fix',
        workspaceId,
        prNumber,
        parentTaskId: originalTaskId,
        triggeringReviewTaskId: reviewerTaskId,
        door: 'PATCH /api/workers/[id] (request-changes fix)',
      };
      const dispatchCheck = await checkDispatch(fixProposal);
      if (dispatchCheck.verdict === 'skip_dispatch') {
        console.log(`[reviewer] Skipping fix dispatch for PR #${prNumber}: ${dispatchCheck.rule}`);
        return;
      }

      // Fetch the prior attempt's worker to get lastCommitSha for retry continuity
      const priorWorker = await db.query.workers.findFirst({
        where: and(
          eq(workers.workspaceId, workspaceId),
          eq(workers.prNumber, prNumber),
        ),
        columns: { lastCommitSha: true },
      });
      const reviewerLastCommitSha = priorWorker?.lastCommitSha ?? null;

      // Insert with dedup guard — reviewerRetryPrNumber + reviewerRetryHeadSha form a
      // partial unique index so a second reviewer completion on the same headSha is a
      // no-op. A new headSha after the fix push starts a fresh cycle (new row).
      const [retryTask] = await db
        .insert(tasks)
        .values({
          workspaceId,
          title: formatAttemptTitle('builder', originalTask.title, {
            reason: 'after review',
            iteration: currentIteration + 1,
          }),
          description: originalTask.description,
          missionId: originalTask.missionId,
          parentTaskId: originalTaskId,
          taskClass: 'attempt',
          // Same backend, role, routing kind and phase as the task it fixes.
          ...attemptIdentityFrom(originalTask),
          reviewerRetryPrNumber: prNumber,
          reviewerRetryHeadSha: headSha,
          context: {
            iteration: currentIteration + 1,
            maxIterations,
            // baseBranch is the DECLARED base resolveWorktreeBase() falls back to when
            // resumeBranch (workerBranch, below) turns out to be gone from the remote —
            // e.g. the PR merged and its branch got deleted between review and retry
            // claim. Using the PR's actual base (mission integration branch, or trunk)
            // here, not workerBranch again, is what makes that fallback meaningful: two
            // identical values collapse the cascade back to workerBranch, which is
            // already known missing, and resolveWorktreeBase gives up and cuts the
            // worktree from trunk instead — silently dropping the mission's prior work.
            baseBranch: gatedWorker?.prBaseRef ?? workerBranch,
            resumeBranch: workerBranch, // MUST continue on same branch — no new branch

            ...(reviewerLastCommitSha ? { lastCommitSha: reviewerLastCommitSha } : {}),
            failureContext: {
              summary: output.feedback ?? output.summary ?? 'Reviewer requested changes',
              errorType: 'reviewer_request_changes',
              ...(reviewerLastCommitSha ? { commitSha: reviewerLastCommitSha } : {}),
            },
            prNumber,
            prUrl,
            workerBranch,
            ...lineageStamp(originalTask, [prNumber]),
          },
          pathManifest: originalTask.pathManifest,
          release: 'false',
          priority: 8,
          status: 'pending',
          creationSource: 'webhook',
        })
        .onConflictDoNothing()
        .returning();

      if (!retryTask) {
        // Duplicate — another reviewer completion on the same headSha already dispatched.
        console.log(`[reviewer] Duplicate suppressed: fix task already exists for PR #${prNumber}@${headSha.slice(0, 7)}`);
        return;
      }

      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId),
      });
      // A newer round or an approve can land between the check above and the
      // insert, and the approve's own reconcile may have found nothing to
      // cancel yet. Re-run the guard against the inserted row; it cancels only
      // this row (through the same CAS and ledger), so a newer round's fix is
      // kept.
      if (await guardDispatchedTask(fixProposal, retryTask.id, verdictEvent)) return;
      // Approval may have cancelled the row while we read the newest round.
      const liveRetry = await db.query.tasks.findFirst({
        where: eq(tasks.id, retryTask.id), columns: { status: true },
      });
      if (liveRetry?.status !== 'pending') return;

      if (workspace) {
        await announceTaskCreated(retryTask, workspace);
        await wakeTask(retryTask.id, 'review.fix_requested');
        console.log(`[reviewer] Created retry task ${retryTask.id} for PR #${prNumber}@${headSha.slice(0, 7)} (iteration ${currentIteration + 1}/${maxIterations})`);
        // The retry inherited the original's manifest; shrink it (and the
        // finished reviewer's leases) to the PR's actual diff at this head.
        schedulePrScopeReconcile({ workspaceId, installationId, repoFullName, prNumber, expectedHeadSha: headSha });
        await appendPrActivity({
          installationId,
          repoFullName,
          prNumber,
          // Queued, not fixing: the retry task has no worker yet. The claim
          // route writes `fix_started` when one picks it up.
          entry: {
            kind: 'review_changes_requested',
            iteration: currentIteration + 1,
            maxIterations,
            note: output.feedback ?? output.summary ?? null,
            taskUrl: taskActivityUrl(retryTask.id),
            taskTitle: retryTask.title,
          },
          workspaceId,
        });
      }
      break;
    }

    case 'escalate': {
      // BT-9: Escalate path — notify human, no retry
      void notifyTeamOf({ workspaceId }, 'needsAttention', {
        title: `PR #${prNumber} escalated by reviewer`,
        message: serverOverrideReason ?? output.escalationReason ?? output.summary,
        url: prUrl,
        urlTitle: 'View PR',
      });
      await appendPrActivity({
        installationId,
        repoFullName,
        prNumber,
        entry: { kind: 'review_escalated', note: serverOverrideReason ?? output.escalationReason ?? output.summary },
        workspaceId,
      });
      console.log(`[reviewer] Escalated PR #${prNumber}: ${serverOverrideReason ?? output.escalationReason ?? output.summary}`);
      break;
    }
  }
}

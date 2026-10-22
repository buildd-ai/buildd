import { taskEstimatePayload } from '@buildd/core/task-estimate-rollout';
import TaskTimeRow from '@/components/TaskTimeRow';
import { LiveData } from '@/components/LiveRegion';
import { loadTaskLiveRegion } from '@/lib/task-live-region';
import { isDeliverableArtifact } from '@/lib/worker-deliverables';
import { cancellationLine } from '@/lib/task-cancellation';
import { taskRecoverySentence } from '@/lib/task-recovery-hold';
import { ANSWER_IN_CHAT, RUN_PROGRESS_READERS } from '@/modules';
import { Suspense } from 'react';
import { after } from 'next/server';
import { runnerDisplayResolver } from '@/lib/runner-display';
import { compareTasksChrono, compareWorkersChrono, newestFirst, oldestFirst } from '@/lib/attempt-order';
import { loadRunnerHeartbeats } from '@/lib/runner-heartbeats';
import { db } from '@buildd/core/db';
import { tasks, workers, artifacts, workerErrorTraces, releases, taskEstimates } from '@buildd/core/db/schema';
import { readTaskEstimatesSetting } from '@buildd/core/task-estimate-source';
import { isValidTimezone } from '@buildd/core/timezone';
import { buildTimeRow } from '@/lib/task-time-row';
import { eq, desc, inArray, asc, and, isNotNull, sql } from 'drizzle-orm';
import { deriveTaskEyebrow, taskEyebrowText } from '@/lib/task-eyebrow';
import { deriveDisplayStatus, deriveTaskPhase, isSubjectDead, isGateSatisfied, findBlockingPrWorker } from '@/lib/task-presentation';
import { normalizeRepoFullName } from '@/lib/repo-scope';
import { loadTaskViewRecovery, pickTaskView, taskViewReads, TASK_VIEW_UNREAD_WORKER_COLUMNS } from '@/lib/task-view';
import { batchReads } from '@/lib/batch-reads';
import { BYPASS_MISSION_BUDGET_KEY, hasBypassFlag } from '@/lib/bypass-flags';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { parseCredentialBlock, CREDENTIAL_BLOCK_CONTEXT_KEY } from '@/lib/credential-block-copy';
import { displayWorkspaceName, isLiveWorkerStatus, isTerminalTaskStatus, ENTITLEMENT_BLOCK_CONTEXT_KEY, parseEntitlementBlock } from '@buildd/shared';
import { isStorageConfigured, generateDownloadUrl } from '@/lib/storage';
import { isValidTaskId } from '@/lib/task-id';
import { answeredAttemptLine } from '@/lib/answer-resume';
import PlanningNotice from './PlanningNotice';
import LocalTime from '../LocalTime';
import ReassignButton from './ReassignButton';
import EditTaskButton from './EditTaskButton';
import DeleteTaskButton from './DeleteTaskButton';
import RealTimeWorkerView from './RealTimeWorkerView';
import { liveWorkerViewProps, workerSteerProps } from '@/lib/task-live-view';
import PlanReviewPanel from './PlanReviewPanel';
import TaskTimeline from './TaskTimeline';
import { buildTaskTimeline } from '@/lib/task-timeline';
import { projectKernelState } from '@/lib/delivery-projection';

import { getModelDisplayName, primaryModelFromUsage, compareAssignedActual } from '@buildd/core/model-display';
import TaskAutoRefresh from './TaskAutoRefresh';
import { DisplayTimezoneProvider, ZonedTime } from '@/components/DisplayTimezone';
import { blockedHeadline, gateName, lastForceStart } from '@buildd/core/waiting-reason';
import SwitchBackendButton, { type BackendOption } from './SwitchBackendButton';
import TaskQuestionFeed from './TaskQuestionFeed';
import CollapsibleDescription from './CollapsibleDescription';
import { StatusPill } from '@/components/ui/StatePill';
import { displayBranchName } from '@/lib/branch-display';
import { LoopHistory, LoopStatusChip } from '@/components/LoopStatus';
import type { LoopHistoryEntry } from '@buildd/shared';
import TaskArtifactsSection from './TaskArtifactsSection';
import TaskAccessSection from './TaskAccessSection';
import { loadTaskAccess } from '@/lib/agent-capabilities/access-log';
import { VISUAL_AUDITOR_ROLE_SLUG } from '@/lib/mission-visual-review';
import { loadVisualReview } from '@/lib/visual-review-load';
import { visualReviewRoundOf } from '@/lib/visual-review-rounds';
import { toTaskArtifactItem, taskVisibleArtifacts } from './task-artifact-items';
import { observeWorkspaceMergeStateOnRender } from '@/lib/pr-state-refresh';
import { getBackendAvailability, teamEnabledBackends } from '@/lib/backend-failover';
import { backendLabel, failoverCandidates } from '@buildd/core/backend-policy';
import { deriveTaskModel } from '@/lib/model-presentation';
import { resolveShippedRelease } from '@/lib/task-ship-state';
import { deriveTaskOrigin } from '@/lib/task-origin';
import { originLinkCards } from './origin-links';
import { TaskShipBadge } from '@/components/TaskShipBadge';
import { type SpecSourceContext } from '@/components/SpecSourceBlock';
import { livingSpecLoad } from '@/lib/specs/task-view';
import PrDetailsCard from './PrDetailsCard';
import { StoredPrCard } from '@/components/task/StoredPrCard';
import TaskDeliverables, { type TaskDeliverablesResult } from '@/components/task/TaskDeliverables';
import { taskPrFacts, taskHeaderMerged, taskDeliverySections } from '@/lib/task-sections';
import { openAttemptOf, openAttemptQuery } from '@/lib/explain';
import TaskEvidenceCard from './TaskEvidenceCard';
import { plainWorkerError } from '@/lib/provider-auth-failure';
import TaskEvidenceFiles from './TaskEvidenceFiles';
import { listTaskEvidenceObjects, toEvidenceObjectSummary } from '@/lib/evidence-read';
import { evidenceViewOf } from '@/lib/task-evidence';
import { TaskTitle as TaskTitleText } from '@/components/tasks/TaskTitle';
import TaskPageActionZone from './TaskPageActionZone';
import { auditTaskIdFor, loadTaskFailure, taskPageTrouble } from '@/lib/task-failure-kind-load';
import RunnerReachBanner from './RunnerReachBanner';
import { loadServiceStatus } from '@/lib/service-status-loader';
import { ServiceStatusList } from '@/components/service-status/ServiceStatusList';
import { loadRunnerReachDiagnosis } from '@/lib/runner-reach';
import { canAdministerTeamKeys } from '@/lib/key-level-policy';
import TaskOverflowMenu from './TaskOverflowMenu';
import { AskAboutLink } from '@/components/chat/ChatEntry';
import { truncateExcerpt } from './error-excerpt';
import { descriptionDuplicatesSummary } from './execution-plan';
import { missionTaskHref, parseMissionOriginParams, taskPageHref } from '@/lib/mission-task-href';
import WorkerSteerPanel from './WorkerSteerPanel';
import { HeaderStatusPill, deliveryPillLabel, FactSheet, SideDescription, runnerFactRow, branchFactRow, type FactRow } from './TaskSidePanel';
import { findTaskRole } from './role-lookup';
import { headerLifecycle, taskHeading } from './task-header';
import TaskChecksSection from '@/components/task/TaskChecksSection';
import TaskSubjectLink from './TaskSubjectLink';
import TaskTitle from './TaskTitle';
import { taskSubjectOf } from '@/lib/task-checks';
import { loadTaskDeliveryContext } from '@/lib/task-delivery-context';
import { prLifecycleFor } from '@/lib/delivery-overlay';
import { normaliseReviewVerdict, readableTaskResult } from '@/lib/task-result';
import Lifecycle from '@/components/ui/Lifecycle';
import { displayTaskTitle } from '@/lib/task-title';
import { buildLineage, diffStatsRecorded } from './pr-lineage';
import { lineageDisplayStatus, lineageWorkerHistory } from './lineage-status';
import type { PrOutcome } from '@/components/task/PrCard';
import { buildHeroPool, pickHeroShots } from '@/lib/mission-shipped';
import { toVisualShots } from '@/lib/mission-visual-review';
import { parseTaskShippedRecord } from '@/lib/task-shipped';
import { buildTaskShippedView } from './task-shipped-header';
import { TaskShippedTitle, type RunDetail } from './TaskShippedHeader';
import { taskHostedRunnerUsage } from '@/lib/hosted-runner-usage-store';
import { taskRunnerLine } from '@/lib/hosted-runner-usage';
import { TaskShippedDetails } from './TaskShippedHeader';
import { formatElapsed } from './format-elapsed';
import TaskVerdictBlock from './TaskVerdictBlock';
import EscalationDecision from '@/components/EscalationDecision';
import { decisionActionHref, decisionCopy } from '@/lib/workflow/escalation-copy';
import TaskErrorEvidence from './TaskErrorEvidence';
import { buildErrorEvidenceItems } from './error-evidence';
import { nonDiffActions } from './attempt-actions';
import { groupAttemptHistory, isBookkeepingAttempt } from './bookkeeping-attempt';
import BookkeepingAttemptRow from './BookkeepingAttemptRow';
import { applyVerdictDecision, deriveTaskVerdict, parseStoredVerdictDecision, verdictLinksPr, verdictRepeatsOpenQuestion } from '@/lib/task-verdict';
import { buildVerdictInput, traceOutcomeOf } from '@/lib/task-verdict-facts';
import { priorAttemptFactsOf, resolveTraceConsequences } from '@/lib/trace-consequence';
import type { WorkerMilestone } from '@buildd/core/db/schema';
import StartTimeControl from '@/components/StartTimeControl';
import Notice from '@/components/ui/Notice';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { statusPill } from '@/components/ui/states';
import DiagnosticsDisclosure, { DiagnosticsAudienceProvider } from '@/components/ui/DiagnosticsDisclosure';
import { canSeeDiagnostics } from '@/lib/diagnostics-audience';
import { isPlatformOperator } from '@/lib/platform-operator';
import { taskPrOf, withTaskPr } from '@/lib/workflow/task-pr';
import { withPageBudget } from '@/lib/page-budget-watch';

// Exit causes that get their own badge instead of a bare "Failed" — each one
// tells the operator where to look (budget, infra, over-claim, dead session).
const BADGED_EXIT_CAUSES = new Set(['budget_limited', 'infra_failure', 'never_started', 'silent_start']);

/** A plan chain row's one fact from `context`: whether its role was inferred. */
const ROLE_INFERRED_EXTRAS = {
  roleInferred: (t: any, _ops?: unknown) => sql<boolean>`(${t.context}->'roleInferred') is not null`.as('role_inferred'),
};


/** Characters of an artifact body the page sends for its card; the viewer loads the rest on open. */
const ARTIFACT_PREVIEW_CHARS = 600;
/** A summary artifact read whole, to tell whether it only repeats the result's summary. */
const SUMMARY_WHOLE_MAX_CHARS = 8000;

/** The task's mission executor, for the action zone's `claim_task` hint. */
function missionExecutorOf(row: { executor?: string | null } | null | undefined): 'runner' | 'local' | null {
  return row?.executor === 'local' ? 'local' : row?.executor === 'runner' ? 'runner' : null;
}

async function TaskDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ artifact?: string; respond?: string; from?: string; initiativeId?: string }>;
}) {
  const [{ id }, { artifact: initialOpenArtifactId, respond, from, initiativeId }] = await Promise.all([params, searchParams]);
  // Where the mission was opened from: the back link returns there (spec d25d923d AC-2).
  const missionBack = parseMissionOriginParams({ from, initiativeId });
  // `?respond=1`: an answer link. The reply box below gets focus.
  const focusAnswer = respond === '1';
  if (!isValidTaskId(id)) notFound();
  const isDev = process.env.NODE_ENV === 'development' && (!process.env.DATABASE_URL || !process.env.DEV_USER_EMAIL); // placeholder unless dev has a DB + dev user
  const user = await getCurrentUser();

  if (isDev) {
    return (
      <div className="p-8">
        <div className="max-w-4xl">
          <p className="text-text-secondary">Development mode - no database</p>
        </div>
      </div>
    );
  }

  if (!user) {
    redirect('/app/auth/signin');
  }

  // Get task with workspace (for ownership check) and relationships
  const task = await db.query.tasks.findFirst({
    where: sqlWhere(eq(tasks.id, id)),
    with: {
      // The workspace fields the page reads, not its memory/projects JSON; its
      // team's zone and estimate switch ride along instead of two more reads.
      workspace: {
        columns: { id: true, teamId: true, name: true, repo: true, accessMode: true, dataClass: true, gitConfig: true },
        with: { team: { columns: { timezone: true, taskEstimates: true } } },
      },
      // Explicit allowlist, like every sibling relation in this shape: the two
      // fields the page reads off an account rather than the whole row.
      account: { columns: { name: true } },
      mission: {
        columns: { id: true, title: true, status: true, executor: true, requiresReview: true, mergePolicy: true, workingBranch: true, integrationBranchEnabled: true },
        with: { initiative: { columns: { id: true, title: true } } },
      },
      parentTask: { columns: { id: true, title: true, status: true, roleSlug: true, taskClass: true, mode: true, parentTaskId: true }, extras: ROLE_INFERRED_EXTRAS },
      // taskClass/mode/title tell a subtask from an attempt at this task (D9).
      // roleSlug/roleInferred: a parent's plan chain is its subtasks, read here once.
      subTasks: { columns: { id: true, title: true, status: true, taskClass: true, mode: true, parentTaskId: true, createdAt: true, roleSlug: true }, extras: ROLE_INFERRED_EXTRAS, orderBy: sqlOrderBy([asc(tasks.createdAt), asc(tasks.id)]) },
      // Provenance (U6): who created this task and by what mechanism. The
      // creating worker has no page of its own, so we carry its task instead.
      creatorAccount: { columns: { id: true, name: true } },
      creatorWorker: {
        columns: { id: true, name: true },
        with: { task: { columns: { id: true, roleSlug: true, title: true } } },
      },
      schedule: { columns: { id: true, name: true } },
    },
  });

  if (!task) {
    notFound();
  }

  // Verify access through team membership
  const access = await verifyWorkspaceAccess(user.id, task.workspaceId);
  if (!access) {
    notFound();
  }
  // Layer-3 diagnostics (gate codes, runner scheduling, overrides, exact
  // timings): team admins of this task's team and platform operators only.
  const diagnosticsVisible = canSeeDiagnostics({ role: access.role, operator: isPlatformOperator(user) });

  // Everything below needs nothing but the task row and the access check
  // above, and nothing each other produces. The reads that are ours to batch
  // (the task's workers and open questions, its dependencies, the mission
  // context and the estimate) go in one round trip; the rest run beside it.
  // The access gate deliberately stays *ahead* of the group rather than
  // joining it: this is an authorization path, and reading a task's workers
  // for a viewer who turns out not to have access is not a trade worth two
  // round trips.
  const depTaskIds = (task.dependsOn as string[] | undefined) || [];
  const viewer = { userId: user.id, teamId: (task.workspace as { teamId?: string } | null)?.teamId ?? null };
  // Dependency tasks, if dependsOn has entries
  const depQuery = depTaskIds.length > 0
    ? db.query.tasks.findMany({
        where: sqlWhere(inArray(tasks.id, depTaskIds)),
        columns: { id: true, title: true, status: true, result: true },
        with: {
          workers: {
            columns: { status: true, prUrl: true, prNumber: true, mergedAt: true, prLifecycleStatus: true },
            // Every worker, newest first — NOT limit 1. The gate asks whether
            // ANY worker holds an open PR, the same read the list and the
            // claim route make; the newest alone hid an older open PR.
            orderBy: sqlOrderBy([desc(workers.createdAt), desc(workers.id)]),
          },
        },
        })
    : null;
  // The frozen estimate, only for a team that has the switch on (read with the task).
  const estimateQuery = task.workspace?.team && readTaskEstimatesSetting(task.workspace.team.taskEstimates)
    ? db.query.taskEstimates.findFirst({
        where: sqlWhere(eq(taskEstimates.taskId, id)),
        orderBy: sqlOrderBy(desc(taskEstimates.createdAt)),
      })
    : null;
  // The task's workers and open question notes, as the sheet reads them (lib/task-view.ts).
  const [viewWorkersQuery, viewQuestionsQuery] = taskViewReads(task.id);
  const [round1, recovery, answerInChat, taskPr] = await Promise.all([
    batchReads([viewWorkersQuery, viewQuestionsQuery, depQuery, estimateQuery]),
    loadTaskViewRecovery(task, viewer),
    // An answer link for a mission filed from the reader's own conversation
    // opens that conversation instead, when chat is on for them.
    focusAnswer && task.missionId ? ANSWER_IN_CHAT(id, user.id).catch(() => null) : Promise.resolve(null),
    // The task's PR, derived on read (workflow/task-pr.ts), for the Deliverables block.
    taskPrOf(task.id),
  ]);
  const depTasks = (round1(depQuery) ?? []) as Awaited<NonNullable<typeof depQuery>>;
  const taskEstimate = (round1(estimateQuery) ?? null) as Awaited<NonNullable<typeof estimateQuery>> | null;
  // One worker and one question, picked the way the sheet picks them: the same
  // on both surfaces. A mission task's questions carry its missionId too; they
  // are still this task's, so no mission gate (S6).
  const taskView = pickTaskView({
    task,
    workers: (round1(viewWorkersQuery) ?? []) as Awaited<typeof viewWorkersQuery>,
    openQuestions: (round1(viewQuestionsQuery) ?? []) as Awaited<typeof viewQuestionsQuery>,
    recovery,
  });
  if (answerInChat) redirect(answerInChat);
  // Newest first by (createdAt, id).
  const taskWorkers = taskView.ordered;
  const failedExcerpt = truncateExcerpt(taskWorkers[0]?.error);
  const taskBackend = (task.backend as 'claude' | 'codex' | null) ?? null;
  // Read-through PR fact import: if the latest worker is completed with an
  // open PR, check GitHub in case the merged webhook was missed. Enqueued after
  // the response, never written during the render (spec workflow-state-kernel
  // §11): this render shows what is stored, the next one what the import found.
  if (task.status === 'completed' && task.workspaceId) {
    const latestWorker = taskWorkers[0];
    if (latestWorker?.prNumber && !latestWorker?.mergedAt && latestWorker?.prUrl) {
      // AC-3: a delivery-owned task records at most a fact here; no lifecycle write.
      const stale = { id: latestWorker.id, prNumber: latestWorker.prNumber, prUrl: latestWorker.prUrl, workspaceId: latestWorker.workspaceId ?? task.workspaceId };
      // The installation is read after the response too: the render reads nothing for this.
      after(() => observeWorkspaceMergeStateOnRender([stale], task.workspaceId).catch((err) =>
        console.error('[task-page] PR fact import failed (non-fatal):', err)));
    }
  }

  // Artifacts, error traces and ship state are mutually independent — one wait
  // instead of three. The release *label* genuinely follows the ship-state
  // resolver (it needs the release id it returns), so it stays chained inside
  // that entry rather than becoming a fourth serial step.
  const workerIds = taskWorkers.map(w => w.id);
  const prWorker = taskView.prWorker ?? null;
  // Stored evidence objects (pointers only; the text is read on demand by the
  // section). Best-effort: a failed lookup shows the empty list, never an error page.
  const evidenceFilesPromise = listTaskEvidenceObjects({ id: task.id, workspaceId: task.workspaceId })
    .then(rows => rows.map(toEvidenceObjectSummary))
    .catch((err) => {
      console.error('[task-page] evidence list failed:', err instanceof Error ? err.message : err);
      return [];
    });
  // Why no runner can claim a pending task: a restricted workspace its
  // runners are not linked to (a new user's "My Workspace" before the login
  // fix). Runner work only; a local mission's task is claimed from a session.
  // Shown only when the task can start (filtered below, once deps are known).
  const runnerReachLoad = task.status === 'pending' && missionExecutorOf(task.mission) !== 'local' && task.workspace
    ? loadRunnerReachDiagnosis({
        id: task.workspace.id,
        teamId: task.workspace.teamId,
        accessMode: task.workspace.accessMode,
      })
        .then((diagnosis) => diagnosis ? { diagnosis, canFix: canAdministerTeamKeys(access.role) } : null)
        .catch(() => null)
    : Promise.resolve(null);
  // Cloud runs only: its time on the hosted runner, all attempts. Started
  // here, awaited below, so it adds no round trip of its own.
  const hostedRunnerUsagePromise = taskHostedRunnerUsage(id).catch(() => null);
  // The team's service status for this viewer, kept to the causes this task
  // waits on. A finished task waits on nothing, so it reads none. Never throws.
  const serviceStatusPromise = isTerminalTaskStatus(task.status)
    ? Promise.resolve([] as Awaited<ReturnType<typeof loadServiceStatus>>['statuses'])
    : loadServiceStatus({ userId: user?.id, teamId: (task.workspace as { teamId?: string } | null)?.teamId })
      .then((v) => v.statuses.filter((s) => s.work.some((w) => w.taskId === task.id)));
  // Artifacts for all workers on this task, each body cut to the card's
  // preview (a summary read whole when short, for the duplicate check).
  const artifactsQuery = workerIds.length > 0
    ? db.select({
        id: artifacts.id, workerId: artifacts.workerId, type: artifacts.type, title: artifacts.title,
        storageKey: artifacts.storageKey, shareToken: artifacts.shareToken, visibility: artifacts.visibility,
        metadata: artifacts.metadata, key: artifacts.key, createdAt: artifacts.createdAt,
        content: sql<string | null>`case when ${artifacts.type} = 'summary' and length(${artifacts.content}) <= ${SUMMARY_WHOLE_MAX_CHARS}
          then ${artifacts.content} else left(${artifacts.content}, ${ARTIFACT_PREVIEW_CHARS}) end`,
        contentLength: sql<number | null>`length(${artifacts.content})`.mapWith(Number),
      }).from(artifacts).where(inArray(artifacts.workerId, workerIds))
    : null;
  // Agent error traces (pattern-matched failures from tool output).
  // Captured by the runner's error-trace-scanner — see apps/runner/src/error-trace-scanner.ts.
  // Cap to most recent 50 here; full list available via /api/tasks/[id]/error-traces.
  const errorTracesQuery = db.query.workerErrorTraces.findMany({
    where: sqlWhere(eq(workerErrorTraces.taskId, id)),
    orderBy: sqlOrderBy([desc(workerErrorTraces.ts)]),
    limit: 50,
  });
  // CI-retry attempts at this task's PR: each is a fresh worker handed the
  // failure excerpt, on the same branch. They make "How it landed".
  const ciAttemptsQuery = prWorker?.prNumber
    ? db.query.tasks.findMany({
        where: sqlWhere(and(eq(tasks.parentTaskId, id), eq(tasks.ciRetryPrNumber, prWorker.prNumber), isNotNull(tasks.ciRetryHeadSha))),
        columns: { id: true, title: true, status: true, createdAt: true, ciRetryHeadSha: true, result: true },
        // The one context fact the lineage reads: the failure it was handed.
        extras: { context: (t: any, _ops?: unknown) => sql<Record<string, unknown> | null>`jsonb_build_object('failureContext', ${t.context}->'failureContext')`.as('attempt_context') },
        with: {
          // The rows taskWorkers carry, for Worker history, less what only the
          // live worker's steer panel reads: an attempt's worker is never this
          // task's active one.
          workers: {
            columns: { ...TASK_VIEW_UNREAD_WORKER_COLUMNS, instructionHistory: false, pendingInstructions: false, observedTouches: false },
            orderBy: sqlOrderBy([desc(workers.createdAt), desc(workers.id)]),
            with: { account: { columns: { name: true } } },
          },
        },
        orderBy: sqlOrderBy([asc(tasks.createdAt), asc(tasks.id)]),
      })
    : null;
  // What this task unblocks, once it has landed.
  const dependentsQuery = db.query.tasks.findMany({
        where: sqlWhere(and(eq(tasks.workspaceId, task.workspaceId), sql`${tasks.dependsOn} @> ${JSON.stringify([id])}::jsonb`)),
        columns: { id: true, title: true, label: true, status: true },
      });
  // The canonical "is a fix attempt open on this task" fact — same
  // predicate explain.ts and Home's action queue use (mission-state-view.ts
  // rule 6½). Only while the task's PR is open.
  const openAttemptRead = prWorker?.prUrl && prWorker.prNumber && prWorker.prLifecycleStatus !== 'closed'
    ? openAttemptQuery(task.id)
    : null;
  // Those five in one round trip.
  const round2 = batchReads([artifactsQuery, errorTracesQuery, ciAttemptsQuery, dependentsQuery, openAttemptRead]);
  // The delivery this task belongs to, started with round 2: the review status
  // below reads the same view when this task owns the PR, so it is read once.
  const deliveryContextPromise = loadTaskDeliveryContext(task.id, user.id);
  deliveryContextPromise.catch(() => {});
  const [evidenceReview, reads2, ship, teamTimezone, roleRow, runnerHeartbeats, auditVisual, evidenceFiles, runnerReachRaw, accessItems, failureRaw, livingSpec, taskServiceStatus] = await Promise.all([
    prWorker?.prNumber
      ? RUN_PROGRESS_READERS.review({
          workspaceId: task.workspaceId, prNumber: prWorker.prNumber,
          knownDelivery: { taskId: task.id, view: deliveryContextPromise.then((c) => c.view) },
        }).catch(() => null)
      : Promise.resolve(null),
    round2,
    (async () => {
      // Ship state (§10.3) — whether this task is attributed to a healthy release.
      const shippedRelease = await resolveShippedRelease(task.id);
      // The `Shipped in <release>` line (U7) needs a name for the release the
      // shared resolver identified. Read it by id — the release_tasks
      // attribution join stays in resolveShippedRelease so no surface
      // re-derives it.
      let label: string | null = null;
      if (shippedRelease) {
        const [rel] = await db
          .select({ version: releases.version, unit: releases.unit, headSha: releases.headSha })
          .from(releases)
          .where(eq(releases.id, shippedRelease.releaseId))
          .limit(1);
        label = rel?.version ?? rel?.unit ?? (rel?.headSha ? rel.headSha.slice(0, 7) : null);
      }
      return { shippedRelease, label };
    })(),
    // Stamps on this page render in the task's own team zone (the same zone
    // its PR activity comment uses), not the layout's current-team zone.
    // Null → the viewer's browser zone; never the server's UTC. Never throws.
    isValidTimezone(task.workspace?.team?.timezone) ? task.workspace!.team!.timezone : null,
    // Role name/colour come from the workspace's role row, never a local map.
    findTaskRole({ workspaceId: task.workspaceId, teamId: (task.workspace as any)?.teamId, slug: task.roleSlug }),
    // Heartbeats of this task's runner accounts: names its runners (and its
    // CI retries' sibling runners) by hostname.
    loadRunnerHeartbeats(taskWorkers),
    // A visual-audit task shows its round's screens from the mission's review
    // model (docs/design/visual-qa-human-review.md), not a mixed-attempt grid.
    task.roleSlug === VISUAL_AUDITOR_ROLE_SLUG && task.missionId
      ? loadVisualReview({ id: task.missionId, workspaceId: task.workspaceId ?? null })
          .then((model) => {
            const round = visualReviewRoundOf(model, task.id);
            return round != null ? { round, model } : null;
          })
          .catch(() => null)
      : Promise.resolve(null),
    evidenceFilesPromise,
    runnerReachLoad,
    // What this task's runs were given and refused (agent_capability_decisions).
    // A read failure hides the section; it never fails the page.
    loadTaskAccess(id).catch(() => []),
    // Worker vs verification failure. Costs no query unless the task failed;
    // joined here rather than awaited after the phase is derived.
    loadTaskFailure({ id: task.id, title: task.title, status: task.status, missionId: task.missionId ?? null }).catch(() => null),
    // The Living Spec the task is pinned to, with its outcome. No query unless it names one.
    livingSpecLoad(task.id, task.context),
    serviceStatusPromise,
  ]);
  const taskArtifacts = (reads2(artifactsQuery) ?? []) as Awaited<NonNullable<typeof artifactsQuery>>;
  // The live worker's deliverables, counted from the rows above: no read of its own.
  const liveWorkerId = taskWorkers.find(w => isLiveWorkerStatus(w.status))?.id;
  const evidenceArtifactCount = liveWorkerId
    ? taskArtifacts.filter(a => a.workerId === liveWorkerId && isDeliverableArtifact(a)).length
    : 0;
  const errorTraces = reads2(errorTracesQuery) as Awaited<typeof errorTracesQuery>;
  const ciAttemptRows = (reads2(ciAttemptsQuery) ?? []) as Awaited<NonNullable<typeof ciAttemptsQuery>>;
  const dependentTasks = (reads2(dependentsQuery) ?? []) as Awaited<NonNullable<typeof dependentsQuery>>;
  const openAttempt = openAttemptRead
    ? openAttemptOf(reads2(openAttemptRead) as Awaited<NonNullable<typeof openAttemptRead>>)
    : null;
  // CI-retry attempts numbered by (createdAt, id): "attempt N" never swaps.
  const ciAttemptTasks = oldestFirst(ciAttemptRows, compareTasksChrono)
    .map(t => ({ ...t, workers: newestFirst(t.workers, compareWorkersChrono) }));
  const shippedRelease = ship.shippedRelease;
  // Runners by hostname, never their raw URL (runner-display).
  const runnerName = runnerDisplayResolver(runnerHeartbeats);
  const runnerLabel = (w: { runner?: string | null; localUiUrl?: string | null; accountId?: string | null }) => runnerName(w)?.name ?? null;
  const shippedReleaseLabel = ship.label;

  // Origin (U6, Problem §4) — provenance from stored columns only, no title parsing.
  // "You" is claimed only when the creating account is named after the viewer;
  // dashboard creations record a team account, not a user identity, so a name
  // match is the strongest honest signal available.
  const viewerNames = [user.name, user.email, user.email?.split('@')[0]]
    .filter((n): n is string => !!n)
    .map(n => n.toLowerCase());
  const creatorAccountName = task.creatorAccount?.name ?? null;
  const origin = deriveTaskOrigin(task, {
    actorName: creatorAccountName ?? task.creatorWorker?.name ?? null,
    isSelf: !!creatorAccountName && viewerNames.includes(creatorAccountName.toLowerCase()),
    creatorRoleSlug: task.creatorWorker?.task?.roleSlug ?? null,
    creatorWorkerTaskId: task.creatorWorker?.task?.id ?? null,
    creatorWorkerTaskTitle: task.creatorWorker?.task?.title ?? null,
    scheduleName: task.schedule?.name ?? null,
    missionTitle: task.mission?.title ?? null,
    parentTaskTitle: task.parentTask?.title ?? null,
    repoFullName: task.workspace?.repo
      ? normalizeRepoFullName(task.workspace.repo)
      : null,
    shippedRelease: shippedRelease
      ? { releaseId: shippedRelease.releaseId, label: shippedReleaseLabel }
      : null,
  });

  // Spec traceability (docs/design/spec-to-build-pattern.md §3) — which spec
  // authorized this task: the repo doc approvePlan writes onto every child of
  // an emitsPlan-originated plan, and/or the Living Spec revision the server
  // pinned it to when it was filed (lib/specs/pin.ts). Absent on ordinary tasks.
  const specSourceRaw = (task.context as Record<string, unknown> | null)?.specSource as
    | Partial<SpecSourceContext>
    | undefined;
  const specSource: SpecSourceContext | null = specSourceRaw && typeof specSourceRaw === 'object'
    ? {
        ...(typeof specSourceRaw.specPath === 'string' ? { specPath: specSourceRaw.specPath } : {}),
        ...(typeof specSourceRaw.planningTaskId === 'string' ? { planningTaskId: specSourceRaw.planningTaskId } : {}),
        ...(typeof specSourceRaw.specId === 'string' ? { specId: specSourceRaw.specId } : {}),
        ...(typeof specSourceRaw.revision === 'number' ? { revision: specSourceRaw.revision } : {}),
        ...(typeof specSourceRaw.contentHash === 'string' ? { contentHash: specSourceRaw.contentHash } : {}),
      }
    : null;

  // The artifacts list, as the sheet gets it: never the plan, and not a lone
  // summary artifact that repeats result.summary (it shows as the summary).
  const resultSummary = (task.result as any)?.summary as string | undefined;
  const { visible: visibleArtifacts, suppressedSummary: suppressedSummaryArtifact } = taskVisibleArtifacts(taskArtifacts, task);
  // D9: when the description is the deliverable summary itself, the summary
  // (under Deliverables) is printed once and the description is not.
  const descriptionIsSummary = descriptionDuplicatesSummary(task.description, resultSummary);

  // D9: this task's children split into genuine subtasks and attempts at it
  // (reviewer passes, retries) — the latter are never listed as subtasks.

  // The live worker, with its question dropped once the task ended or a failure
  // incident's recovery owns the next step (failure-incident-recovery §16.4, §17.2):
  // a question about the same failure is stale then; history keeps it.
  const taskRecovery = taskView.recovery;
  const activeWorker = taskView.activeWorker;
  const openQuestionCount = taskView.openQuestionCount;

  // A kernel-owned delivery's header reads the kernel's DeliveryView, not the
  // raw task/worker columns below (workflow-state-kernel §17.5). Legacy-owned
  // or PR-less tasks get null and keep today's status.
  // The same load carries the review rounds' findings and the deliverable's
  // title for the page's checks list and attempt framing (docs/specs/task-page.md).
  const deliveryContext = await deliveryContextPromise;
  const deliveryView = deliveryContext.view;
  // §7 (workflow-kernel-library.md): the PR's merged/open/closed reading is the
  // delivery's when it owns this PR, never a worker row that disagrees (AC-26).
  const prLife = prLifecycleFor(prWorker, deliveryView, task.id);
  const latestLife = taskWorkers[0] && prWorker && taskWorkers[0].id === prWorker.id ? prLife : taskWorkers[0];
  // Which run this page is: the deliverable, or a review / fix attempt of it.
  const subject = taskSubjectOf({
    taskId: task.id,
    view: deliveryView,
    context: task.context,
    parentTaskId: task.parentTaskId,
    retryOf: task.reviewerRetryPrNumber != null || task.ciRetryPrNumber != null || task.conflictRetryPrNumber != null,
  });
  const ownResult = (task.result ?? null) as { summary?: unknown; structuredOutput?: unknown; effectiveVerdict?: unknown } | null;
  const reviewOutcome = subject.kind === 'review'
    ? { verdict: normaliseReviewVerdict(ownResult?.effectiveVerdict) ?? readableTaskResult(ownResult?.summary, ownResult?.structuredOutput).verdict }
    : null;
  const deliverableLink = subject.kind === 'deliverable' ? null : {
    taskId: subject.deliverableTaskId,
    title: deliveryContext.deliverableTitle ?? (task.parentTask?.id === subject.deliverableTaskId ? task.parentTask.title : null),
  };
  // The header's delivery reading and the checks list, as the sheet gets them.
  const { delivery: deliveryPill, checks: checksSection } = taskDeliverySections(deliveryContext, prWorker);

  // Derive canonical display status from task + active worker state.
  // If the worker is running, the chip shows "Running" not "Assigned".
  const isTerminal = isTerminalTaskStatus(task.status);
  const baseDisplayStatus = isTerminal
    ? task.status
    : deriveDisplayStatus(task.status, activeWorker?.status);
  // The subject-liveness claim gate (api/workers/claim/subject-gate.ts) excludes
  // this task from every claim query, so it can never run — it must not render
  // as a healthy "Pending" row. Only binding anchors (source ∈ system|context)
  // count; a PR number scraped from the description does not.
  const subjectDead = !isTerminal && isSubjectDead({
    subjectKind: task.subjectKind,
    subjectPrNumber: task.subjectPrNumber,
    subjectResolution: task.subjectResolution,
    subjectAnchor: task.subjectAnchor,
    context: task.context as Record<string, unknown> | null,
  });

  // Override to "Waiting on you" when a non-mission task has open question notes
  const ownDisplayStatus = openQuestionCount > 0 && !isTerminal
    ? 'waiting_on_you'
    : subjectDead && !activeWorker
      ? 'subject_dead'
      : baseDisplayStatus;
  // The lineage decides: a completed task whose PR a CI-fix attempt is still
  // working reads "Fixing CI", not "Completed".
  const displayStatus = lineageDisplayStatus({
    displayStatus: ownDisplayStatus,
    taskStatus: task.status,
    prMerged: !!(prWorker && (prLife.mergedAt || prLife.prLifecycleStatus === 'merged')),
    prClosed: prLife.prLifecycleStatus === 'closed',
    attemptStatuses: ciAttemptTasks.map(t => t.status),
  });

  const initiative = task.mission?.initiative ?? null;

  // One plain line for why a task was cancelled, or what a held task waits on
  // (failure-incident-recovery §18.5/§18.6): the same sentence explain gives.
  const recoveryLine = task.status === 'cancelled'
    ? cancellationLine(task.context)
    : task.status === 'pending'
      ? taskRecoverySentence(task.context, iso => `${iso.slice(11, 16)} UTC`)
      : null;


  // Parse attachments from context — resolve R2 storage keys to presigned URLs
  const rawAttachments = (task.context as any)?.attachments as Array<{
    filename: string;
    mimeType: string;
    data?: string;
    storageKey?: string;
  }> | undefined;

  let attachments: Array<{ filename: string; mimeType: string; src: string }> | undefined;
  if (rawAttachments && rawAttachments.length > 0) {
    const storageReady = isStorageConfigured();
    attachments = await Promise.all(
      rawAttachments.map(async (att) => {
        if (att.storageKey && storageReady) {
          const url = await generateDownloadUrl(att.storageKey);
          return { filename: att.filename, mimeType: att.mimeType, src: url };
        }
        // Legacy inline base64
        return { filename: att.filename, mimeType: att.mimeType, src: att.data || '' };
      })
    );
  }

  // Most recent worker that created a PR — surfaced prominently in the header
  const workerWithPr = prWorker;

  // Whether the latest worker has an open PR — keeps Pusher subscription alive for
  // completed tasks until CI resolves (prevents stale badge after task finishes).
  const workerHasOpenPr = !!(
    taskWorkers[0]?.prNumber &&
    !latestLife?.mergedAt &&
    latestLife?.prLifecycleStatus !== 'closed'
  );

  // Dependency resolution checks — via the SHARED gate predicate, not a local
  // copy. The local copy treated any dep that was not `completed` as
  // unresolved, so a CANCELLED dep rendered as a blocker and suppressed the
  // Start button, while the claim route treats `cancelled` as satisfied
  // (lib/dep-gate-contract.ts). Cancelled deps are now common: the subject
  // sweep cancels tasks whose subject PR died.
  const unresolvedDeps = depTasks.filter(
    d => !isGateSatisfied(d, ((d as any).workers ?? []) as Parameters<typeof isGateSatisfied>[1]),
  );
  const isBlocked = task.status === 'pending' && unresolvedDeps.length > 0;
  const isBudgetPaused = task.status === 'pending' && !!(task.context as any)?.budgetExhausted;
  // The claim loop skips every task whose mission is `budget_exhausted`
  // (mission gate #1 in api/workers/claim/route.ts) and nothing clears that
  // status except a human raising the mission budget. Force-started tasks carry
  // the bypass flag and are claimable again, so they must not show the banner.
  const missionBudgetExhausted =
    !isTerminal
    && task.mission?.status === 'budget_exhausted'
    && !hasBypassFlag(task.context as Record<string, unknown> | null, BYPASS_MISSION_BUDGET_KEY);
  const budgetBackendLabel = backendLabel(task.backend);
  const budgetResetsAtIso = (task.context as any)?.budgetResetsAt as string | undefined;

  // Provider switch offered on the pause banner: which OTHER backend could take
  // this task right now. Same availability data the automatic failover uses, so
  // the button never promises a provider the claim route would refuse.
  let switchOptions: BackendOption[] = [];
  if (isBudgetPaused) {
    const teamId = (task.workspace as any)?.teamId as string | undefined;
    const scope = {
      teamId,
      // The account whose credentials last ran this task — its Claude session
      // flag is part of "is Claude walled right now".
      accountId: taskWorkers[0]?.accountId ?? null,
      workspaceId: task.workspaceId,
      tenantId: ((task.context as any)?.tenantContext as { tenantId?: string } | undefined)?.tenantId,
    };
    const [availability, enabled] = await Promise.all([
      getBackendAvailability(scope),
      teamEnabledBackends(teamId),
    ]);
    const candidates = new Set(failoverCandidates(task.backend as any, enabled));
    switchOptions = availability
      .filter(a => candidates.has(a.backend))
      .map((a) => {
        const paused = a.pausedUntil && a.pausedUntil > new Date() ? a.pausedUntil : null;
        return {
          backend: a.backend,
          label: backendLabel(a.backend),
          available: a.configured && !paused,
          pausedUntil: paused?.toISOString() ?? null,
          blockedReason: !a.configured
            ? 'no credential configured'
            : paused
              ? `rate-limited until ${paused.toISOString().slice(11, 16)} UTC`
              : undefined,
          ...(!a.configured ? { addKeyHref: '/app/settings/models#keys' } : {}),
        } satisfies BackendOption;
      });
  }

  const canReassign = task.status !== 'completed' && task.status !== 'pending';
  const canStart = task.status === 'pending' && !isBlocked;
  const runnerReach = canStart ? runnerReachRaw : null;

  // Canonical lifecycle phase — the single spine the whole page (and the mission
  // drawer, via the same fn) keys off to decide what to foreground.
  const phase = deriveTaskPhase({
    taskStatus: task.status,
    taskMode: task.mode,
    workerStatus: activeWorker?.status,
    workerWaitingFor: activeWorker?.waitingFor,
    isBlocked,
    isBudgetPaused,
    isSubjectDead: subjectDead,
    isMissionBudgetExhausted: missionBudgetExhausted,
  });
  const failureKind = phase === 'failed' ? failureRaw?.kind ?? null : null;
  // Never ran: a task it depends on failed. Its action zone names that task instead of offering a retry (spec 072de598 I-14).
  const failureWaitingOn = failureKind === 'dependency' ? failureRaw?.waitingOn ?? null : null;
  // Who acts next (R-20): waiting on a task, buildd retrying (with its resume
  // time), or a person. A pending task reads its own dependsOn rows, so a
  // blocker that was cancelled or failed surfaces as needing a person.
  const trouble = phase === 'failed' || task.status === 'pending'
    ? taskPageTrouble(
        {
          id: task.id, title: task.title, status: task.status, result: task.result,
          startAt: task.startAt, context: task.context as Record<string, unknown> | null,
          dependsOn: depTaskIds, loopState: task.loopState, taskClass: task.taskClass,
        },
        depTasks,
        phase === 'failed' ? failureRaw ?? null : null,
      )
    : null;
  // Triage metadata (priority / runner / backend) only earns top-level space in
  // the pending family; everywhere else it demotes into the Details disclosure.
  const isPendingFamily = phase === 'pending' || phase === 'blocked' || phase === 'budget_paused' || phase === 'assigned' || phase === 'subject_dead' || phase === 'mission_budget_exhausted';

  // Which model this task was asked for, which one the router resolved, and which
  // one actually ran — three values that are allowed to disagree. The `tasks`
  // query above selects no `columns`, so `tier` and `predictedModel` are both
  // present on the row. `modelUsage` comes from the most recent worker that
  // reported any attribution: on seat/OAuth auth no worker reports one, and that
  // absence must read as unattributed rather than as agreement.
  const attributedWorker = taskWorkers.find(
    w => Object.keys(((w.resultMeta as any)?.modelUsage ?? {}) as Record<string, unknown>).length > 0,
  );
  const modelSummary = deriveTaskModel({
    tier: task.tier,
    predictedModel: task.predictedModel,
    context: task.context,
    modelUsage: (attributedWorker?.resultMeta as any)?.modelUsage ?? null,
  });

  // --- Side panel + outcome data ---
  const roleName = roleRow?.name ?? null;
  const headerTrack = headerLifecycle(deliveryView);
  const heading = taskHeading({ title: task.title, label: (task as { label?: string | null }).label ?? null }, roleName);
  const questionNote = taskView.questionNote;


  let prOutcome: PrOutcome | null = null;
  // Claim to merge, for the status row (the one place a merged PR is stated).
  let lineageClaimToMergeMs: number | null = null;
  if (prWorker) {
    const firstAttempt = {
      runner: runnerLabel(prWorker),
      roleName,
      commits: prWorker.commitCount ?? null,
      add: prWorker.linesAdded ?? 0,
      rem: prWorker.linesRemoved ?? 0,
      files: prWorker.filesChanged ?? 0,
      createdAt: prWorker.createdAt.getTime(),
      startedAt: prWorker.startedAt?.getTime() ?? null,
      completedAt: prWorker.completedAt?.getTime() ?? null,
      headSha: prWorker.lastCommitSha ?? null,
      actions: nonDiffActions(prWorker.milestones as WorkerMilestone[] | null),
    };
    const retried = ciAttemptTasks.filter(t => t.workers.length > 0);
    const retryAttempts = retried.map(t => {
      const w = t.workers[0];
      return {
        runner: runnerLabel(w),
        roleName,
        commits: w.commitCount ?? null,
        add: w.linesAdded ?? 0,
        rem: w.linesRemoved ?? 0,
        files: w.filesChanged ?? 0,
        createdAt: w.createdAt.getTime(),
        startedAt: w.startedAt?.getTime() ?? null,
        completedAt: w.completedAt?.getTime() ?? null,
        headSha: w.lastCommitSha ?? null,
        actions: nonDiffActions(w.milestones as WorkerMilestone[] | null),
      };
    });
    const attempts = [firstAttempt, ...retryAttempts];
    const lineage = buildLineage({
      attempts,
      retries: retried.map(t => ({
        createdAt: t.createdAt.getTime(),
        headSha: t.ciRetryHeadSha ?? null,
        failure: ((t.context as Record<string, unknown> | null)?.failureContext as { job?: string; test?: string; excerpt?: string } | undefined) ?? null,
      })),
      pr: { lifecycle: prLife.prLifecycleStatus, mergedAt: prLife.mergedAt ? new Date(prLife.mergedAt as Date).getTime() : null },
    });
    lineageClaimToMergeMs = lineage.totals.claimToMergeMs;
    prOutcome = {
      repoLabel: task.workspace?.repo ? normalizeRepoFullName(task.workspace.repo) : null,
      summary: ((task.result as { summary?: string } | null)?.summary) ?? null,
      // No attempt recorded its counters: the numbers are unknown, not 0 (a
      // recorded head SHA alone does not count; see diffStatsRecorded).
      totals: { ...lineage.totals, measured: diffStatsRecorded(attempts) },
      attempts: attempts.map((a, i) => ({ add: a.add, rem: a.rem, files: a.files, running: i > 0 && a.completedAt == null, actions: a.actions })),
      lineage: lineage.steps,
      // The retry's own summary is what it did about the failure.
      commits: lineage.commits.map(c => ({
        ...c,
        fix: c.state === 'failed' ? ((retried[c.attempt - 1]?.result as { summary?: string } | null)?.summary ?? null) : null,
        fixEvidence: c.state === 'failed' ? evidenceViewOf(retried[c.attempt - 1]?.result) : null,
      })),
    };
  }

  // --- The verdict (lib/task-verdict.ts) ---
  // One answer to "where does this stand?", from the record. The rules decide
  // the state; a decision cached on the task by the last state change may only
  // reword it (and only for the same state and cause). Nothing here calls the
  // decision model: a page load never does.
  // AC-43 / AC-48: a review escalation's question, why it stopped and the actions open now, one wording for the verdict row and the decision card.
  const escalationCopy = deliveryView?.escalation
    ? decisionCopy(deliveryView.escalation, { rounds: deliveryView.rounds, ledger: deliveryView.ledger ?? [] })
    : null;
  const storedVerdictDecision = parseStoredVerdictDecision((task as { verdictDecision?: unknown }).verdictDecision);
  const rulesVerdict = deriveTaskVerdict({ ...buildVerdictInput({
    task: { status: task.status, mode: task.mode, result: task.result },
    workers: taskWorkers,
    ciAttempts: ciAttemptTasks,
    openAttempt,
    openQuestion: openQuestionCount > 0,
    inRelease: !!shippedRelease,
    // §17.5: a kernel-owned PR's state is the delivery's, not the columns'.
    deliveryPrState: deliveryView?.prState ?? null,
    deliverySupersededBy: deliveryView?.supersededBy ?? null,
  }), review: reviewOutcome,
    waitingOnFailed: failureWaitingOn,
    escalation: escalationCopy && deliveryView?.escalation
      ? {
          title: deliveryView.escalation.title,
          question: escalationCopy.question,
          why: escalationCopy.why,
          unresolved: escalationCopy.unresolved,
          primary: { label: escalationCopy.primary.label, href: decisionActionHref(escalationCopy.primary.id) },
        }
      : null,
    // The platform updating the branch or merging: in progress, not "ready to merge".
    deliveryActivity: deliveryView && ((deliveryView.state === 'REPAIRING' && deliveryView.stateReason === 'behind') || deliveryView.state === 'LANDING') ? deliveryView.headline : null,
    // A merged PR is stated once, on the status row, and the time goes with it.
    claimToMerge: lineageClaimToMergeMs != null ? formatElapsed(lineageClaimToMergeMs) : null });
  const verdict = rulesVerdict ? applyVerdictDecision(rulesVerdict, storedVerdictDecision) : null;
  // The status row names and links the PR: the side panel and the PR card do not say it again.
  const prStatedAbove = verdictLinksPr(verdict, prWorker?.prUrl);
  // What each agent error means for the outcome. Every trace stays inspectable;
  // only the ones the record says still matter are counted or shown in red.
  const traceWorkers = [...taskWorkers, ...ciAttemptTasks.flatMap(t => t.workers)];
  const traceConsequences = resolveTraceConsequences(
    errorTraces,
    traceOutcomeOf(rulesVerdict, task.status, priorAttemptFactsOf(traceWorkers)),
    storedVerdictDecision?.traceClasses,
  );
  const attemptLabelByWorker = new Map<string, string>(
    lineageWorkerHistory(taskWorkers, ciAttemptTasks).map(({ worker, attemptLabel }, i, all) => [worker.id, attemptLabel ?? (all.length > 1 ? `Attempt ${all.length - i}` : 'This run')]),
  );
  const errorEvidenceItems = buildErrorEvidenceItems({
    traces: errorTraces,
    consequences: traceConsequences,
    attemptLabelByWorker,
    milestonesByWorker: new Map(traceWorkers.map(w => [w.id, (w.milestones as WorkerMilestone[] | null) ?? []])),
  });
  const terminalSucceeded = verdict?.state === 'shipped' || verdict?.state === 'done';

  const timeline = buildTaskTimeline({ task, workers: taskWorkers, kind: deliveryView ? projectKernelState(deliveryView.state) : prLife.mergedAt ? 'landed' : 'build', delivery: deliveryView, lineage: prOutcome?.lineage, ciAttemptTasks });

  // --- Helpers ---

  function timeAgo(date: Date | string): string {
    const now = Date.now();
    const then = new Date(date).getTime();
    const seconds = Math.floor((now - then) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  const TASK_ICONS: Record<string, { icon: string; bg: string; text: string }> = {
    completed:              { icon: '\u2713', bg: 'bg-status-success/12', text: 'text-status-success' },
    running:                { icon: '\u27F3', bg: 'bg-status-running/12', text: 'text-status-running' },
    assigned:               { icon: '\u27F3', bg: 'bg-status-info/12',    text: 'text-status-info' },
    starting:               { icon: '\u27F3', bg: 'bg-status-running/12', text: 'text-status-running' },
    pending:                { icon: '\u25CB', bg: 'bg-status-warning/12', text: 'text-status-warning' },
    failed:                 { icon: '\u2715', bg: 'bg-status-error/12',   text: 'text-status-error' },
    waiting_input:          { icon: '!',      bg: 'bg-status-warning/12', text: 'text-status-warning' },
  };
  const DEFAULT_ICON = TASK_ICONS.pending;

  // The completed header applies (same predicate buildTaskShippedView uses);
  // known here because the fact sheet is built before the view.
  const shippedViewShown = task.status === 'completed' && task.mode !== 'planning';

  // The side panel's fact sheet. Each row only when there's something to say.
  const factWorker = activeWorker ?? taskWorkers[0] ?? null;
  const unresolvedDepIds = new Set(unresolvedDeps.map(d => d.id));
  const pathManifest = Array.isArray(task.pathManifest) ? (task.pathManifest as string[]) : [];
  const ciAttemptWorkers = ciAttemptTasks.flatMap(t => t.workers.slice(0, 1));
  // Every worker on this task's PR, the CI-fix attempts' included.
  const workerHistory = lineageWorkerHistory(taskWorkers, ciAttemptTasks);
  // Only with a frozen estimate, i.e. the team switch is on; off, the page is unchanged.
  const timeRow = !taskEstimate ? null : buildTimeRow({
    sessions: taskWorkers,
    finished: isTerminal,
    now: Date.now(),
    estimate: taskEstimatePayload(taskEstimate),
  });
  const factRows: FactRow[] = [
    ...(prOutcome && prWorker && isTerminal && !prStatedAbove
      ? [{
          key: 'pr',
          label: 'PR',
          value: (
            <a href={prWorker.prUrl!} target="_blank" rel="noopener noreferrer" className="hover:underline">
              <span className="text-accent-text">#{prWorker.prNumber}</span>
              <span className="text-text-muted"> · {(prLife.mergedAt ? 'merged' : prLife.prLifecycleStatus ?? 'open').replace(/_/g, ' ')}</span>
            </a>
          ),
        }]
      : []),
    // Completed: workers and scope live in Run details, not here as well.
    ...(prOutcome && ciAttemptWorkers.length > 0 && prWorker && !shippedViewShown
      ? [{
          key: 'workers',
          label: 'Agents',
          value: (
            <ul>
              {[prWorker, ...ciAttemptWorkers].map((w, i) => (
                // One line each: the runner, then its attempt number. "(retry)"
                // is what "CI fix 1" already says, and it wrapped on its own.
                <li key={w.id} className="flex min-w-0 min-h-11 md:min-h-0 items-center md:items-baseline gap-2">
                  <span className="min-w-0 truncate">{runnerLabel(w)}</span>
                  <span className="shrink-0 whitespace-nowrap text-text-muted">attempt {i + 1}</span>
                </li>
              ))}
            </ul>
          ),
        }]
      : factWorker && !shippedViewShown
        ? runnerFactRow(runnerLabel(factWorker))
        : []),
    ...(!(prOutcome && isTerminal) ? branchFactRow(factWorker?.branch) : []),
    ...(timeRow
      ? [{
          key: 'time',
          label: 'Time',
          value: (
            <TaskTimeRow view={timeRow} />
          ),
        }]
      : []),
    ...(depTasks.length > 0
      ? [{
          key: 'needs',
          label: 'Needs',
          value: (
            <ul className="space-y-1">
              {depTasks.map(dep => {
                const depResult = dep.result as Record<string, unknown> | null;
                const stalled = dep.status === 'failed' && depResult?.errorType === 'infra_stalled';
                const ok = !unresolvedDepIds.has(dep.id);
                return (
                  <li key={dep.id} className="flex items-baseline gap-2 min-w-0">
                    <span className={ok ? 'text-status-success' : stalled ? 'text-status-warning' : 'text-text-muted'} aria-label={ok ? 'resolved' : dep.status}>
                      {ok ? '✓' : stalled ? '!' : '○'}
                    </span>
                    <Link href={taskPageHref({ taskId: dep.id })} className="min-w-0 truncate hover:underline" title={dep.title}><TaskTitleText short title={dep.title} /></Link>
                    {stalled && <span className="shrink-0 text-[11px] text-status-warning">infra stalled</span>}
                  </li>
                );
              })}
            </ul>
          ),
        }]
      : []),
    ...(pathManifest.length > 0 && !shippedViewShown
      ? [{
          key: 'scope',
          label: 'Scope',
          value: <ul>{pathManifest.map(p => <li key={p} className="truncate" title={p}>{p}</li>)}</ul>,
        }]
      : []),
    ...(!origin.isEmpty || origin.shipped
      ? [{
          key: 'origin',
          label: 'Origin',
          value: (
            <div data-testid="task-origin" className="space-y-1">
              {!origin.isEmpty && (
                <div data-testid="task-origin-clause">{[origin.actor, ...origin.parts].filter(Boolean).join(' · ')}</div>
              )}
              {origin.links.length > 0 && (
                <ul data-testid="task-origin-links" className="space-y-1.5 pt-1">
                  {originLinkCards(origin.links).map(card => {
                    const body = (
                      <>
                        <span className="block text-eyebrow text-text-muted">{card.kind}</span>
                        <span className="block truncate text-text-primary" title={card.title}>{card.title}{card.external ? ' ↗' : ''}</span>
                      </>
                    );
                    const cls = 'block border border-border-default bg-surface-2 px-2.5 py-1.5 hover:border-border-strong';
                    return (
                      <li key={card.key}>
                        {card.external ? (
                          <a href={card.href} target="_blank" rel="noopener noreferrer" className={cls}>{body}</a>
                        ) : (
                          <Link href={card.href} className={cls}>{body}</Link>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {origin.shipped && (
                <div data-testid="task-origin-shipped" className="text-text-secondary">
                  Released in <Link href={origin.shipped.href} className="text-status-success hover:underline">{origin.shipped.label}</Link>
                </div>
              )}
            </div>
          ),
        }]
      : []),
  ];

  // "What shipped" (completed tasks): the stored lede record, this task's own
  // audit screenshots as hero shots, the PR's state for "Your move".
  const conventionalType = /^(?:\[[^\]]*\]\s*)?([a-z]+)(?:\([^)]*\))?!?:/i.exec(task.title.trim())?.[1] ?? null;
  const shippedResult = (task.result ?? null) as { summary?: string; summarySource?: string; shipped?: unknown; structuredOutput?: Record<string, unknown> } | null;
  const shippedView = buildTaskShippedView({
    taskStatus: task.status,
    taskMode: task.mode,
    conventionalType,
    category: task.category ?? null,
    record: parseTaskShippedRecord(shippedResult?.shipped),
    summary: shippedResult?.summary ?? null,
    summarySource: shippedResult?.summarySource ?? null,
    structuredOutput: shippedResult?.structuredOutput ?? null,
    subject: { kind: subject.kind, prNumber: deliveryView?.prNumber ?? (typeof task.context?.prNumber === 'number' ? task.context.prNumber : null) },
    // "What shipped" only once it did: merged, or finished without a PR.
    shipped: deliveryView ? deliveryView.state === 'MERGED' : !(prWorker && !(prWorker.mergedAt || prWorker.prLifecycleStatus === 'merged')),
    heroShots: pickHeroShots(undefined, buildHeroPool(toVisualShots(taskArtifacts))),
  });
  const stoppedSummary = shippedView?.lede ?? readableTaskResult(ownResult?.summary, ownResult?.structuredOutput).prose;
  const hostedRunnerUsage = await hostedRunnerUsagePromise;
  const runDetails: RunDetail[] = [];
  let runElapsed: string | null = null;
  {
    const runWorkers = workerHistory.map(h => h.worker);
    const runners = [...new Set(runWorkers.map(w => runnerLabel(w)).filter((n): n is string => !!n))];
    if (runners.length > 0) runDetails.push({ label: 'Runner', value: runners.join(', ') });
    // A claim no session ran is bookkeeping, not an attempt.
    const ranWorkers = runWorkers.filter(w => !isBookkeepingAttempt(w));
    if (ranWorkers.length > 1) runDetails.push({ label: 'Attempts', value: String(ranWorkers.length) });
    const turns = runWorkers.reduce((n, w) => n + (w.turns ?? 0), 0);
    if (turns > 0) runDetails.push({ label: 'Turns', value: String(turns) });
    const starts = runWorkers.map(w => w.startedAt?.getTime()).filter((t): t is number => t != null);
    const ends = runWorkers.map(w => w.completedAt?.getTime()).filter((t): t is number => t != null);
    if (starts.length > 0 && ends.length > 0) {
      runElapsed = formatElapsed(Math.max(...ends) - Math.min(...starts));
      runDetails.push({ label: 'Took', value: runElapsed });
    }
    const cost = runWorkers.reduce((n, w) => n + parseFloat(w.costUsd?.toString() || '0'), 0);
    const tokens = runWorkers.reduce((n, w) => n + (w.inputTokens || 0) + (w.outputTokens || 0), 0);
    if (cost > 0) runDetails.push({ label: 'Spend', value: `$${cost.toFixed(2)}` });
    else if (tokens > 0) runDetails.push({ label: 'Tokens', value: tokens.toLocaleString() });
    runDetails.push({ label: 'Model', value: [modelSummary.modelLabel, modelSummary.divergedTo ? `Ran on ${modelSummary.divergedTo}` : null].filter(Boolean).join(' · ') });
    if (modelSummary.tierLabel) runDetails.push({ label: 'Tier', value: modelSummary.tierLabel });
    const branch = prWorker?.branch ?? taskWorkers[0]?.branch;
    if (branch) runDetails.push({ label: 'Branch', value: <span className="font-mono text-meta" title={branch}>{displayBranchName(branch)}</span> });
    if (pathManifest.length > 0) {
      runDetails.push({ label: 'Scope', value: <ul className="font-mono text-meta">{pathManifest.map(p => <li key={p} className="[overflow-wrap:anywhere]">{p}</li>)}</ul> });
    }
  }

  const workerHistorySection = workerHistory.length > 0 ? (
          <div data-testid="task-worker-history">
            <div className="section-label pb-2 border-b border-border-default mb-6">
              Sessions
            </div>
            <div className="border border-border-default overflow-hidden">
              {groupAttemptHistory(workerHistory, task).map((item) => {
                if (item.kind === 'bookkeeping') {
                  const head = item.entries[0];
                  return (
                    <BookkeepingAttemptRow key={head.worker.id} workerId={head.worker.id} retry={item.retry} attemptLabel={head.attemptLabel} count={item.entries.length} undelivered={item.undelivered}>
                      {item.entries.map(({ worker, attemptLabel }) => {
                        const shownError = plainWorkerError(worker.error, taskBackend);
                        return (
                          <div key={worker.id} className="space-y-1">
                            <p>Runner: {runnerLabel(worker) ?? worker.name}{worker.account && ` \u00B7 ${worker.account.name}`}</p>
                            <p className="font-mono">Branch: <span title={worker.branch}>{displayBranchName(worker.branch)}</span></p>
                            {shownError && <p className="font-mono" title={shownError.raw}>{shownError.text}</p>}
                            <p className="font-mono" title={worker.id}>{attemptLabel ?? 'Attempt'} · {worker.turns} turns</p>
                          </div>
                        );
                      })}
                    </BookkeepingAttemptRow>
                  );
                }
                const { worker, attemptLabel } = item.entry;
                const iconStyle = TASK_ICONS[worker.status] || DEFAULT_ICON;
                return (
                  // Below md the badge + PR link wrap onto their own line under the
                  // text (the text column takes the rest of the first line, and
                  // pl-11 = icon w-7 + gap-4 lines them up with it).
                  <div key={worker.id} data-worker-id={worker.id} className="flex flex-wrap md:flex-nowrap items-center gap-x-4 gap-y-2 min-h-11 px-3 py-3 md:px-4 md:py-3.5 border-b border-border-default/40 last:border-b-0 hover:bg-surface-3">
                    <div className={`w-7 h-7 flex items-center justify-center text-[13px] flex-shrink-0 ${iconStyle.bg} ${iconStyle.text}`}>
                      {iconStyle.icon}
                    </div>
                    <div className="flex-1 min-w-0 basis-[calc(100%-2.75rem)] md:basis-0">
                      {/* One line: the runner name truncates first, the attempt label never wraps or cuts. */}
                      <div className="flex min-w-0 text-body font-medium" title={worker.name}>
                        <span className="min-w-0 truncate text-text-primary">{runnerLabel(worker) ?? worker.name}</span>
                        {attemptLabel && <span className="shrink-0 whitespace-nowrap font-normal text-text-muted">&nbsp;· {attemptLabel}</span>}
                      </div>
                      <div className="font-mono text-[11px] text-text-muted truncate">
                        {/* Generated names are capped mid-slug; cut at a token, full name on hover. */}
                        <span title={worker.branch}>{displayBranchName(worker.branch)}</span>
                        {worker.account && ` \u00B7 ${worker.account.name}`}
                      </div>
                      {(() => {
                        // "Not logged in · Please run /login" and kin, in plain words (raw on hover).
                        const shown = plainWorkerError(worker.error, taskBackend);
                        if (!shown) return null;
                        return (
                          <p className={`mt-0.5 whitespace-pre-wrap break-words text-status-error ${shown.plain ? 'text-[12px]' : 'font-mono text-[11px]'}`} title={shown.raw}>{shown.text}</p>
                        );
                      })()}
                      {worker.status === 'superseded' && (
                        <p className="text-[11px] text-text-muted mt-0.5">
                          Session ended after you answered the question.{' '}
                          {/* A legacy record links its Continue: task; a new attempt stays on this task. */}
                          {worker.continuationTaskId ? (
                            <a href={taskPageHref({ taskId: worker.continuationTaskId, missionId: task.missionId })} className="text-status-info hover:underline">
                              Continued in a new task →
                            </a>
                          ) : (
                            answeredAttemptLine(task.context, worker.id)
                          )}
                        </p>
                      )}
                      {worker.postSupersessionError && (
                        <p
                          className="font-mono text-[11px] text-status-warning mt-0.5 whitespace-pre-wrap break-words"
                          title={worker.postSupersessionError}
                        >
                          Error reported after this session ended: {worker.postSupersessionError}
                          {worker.continuationTaskId && (
                            <>
                              {' '}<a href={taskPageHref({ taskId: worker.continuationTaskId, missionId: task.missionId })} className="text-status-info hover:underline">See continuation →</a>
                            </>
                          )}
                        </p>
                      )}
                      {worker.rejectedCompletionPayload && (() => {
                        const rejected = worker.rejectedCompletionPayload as {
                          reason?: string; summary?: string | null; salvagedArtifactId?: string;
                        };
                        return (
                          <div className="mt-1 border border-status-warning/30 bg-status-warning/5 px-2 py-1.5">
                            <p className="text-meta font-semibold text-status-warning">
                              ⚠ Deliverable rejected
                              {rejected.reason ? ` (${rejected.reason})` : ''}
                            </p>
                            {rejected.summary && (
                              <p className="text-[11px] text-text-muted mt-0.5 whitespace-pre-wrap break-words line-clamp-4">{rejected.summary}</p>
                            )}
                            {rejected.salvagedArtifactId && (
                              <p className="font-mono text-[11px] md:text-[10px] text-text-muted mt-0.5">Salvaged as artifact {rejected.salvagedArtifactId}</p>
                            )}
                          </div>
                        );
                      })()}
                      <div className="flex items-center gap-3 mt-1 font-mono text-[11px] text-text-muted">
                        <span>{worker.startedAt ? timeAgo(worker.startedAt) : '-'}</span>
                        <span>{worker.turns} turns</span>
                        {((worker.inputTokens || 0) + (worker.outputTokens || 0)) > 0 && (
                          <span>{((worker.inputTokens || 0) + (worker.outputTokens || 0)).toLocaleString()} tokens</span>
                        )}
                        {/* The worker's own basis, not the account's authType
                            (docs/specs/real-and-virtual-cost.md). */}
                        {parseFloat(worker.costUsd?.toString() || '0') > 0 && (
                          <span>
                            ${parseFloat(worker.costUsd?.toString() || '0').toFixed(4)}
                            {(worker as { costBasis?: string | null }).costBasis === 'virtual' ? ' list price' : ''}
                          </span>
                        )}
                        {(worker.resultMeta as any)?.terminalReason && (worker.resultMeta as any).terminalReason !== 'completed' && (
                          <span className="text-status-warning">stop: {((worker.resultMeta as any).terminalReason as string).replace(/_/g, ' ')}</span>
                        )}
                        {!(worker.resultMeta as any)?.terminalReason && (worker.resultMeta as any)?.stopReason && (worker.resultMeta as any).stopReason !== 'end_turn' && (
                          <span className="text-status-warning">stop: {(worker.resultMeta as any).stopReason}</span>
                        )}
                        {/*
                          The model THIS worker ran on, beside its turns and cost.
                          Divergence is a per-worker fact — a retry is a second
                          worker and a fallback fires within one — so this is
                          where it belongs, and this row is visible by default.
                          The same note inside the collapsed Details disclosure
                          is only ever seen by someone already looking for it.
                          Muted, never a status colour: a fallback is normal, and
                          only the fleet-wide rate is worth alarm.
                        */}
                        {(() => {
                          const ran = primaryModelFromUsage((worker.resultMeta as any)?.modelUsage);
                          if (!ran.primary) return null;
                          const verdict = compareAssignedActual(task.predictedModel, ran.primary);
                          return (
                            <span title={ran.all.join(', ')}>
                              {getModelDisplayName(ran.primary)}
                              {ran.multiple && ` +${ran.all.length - 1}`}
                              {verdict.verdict === 'diverged' && ' (assigned ' + getModelDisplayName(verdict.assigned) + ')'}
                            </span>
                          );
                        })()}
                      </div>
                      {/* Per-model usage breakdown — hidden on mobile for density */}
                      {(worker.resultMeta as any)?.modelUsage && Object.keys((worker.resultMeta as any).modelUsage).length > 0 && (
                        <div className="hidden md:flex mt-1.5 flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] md:text-[10px] text-text-muted">
                          {Object.entries((worker.resultMeta as any).modelUsage as Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; costUSD: number }>).map(([model, usage]) => (
                            <span key={model} className="inline-flex items-center gap-1">
                              <span className="text-text-secondary">{getModelDisplayName(model)}</span>
                              <span>{((usage.inputTokens + usage.cacheReadInputTokens) / 1000).toFixed(0)}k in</span>
                              <span>{(usage.outputTokens / 1000).toFixed(0)}k out</span>
                              {usage.costUSD > 0 && <span className="text-text-secondary">${usage.costUSD.toFixed(4)}</span>}
                            </span>
                          ))}
                          {(worker.resultMeta as any).durationMs > 0 && (
                            <span>{((worker.resultMeta as any).durationMs / 1000).toFixed(0)}s total</span>
                          )}
                          {(worker.resultMeta as any).durationApiMs > 0 && (
                            <span>{((worker.resultMeta as any).durationApiMs / 1000).toFixed(0)}s API</span>
                          )}
                        </div>
                      )}
                    </div>
                    <div data-testid="worker-history-meta" className="flex items-center gap-2 pl-11 md:pl-0 shrink-0">
                      <StatusPill status={
                        worker.status === 'failed' && worker.exitCause && BADGED_EXIT_CAUSES.has(worker.exitCause)
                          ? worker.exitCause
                          : worker.status
                      } />
                      {worker.prUrl && (
                        <a
                          href={worker.prUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center min-h-11 md:min-h-0 px-3 py-[5px] text-xs whitespace-nowrap bg-status-success/10 text-status-success hover:bg-status-success/20"
                        >
                          PR #{worker.prNumber}
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
  ) : null;

  const evidenceFilesSection = (
    <TaskEvidenceFiles
      taskId={task.id}
      objects={evidenceFiles}
      sensitive={(task.workspace as { dataClass?: string } | null)?.dataClass === 'sensitive'}
      defaultOpen={task.status === 'failed' && evidenceFiles.length > 0}
    />
  );
  const runArtifacts = (<>
        {/* Artifacts; an audit task's Tray shows even before its first screen
            (queued, no browser runner, boot failed, stalled), with its actions. */}
        {(visibleArtifacts.length > 0 || auditVisual) && (
          <TaskArtifactsSection
            artifacts={visibleArtifacts.map(a => ({
              ...toTaskArtifactItem({ ...a, content: a.content?.slice(0, ARTIFACT_PREVIEW_CHARS) ?? null }),
              // The body past the preview loads when the viewer opens.
              truncated: (a.contentLength ?? 0) > Math.min(a.content?.length ?? 0, ARTIFACT_PREVIEW_CHARS),
            }))}
            taskId={task.id}
            baseUrl={process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev'}
            initialOpenArtifactId={initialOpenArtifactId}
            missionId={task.missionId ?? null}
            visual={auditVisual}
          />
        )}


  </>);
  const archivedWorkerSection = (<>
{!activeWorker && taskWorkers[0] && <RealTimeWorkerView {...liveWorkerViewProps({ task: { id: task.id, status: task.status, outputRequirement: task.outputRequirement }, worker: taskWorkers[0], delivery: deliveryPill, deliverableArtifactCount: evidenceArtifactCount, usesReviewer: RUN_PROGRESS_READERS.usesReviewer(task.workspace, task.mission, task, { baseRef: taskWorkers[0].prBaseRef }), modelTier: modelSummary.tierLabel, roleName })} />}
  </>);
  const archivedPrSection = (<>
        {/* PR outcome — the diff split by attempt, "How it landed" (attempt →
            CI → retry → merge) and checks per commit (AC-4). Shown for an open
            PR and for one that landed. */}
        {(() => {
          // The same facts the mission task sheet cards (lib/task-sections).
          const prFacts = taskPrFacts(prWorker, deliveryView);
          if (!prFacts) return null;
          const storedPrFacts = {
            ...prFacts,
            // The header carries the summary and the one action.
            outcome: prOutcome && shippedView ? { ...prOutcome, summary: null } : prOutcome,
            hideAction: !!shippedView,
            statedAbove: prStatedAbove,
            openAttempt,
            repairLinks: {
              parent: deliverableLink && subject.kind === 'fix'
                ? { taskId: deliverableLink.taskId, title: deliverableLink.title ? displayTaskTitle(deliverableLink.title) : null }
                : null,
              fixes: ciAttemptTasks.map(t => ({ taskId: t.id, title: t.title ? displayTaskTitle(t.title) : null })),
            },
            // AC-24: the delivery's rounds, the same line the checks list and get_pr print.
            reviewRounds: checksSection?.checks.review ?? null,
          };
          return (
            <div className={`mb-10 ${activeWorker ? '' : 'order-first'}`} data-testid="task-pr-section">
              {/* The GitHub-derived half of this card (CI runs, reviews,
                  mergeability) is several REST calls, so it streams in behind
                  a boundary instead of holding the whole page. The fallback is
                  the same card rendered from stored state, so the PR is
                  readable and linkable on first paint. */}
              <Suspense fallback={<StoredPrCard {...storedPrFacts} />}>
                <PrDetailsCard workspaceId={task.workspaceId} headSha={prWorker?.lastCommitSha ?? null} {...storedPrFacts} />
              </Suspense>
            </div>
          );
        })()}
  </>);

  // The page already carries the worker as props, so the region starts without a copy of it (a duplicate in the payload is what the page's data budget counts).
  // What a live event re-reads: the shown worker and the task's status, from
  // the task's own rows. The page's other loaders do not run (lib/task-live-region.ts).
  const renderedRegion = { taskId: task.id, taskStatus: task.status, workerId: activeWorker?.id ?? null, hadQuestion: !!activeWorker?.waitingFor };
  async function loadRegion() {
    'use server';
    const viewer = await getCurrentUser();
    return viewer ? loadTaskLiveRegion(viewer.id, renderedRegion) : null;
  }

  return (
    <DisplayTimezoneProvider teamTimezone={teamTimezone}>
    <DiagnosticsAudienceProvider visible={diagnosticsVisible}>
    <LiveData initial={{ taskStatus: task.status, worker: null }} load={loadRegion}>
    <div className="p-4 md:p-8 overflow-x-hidden overflow-y-auto h-full">
      <div className="max-w-[900px] w-full">
        {/* Auto-refresh when worker claims this task or deps resolve */}
        <TaskAutoRefresh
          taskId={task.id}
          workspaceId={task.workspaceId}
          taskStatus={task.status}
          taskMode={task.mode}
          depTaskIds={depTaskIds}
          hasSubTasks={!!(task.subTasks && task.subTasks.length > 0)}
          workerHasOpenPr={workerHasOpenPr}
        />

          <nav aria-label="Breadcrumb" className="text-sm text-text-secondary -mt-2 mb-1 md:mt-0 md:mb-2">
            <Link
              href={task.mission ? missionTaskHref({ missionId: task.mission.id, taskId: task.id, ...missionBack, mode: 'focus' }) : '/app/tasks'}
              data-testid="task-back"
              className="inline-flex min-h-11 items-center hover:text-text-primary"
            >
              ‹ {task.mission ? task.mission.title : 'Activity'}
            </Link>
          </nav>

        <div className="">
        <div className="min-w-0" data-testid="task-main">
        {/* Header — eyebrow (type · scope · role), the subject as the title, and
            one status pill with the admin actions behind ⋯ (D9). Chips that
            used to crowd the title line sit on the quiet meta line below. */}
        <div className="mb-4 md:mb-6" data-testid="task-header">
          {/* Desktop: title, status pill (only without a verdict) and actions
              (Ask, ⋯) on one row. Phone: the title takes the full width and the
              pill and actions share the compact row under it, so no reserved
              column narrows a long title (task-page spec §Mobile header). */}
          <div className={`grid items-start gap-x-3 gap-y-2 md:gap-x-4 ${!shippedView && !verdict ? 'grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_auto_auto]' : 'grid-cols-[minmax(0,1fr)_auto]'}`}>
            {shippedView ? (
              <div className="min-w-0 col-span-2 row-start-1 md:col-span-1 md:col-start-1">
                <TaskShippedTitle view={shippedView} title={heading.heading} />
              </div>
            ) : (
            <div className="min-w-0 col-span-2 row-start-1 md:col-span-1 md:col-start-1">
              <TaskTitle title={heading.heading} />
            </div>
            )}
            {/* With a verdict, the verdict block carries the state (and this hook). */}
            {!shippedView && !verdict && (
              <span data-testid="task-header-status" data-status={displayStatus} className="col-start-1 row-start-2 self-center md:col-start-2 md:row-start-1 md:self-start md:mt-0.5">
                <HeaderStatusPill
                  status={displayStatus}
                  merged={taskHeaderMerged(prWorker ? prLife : null, task.status)}
                  delivery={deliveryPill}
                />
              </span>
            )}
            <div data-testid="task-header-actions" className={`flex items-center justify-end gap-2 col-start-2 row-start-2 md:row-start-1 md:mt-0.5 ${!shippedView && !verdict ? 'md:col-start-3' : ''}`}>
              <AskAboutLink kind="task" id={task.id} teamId={(task.workspace as { teamId?: string } | null)?.teamId ?? null} workspaceId={task.workspaceId} />
              <TaskOverflowMenu>
                <EditTaskButton
                  task={{
                    id: task.id,
                    title: task.title,
                    description: task.description,
                    priority: task.priority,
                    project: task.project,
                    workspaceId: task.workspaceId,
                    dependsOn: (task.dependsOn as string[]) || [],
                    mode: task.mode,
                    status: task.status,
                    backend: (task.backend as 'claude' | 'codex' | null) ?? null,
                  }}
                />
                <StartTimeControl
                  taskId={task.id}
                  status={task.status}
                  claimedBy={task.claimedBy ?? null}
                  startAt={task.startAt?.toISOString() ?? null}
                />
                {canReassign && <ReassignButton taskId={task.id} taskStatus={task.status} currentBackend={(task.backend as 'claude' | 'codex' | null) ?? null} />}
                {task.externalUrl && (
                  <a
                    href={task.externalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex min-h-11 items-center justify-center px-4 py-2 text-sm border border-border-default hover:bg-surface-3"
                  >
                    View Source ↗
                  </a>
                )}
                <DeleteTaskButton taskId={task.id} taskStatus={task.status} />
              </TaskOverflowMenu>
            </div>
          {/* One mono sub-line: type · scope · role, the workspace, loop and ship
              state, the PR. Created, category, project and the error count live
              in Details and the evidence below, not here. On a phone with no
              status pill it shares the actions' row instead of leaving them alone. */}
          <div data-testid="task-subline" className={`${!shippedView && !verdict ? 'col-span-2 row-start-3' : 'col-start-1 row-start-2 self-center'} md:col-span-full md:col-start-1 md:row-start-2 min-w-0 flex items-center gap-x-2 gap-y-1.5 flex-wrap text-[12px] text-text-muted font-mono`}>
            <span>
              {heading.eyebrow.length > 0 && <span data-testid="task-eyebrow">{heading.eyebrow.join(' · ')} · </span>}
              {task.workspace?.name ? displayWorkspaceName(task.workspace.name) : 'Unknown'}
            </span>
            {task.loopConfig && (
              <LoopStatusChip
                loopIteration={task.loopIteration}
                maxLoops={task.loopConfig.maxLoops ?? 5}
                loopState={task.loopState}
                startAt={task.startAt?.toISOString() ?? null}
                exitConditionType={task.loopConfig.exitCondition?.type ?? null}
              />
            )}
            {/* Release controls belong to the deliverable, never to a review or fix run. */}
            {subject.kind === 'deliverable' && <TaskShipBadge release={task.release} shippedReleaseId={shippedRelease?.releaseId ?? null} />}
            {workerWithPr && !prOutcome && (
              <a
                href={workerWithPr.prUrl!}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center gap-1 text-accent-text hover:underline font-medium md:min-h-0"
              >
                PR #{workerWithPr.prNumber} ↗
              </a>
            )}
          </div>
          </div>
          {/* An attempt says what it is an attempt of, and links the deliverable. */}
          {deliverableLink && subject.kind !== 'deliverable' && (
            <TaskSubjectLink
              kind={subject.kind}
              href={taskPageHref({ taskId: deliverableLink.taskId, missionId: task.missionId })}
              prNumber={deliveryView?.prNumber ?? (typeof task.context?.prNumber === 'number' ? task.context.prNumber : null)}
              title={deliverableLink.title ? displayTaskTitle(deliverableLink.title) : null}
            />
          )}
          {recoveryLine && (
            <p data-testid="task-recovery-line" className="mt-2 text-meta text-text-secondary [overflow-wrap:anywhere]">{recoveryLine}</p>
          )}
          {/* The one track, in the delivery's words (task-page State mapping). A
              live run's own view leads with it, so it is drawn here only between runs. */}
          {headerTrack && !activeWorker && <Lifecycle state={headerTrack.state} phrase={headerTrack.phrase} className="mt-3" />}
        </div>

        {/* Active Worker — the hero: the Now strip while it runs, the question
            while it waits. First in the column at every width. */}
        {activeWorker && (
          <div className="mb-8 order-first" data-testid="task-active-worker">
            <RealTimeWorkerView
              {...liveWorkerViewProps({
                task: { id: task.id, status: task.status, outputRequirement: task.outputRequirement },
                worker: activeWorker,
                delivery: deliveryPill,
                deliverableArtifactCount: evidenceArtifactCount,
                usesReviewer: RUN_PROGRESS_READERS.usesReviewer(task.workspace, task.mission, task, { baseRef: activeWorker.prBaseRef }),
                reviewState: evidenceReview?.state,
                modelTier: modelSummary.tierLabel,
                questionNote,
                roleName,
              })}
              focusAnswer={focusAnswer}
              controls={<WorkerSteerPanel {...workerSteerProps(activeWorker, taskWorkers, isTerminal)} showHistory={false} />}
            />
          </div>
        )}



        {/* Action first (W6): the phase's one decision, before anything to read.
            The task sheet's own TaskActionZone, for a start and a failure alike,
            so the sheet, this page and the mission drawer cannot offer
            different things. The page alone adds runner targeting. An open
            question is answered in the live worker view below
            (worker-needs-input-banner), which leads the list on mobile. */}
        {taskRecovery?.holdsCompletion && (
          <Notice
            tone={taskRecovery.phase === 'unavailable' ? 'err' : taskRecovery.phase === 'decision' ? 'warn' : 'info'}
            title={taskRecovery.stateWord}
            className="mt-4"
            data-testid="task-recovery-status"
          >
            <p>{taskRecovery.sentence}</p>
            <p className="text-meta text-text-muted">Owner: {taskRecovery.ownerLabel}</p>
          </Notice>
        )}

        {/* An open question's own card is below: the verdict would only point at it. */}
        {verdict && !verdictRepeatsOpenQuestion(verdict, { questionOnPage: !!activeWorker?.waitingFor }) && (
          <TaskVerdictBlock verdict={!activeWorker && prWorker?.prUrl ? { ...verdict, actions: verdict.actions.filter(a => a.href !== prWorker.prUrl || a.tone !== 'quiet') } : verdict} displayStatus={displayStatus} />
        )}
        {deliveryView?.escalation && deliveryView.prNumber != null && subject.kind === 'deliverable' && (
          <EscalationDecision brief={deliveryView.escalation} copy={escalationCopy!} prNumber={deliveryView.prNumber} workspaceId={task.workspaceId} />
        )}

        {!activeWorker && <TaskTimeline groups={timeline} />}
        {!activeWorker && stoppedSummary && <p aria-label="Summary" className="mb-4 text-body text-text-secondary line-clamp-2">{stoppedSummary}</p>}
        {!activeWorker && prWorker?.prUrl && <a href={prWorker.prUrl} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center justify-center border border-border-default mb-5 text-body hover:bg-surface-2">PR #{prWorker.prNumber} ↗</a>}

        {/* Checks on the delivery's current head, by round (task-page spec). */}
        {checksSection && <TaskChecksSection section={checksSection} currentTaskId={task.id} />}

        <ServiceStatusList statuses={taskServiceStatus} showWork={false} />
        {runnerReach && (
          <RunnerReachBanner workspaceId={task.workspaceId} diagnosis={runnerReach.diagnosis} canFix={runnerReach.canFix} />
        )}
        {(phase === 'failed' || canStart || isBlocked) && (
          <div className="mb-6" data-testid="task-page-action-zone">
            <TaskPageActionZone
              taskId={task.id}
              workspaceId={task.workspaceId}
              phase={phase}
              isBlocked={isBlocked}
              blockedByCount={unresolvedDeps.length}
              backend={(task.backend as 'claude' | 'codex' | null) ?? null}
              deliveryReading={deliveryPillLabel(deliveryPill)}
              failureKind={failureKind}
              waitingOn={failureWaitingOn}
              trouble={trouble}
              auditTaskId={auditTaskIdFor(task, failureKind)}
              lastError={failedExcerpt ? { excerpt: failedExcerpt, raw: taskWorkers[0]?.error ?? null } : null}
              worker={null}
              roleSlug={task.roleSlug}
              missionExecutor={missionExecutorOf(task.mission)}
              taskTitle={task.title}
              entitlementBlock={task.status === 'pending' ? parseEntitlementBlock((task.context as Record<string, unknown> | null)?.[ENTITLEMENT_BLOCK_CONTEXT_KEY]) : null}
              credentialBlock={task.status === 'pending' ? parseCredentialBlock((task.context as Record<string, unknown> | null)?.[CREDENTIAL_BLOCK_CONTEXT_KEY]) : null}
              runnerPicker
            />
          </div>
        )}

        {/* Agent Questions — every question note scoped to this task, a mission
            task's included (S6: no mission gate). An open question is the
            decision, so it sits with the action, above anything to read. */}
        <TaskQuestionFeed
          taskStatus={task.status}
          taskId={task.id}
          missionId={task.missionId ?? null}
          activeWorkerId={activeWorker?.id ?? null}
          activeWorkerStatus={activeWorker?.status ?? null}
          excludeNoteId={questionNote?.id ?? null}
          roleName={roleName}
        />



        {hostedRunnerUsage && (
          <p data-testid="task-hosted-runner" className="mb-4 text-meta text-text-secondary tabular-nums">
            {taskRunnerLine(hostedRunnerUsage)}
          </p>
        )}

        <div className="flex flex-col">
        {/* Triage metadata — only foregrounded in the pending family, where runner / backend
            drive the "should this run, and how?" decision. Priority is omitted here — it
            rarely drives operator decisions and is still accessible in Details below. */}
        {/* Each part earns its slot: the role only when there is one (the pending
            eyebrow rule, lib/task-eyebrow.ts), the runner preference only when it
            narrows — the default 'any' used to lead this line and read as a role.
            Tier word only at this altitude — the concrete id belongs in Details.
            Pre-flight is the one moment the tier is still changeable. */}
        {isPendingFamily && (() => {
          const eyebrow = deriveTaskEyebrow({
            status: 'pending',
            role: task.roleSlug ? { slug: task.roleSlug, name: roleName } : null,
            roleInferred: (task.context as Record<string, unknown> | null)?.roleInferred != null,
          });
          const parts = [
            taskEyebrowText(eyebrow) || null,
            task.runnerPreference && task.runnerPreference !== 'any' ? `${task.runnerPreference} runner` : null,
            task.backend ? task.backend.charAt(0).toUpperCase() + task.backend.slice(1) : null,
            modelSummary.tierLabel || null,
          ].filter((p): p is string => !!p);
          if (parts.length === 0) return null;
          return (
            <div data-testid="task-triage-line" className="mb-6 px-1 flex items-center gap-1.5 text-[13px] text-text-secondary font-medium flex-wrap">
              {parts.map((p, i) => (
                <span key={p} className="contents">
                  {i > 0 && <span className="text-text-muted">&middot;</span>}
                  <span>{p}</span>
                </span>
              ))}
            </div>
          );
        })()}

        {/* Forced by X at T (docs/specs/force-start.md §Recording): the last
            dashboard Force start this task was claimed under. Override flags
            and the exact time are diagnostics: admins and operators only. */}
        {(() => {
          const forced = lastForceStart(task.context as Record<string, unknown> | null);
          if (!forced) return null;
          return (
            <DiagnosticsDisclosure summary="Started early" className="mb-6">
              <p data-testid="task-forced-start">
                Force-started by {forced.userId && forced.userId === user.id ? 'you' : 'a teammate'} at{' '}
                <ZonedTime value={forced.at} format="datetime" fallback={forced.at.slice(0, 16).replace('T', ' ')} />
                {' '}· skipped: {[...new Set(forced.kinds.map(gateName))].join(', ').toLowerCase()} ({forced.kinds.join(', ')})
              </p>
            </DiagnosticsDisclosure>
          );
        })()}

        {/* Blocked Banner — shown when task has unresolved dependencies */}
        {isBlocked && (() => {
          // Same predicate as the gate: the worker holding the PR open, which
          // need not be the newest one.
          const prBlockers = unresolvedDeps.flatMap(dep => {
            const w = dep.status === 'completed' ? findBlockingPrWorker(dep.workers ?? []) : undefined;
            // prUrl alone blocks (the gate's rule); prNumber only shapes the label.
            return w?.prUrl ? [{ dep, w }] : [];
          });
          const inProgressBlockers = unresolvedDeps.filter(d => d.status !== 'completed');
          return (
            <div className="bg-status-warning/10 border border-status-warning/20 p-4 mb-6">
              <div className="flex items-center gap-2 text-status-warning font-medium text-sm mb-2">
                <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {(() => {
                  // Creation-time overlap edges are ordering, not dependencies a person declared.
                  const inferred = new Set(task.pathDeclaration?.inferredDependsOn ?? []);
                  const overlap = unresolvedDeps.filter(d => inferred.has(d.id)).length;
                  return blockedHeadline(unresolvedDeps.length - overlap, overlap);
                })()}
              </div>
              <div className="space-y-1.5 ml-6">
                {prBlockers.map(({ dep, w }) => {
                  return (
                    <div key={dep.id} className="flex items-center gap-2 flex-wrap">
                      <a
                        href={w.prUrl!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium text-accent-text hover:underline"
                      >
                        {w.prNumber ? `Merge PR #${w.prNumber}` : 'PR open'} ↗
                      </a>
                      <span className="text-[12px] text-text-muted" title={dep.title}>
                        <TaskTitleText short title={dep.title} />
                      </span>
                    </div>
                  );
                })}
                {inProgressBlockers.map((dep) => (
                  <div key={dep.id} className="flex items-center gap-2">
                    <Link
                      href={taskPageHref({ taskId: dep.id })}
                      className="text-sm text-text-secondary hover:underline"
                    >
                      {displayTaskTitle(dep.title)}
                    </Link>
                    <StatusPill status={deriveDisplayStatus(dep.status)} />
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Mission Budget Banner — the parent mission is out of budget, so the
            claim loop skips this task and every sibling. Only raising the
            mission budget (or force-starting this one task) clears it. */}
        {missionBudgetExhausted && (
          <div className="bg-status-error/10 border border-status-error/20 p-4 mb-6">
            <div className="flex items-center gap-2 text-status-error font-medium text-sm mb-1">
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              Mission budget spent. This task can’t start.
            </div>
            <p className="text-[12px] text-text-secondary ml-6">
              Every task in{' '}
              {task.mission ? (
                <Link href={missionTaskHref({ missionId: task.mission.id, taskId: task.id, ...missionBack, mode: 'focus' })} className="text-accent-text hover:underline">
                  {task.mission.title}
                </Link>
              ) : 'this mission'}{' '}
              waits for more budget. Raise the mission budget to start them, or force-start this task.
            </p>
          </div>
        )}

        {/* Budget Exhausted Banner — shown when task was reset to pending due to budget exhaustion */}
        {isBudgetPaused && !isBlocked && (
          <div className="bg-status-warning/10 border border-status-warning/20 p-4 mb-6">
            <div className="flex items-center gap-2 text-status-warning font-medium text-sm">
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Recorded {budgetBackendLabel} budget/rate-limit.{' '}
              {budgetResetsAtIso
                ? <>Recorded reset: <LocalTime iso={budgetResetsAtIso} suffix="." /></>
                : 'No reset time recorded.'}
            </div>
            {switchOptions.length > 0 && (
              <SwitchBackendButton taskId={id} options={switchOptions} />
            )}
          </div>
        )}

        {/* Loop history */}
        {task.loopConfig && (((task.result as Record<string, unknown> | null)?.loopHistory as unknown[] | undefined)?.length || ((task.context as Record<string, unknown> | null)?.loopHistory as unknown[] | undefined)?.length) ? (
          <LoopHistory
            entries={Array.isArray((task.result as Record<string, unknown> | null)?.loopHistory)
              ? (task.result as Record<string, unknown>).loopHistory as LoopHistoryEntry[]
              : Array.isArray((task.context as Record<string, unknown> | null)?.loopHistory)
                ? (task.context as Record<string, unknown>).loopHistory as LoopHistoryEntry[]
                : []}
            loopState={task.loopState}
            maxLoops={task.loopConfig.maxLoops ?? 5}
          />
        ) : null}

        {activeWorker && <TaskEvidenceCard status={task.status} result={task.result} workerError={taskWorkers[0]?.error ?? null} backend={taskBackend} failingChecks={verdict?.failingChecks ?? []} />}

        {/* A completed task keeps its evidence files in Run details. */}


        {/* Agent errors: every captured trace, sorted by what it means for the
            outcome (needs attention / unclear / recovered / exploration noise).
            Any row opens the complete redacted evidence. */}


        {/* Attachments */}
        {attachments && attachments.length > 0 && (
          <div className="mb-6">
            <div className="section-label pb-2 border-b border-border-default mb-4">
              Attachments
            </div>
            <div className="flex flex-wrap gap-2">
              {attachments.map((att, i) => (
                <div key={i} className="relative">
                  {att.mimeType.startsWith('image/') ? (
                    <img
                      src={att.src}
                      alt={att.filename}
                      className="max-h-32 border border-border-default"
                    />
                  ) : (
                    <div className="p-3 bg-surface-3">
                      <span className="text-sm">{att.filename}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Planning mode: where the plan stands (not a delivery, so a Notice) */}
        {task.mode === 'planning' && (
          // task.status is never 'running' — liveness is the worker's.
          <PlanningNotice subTaskCount={task.subTasks?.length ?? 0} running={baseDisplayStatus === 'running'} status={task.status} />
        )}

        {/* Plan Review — shown for completed planning tasks */}
        <PlanReviewPanel
          taskId={task.id}
          mode={task.mode}
          status={task.status}
          result={task.result as Record<string, unknown> | null}
        />

        </div>{/* end flex container */}

        {/* Completed: the raw handoff and everything about the run (workers,
            scope, evidence files, plan), each collapsed, after the outcome. */}
        {shippedView && (
          <div className="mb-8">
            <TaskShippedDetails
              view={shippedView}
              runDetails={runDetails}
              openRun={!!initialOpenArtifactId}
            >
              {archivedWorkerSection}
              {workerHistorySection}
        <TaskErrorEvidence items={errorEvidenceItems.filter(item => item.presentation !== 'unclear')} taskTitle={displayTaskTitle(task.title)} terminalSucceeded={terminalSucceeded} taskState={verdict?.headline ?? null} />
              {archivedPrSection}
              {runArtifacts}


              {evidenceFiles.length > 0 && evidenceFilesSection}

            </TaskShippedDetails>
          </div>
        )}

        {/* Deliverables: the summary, the code bar and any structured output,
            as the mission sheet shows them. The PR card carries the code and
            its summary when there is one. */}
        {activeWorker && !shippedView && (
          <TaskDeliverables
            taskId={task.id}
            result={withTaskPr(task.result as Record<string, unknown> | null, taskPr) as TaskDeliverablesResult | null}
            prCard={!!prOutcome}
            summaryInPrCard
            suppressedSummary={suppressedSummaryArtifact}
            baseUrl={process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev'}
          />
        )}

        {activeWorker && runArtifacts}
        {!shippedView && <details open={!!initialOpenArtifactId} className="border-y border-border-default mb-6"><summary className="min-h-11 flex items-center cursor-pointer text-body">Run</summary>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-3 pb-4 text-body">{runDetails.map(row => <div className="contents" key={row.label}><dt className="text-text-muted">{row.label}</dt><dd className="min-w-0 break-words">{row.value}</dd></div>)}</dl>
          {archivedWorkerSection}
          <TaskDeliverables taskId={task.id} result={withTaskPr(task.result as Record<string, unknown> | null, taskPr) as TaskDeliverablesResult | null} prCard summaryInPrCard suppressedSummary={suppressedSummaryArtifact} baseUrl={process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev'} />
          {workerHistorySection}
          {evidenceFilesSection}
        <TaskErrorEvidence items={errorEvidenceItems.filter(item => item.presentation !== 'unclear')} taskTitle={displayTaskTitle(task.title)} terminalSucceeded={terminalSucceeded} taskState={verdict?.headline ?? null} />
          {archivedPrSection}
          {!activeWorker && runArtifacts}

        </details>}



        {/* Empty state */}
        {taskWorkers.length === 0 && task.status === 'pending' && (
          <div className="border border-dashed border-border-default p-8 text-center">
            {isBlocked ? (
              <>
                <p className="text-text-secondary mb-2">Waiting on dependencies</p>
                <p className="text-sm text-text-muted">
                  {unresolvedDeps.length} {unresolvedDeps.length === 1 ? 'dependency' : 'dependencies'} must finish first.
                </p>
              </>
            ) : (
              <>
                <p className="text-text-secondary mb-2">Not started</p>
                <p className="text-sm text-text-muted">
                  Start it above, or a runner picks it up next.
                </p>
              </>
            )}
          </div>
        )}
        </div>{/* end task-main */}

        {/* Side panel — steer, the facts (runner, branch, needs, scope, origin),
            the description, and the rest of the fleet. On mobile it follows the
            main column; the question or the Now strip stays the first screen. */}
        <aside data-testid="task-side-panel" className="mt-6 space-y-6">
          <details data-testid="task-details" className="group border-y border-border-default">
            <summary className="min-h-11 flex items-center cursor-pointer text-body font-medium">Details</summary>
          <TaskAccessSection items={accessItems} />
          <FactSheet rows={factRows.filter(row => ['needs', 'time', 'origin'].includes(row.key))} />

          {/* Description — reference material, collapsed in the side panel */}
          {task.description && !descriptionIsSummary && (
            <SideDescription preview={task.description.replace(/[#*_`>\-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)}>
              <CollapsibleDescription content={task.description} />
            </SideDescription>
          )}

          {(specSource?.specId || specSource?.specPath) && <section data-testid="task-fixes" className="py-3 text-body">
            <h2 className="text-meta text-text-muted mb-2">What it fixes</h2>
            {specSource.specId ? <Link href={`/app/specs/${specSource.specId}`} className="text-accent-text hover:underline">{livingSpec?.title ?? 'Specification'} · revision {specSource.revision}</Link> : <p>{specSource.specPath}</p>}
            {livingSpec?.outcome?.criteria.map(c => <p key={c.criterionId} className="mt-2 [overflow-wrap:anywhere]">{c.criterionId} · {c.text} <span className="text-text-muted">{c.stale ? 'Needs recheck' : c.verdict === 'pass' ? 'Met' : c.verdict === 'fail' ? 'Not met' : 'Not verified'}</span></p>)}
          </section>}
          <p className="text-body text-text-secondary py-3">{workerHistory.filter(h => !isBookkeepingAttempt(h.worker)).length} attempts{lineageClaimToMergeMs != null ? ` · ${formatElapsed(lineageClaimToMergeMs)}` : runElapsed ? ` · ${runElapsed}` : ''}</p>

          {dependentTasks.length > 0 && (
            <section data-testid="task-unblocked">
              <div className="section-label border-b border-border-default pb-2 mb-1">Blocks</div>
              <ul>
                {dependentTasks.map(d => (
                  <li key={d.id} className="border-b border-border-default">
                    <Link href={taskPageHref({ taskId: d.id, missionId: task.missionId })} className="flex items-center gap-3 min-h-12 hover:bg-surface-2">
                      <span className={`w-[9px] h-[9px] shrink-0 ${d.status === 'pending' ? 'border-2 border-accent' : 'bg-accent'}`} aria-hidden="true" />
                      <span className="flex-1 min-w-0 truncate font-mono text-[13px] text-text-primary">{displayTaskTitle(d.title)}</span>
                      <span className={`shrink-0 font-mono text-[12px] ${d.status === 'completed' ? 'text-status-success' : d.status === 'pending' ? 'text-text-muted' : 'text-accent-text'}`}>
                        {statusPill(d.status).label}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Details — the triage/metadata that used to dominate the header as stat
              cards. Kept one tap away for when it's actually needed (billing, routing,
              debugging) without letting it crowd out the phase-relevant content. */}
          <details className="group">
            <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden flex items-center gap-3 min-h-11 border-b border-border-default text-meta font-semibold text-text-secondary hover:text-text-primary">
              <span className="group-open:rotate-90 transition-transform" aria-hidden="true">▸</span>
              Details
            </summary>
            <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-[13px]">
              <div><dt className="text-meta text-text-muted">Priority</dt><dd className="text-text-primary">{task.priority}</dd></div>

              <div><dt className="text-meta text-text-muted">Created</dt><dd className="text-text-primary"><ZonedTime value={task.createdAt} format="date" /></dd></div>
              {task.category && <div><dt className="text-meta text-text-muted">Category</dt><dd className="text-text-primary">{task.category}</dd></div>}
              {task.project && <div><dt className="text-meta text-text-muted">Project</dt><dd className="text-text-primary">{task.project}</dd></div>}
              <div className="col-span-2"><dt className="text-meta text-text-muted">Task ID</dt><dd className="text-text-primary font-mono text-[11px] break-all">{task.id}</dd></div>
            </dl>
          </details>

          {/* Runner scheduling for this task: admins and operators only. */}
          <DiagnosticsDisclosure>
            <dl data-testid="task-diagnostics" className="grid grid-cols-2 gap-x-6 gap-y-1">
              <dt>Runner preference</dt><dd>{task.runnerPreference}</dd>
              {task.backend && <><dt>Backend</dt><dd>{task.backend}</dd></>}
              <dt>Claimed by</dt><dd className="truncate">{task.account?.name || '-'}</dd>
              <dt>Agents</dt><dd>{taskWorkers.length}</dd>
              {task.claimedAt && <><dt>Claimed at</dt><dd><ZonedTime value={task.claimedAt} format="datetime" /></dd></>}
            </dl>
          </DiagnosticsDisclosure>
          </details>
        </aside>
        </div>{/* end grid */}
      </div>
    </div>
    </LiveData>
    </DiagnosticsAudienceProvider>
    </DisplayTimezoneProvider>
  );
}

export default withPageBudget('taskPage', TaskDetailPage);

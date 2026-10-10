import { getWorkerDeliverableArtifactCount } from '@/lib/worker-deliverables';
import { RUN_PROGRESS_READERS } from '@/modules';
import { Suspense } from 'react';
import { after } from 'next/server';
import { resolveRunnerDisplay, runnerDisplayResolver } from '@/lib/runner-display';
import { compareTasksChrono, compareWorkersChrono, newestFirst, oldestFirst, selectTaskWorkers } from '@/lib/attempt-order';
import { getRunnerHeartbeats, isRunnerOnline, loadRunnerHeartbeats } from '@/lib/runner-heartbeats';
import { db } from '@buildd/core/db';
import { tasks, workers, artifacts, workspaceSkills, workerErrorTraces, workspaces, missionNotes, releases, missions } from '@buildd/core/db/schema';
import { eq, desc, inArray, asc, ne, and, isNotNull, sql } from 'drizzle-orm';
import { deriveTaskEyebrow, taskEyebrowText } from '@/lib/task-eyebrow';
import { deriveDisplayStatus, deriveTaskPhase, isSubjectDead, isGateSatisfied, findBlockingPrWorker } from '@/lib/task-presentation';
import { normalizeRepoFullName } from '@/lib/repo-scope';
import { isOpenAsk, isOpenQuestionNote } from '@/lib/open-ask';
import { BYPASS_MISSION_BUDGET_KEY, hasBypassFlag } from '@/lib/bypass-flags';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { isPlatformOperator } from '@/lib/platform-operator';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { parseCredentialBlock, CREDENTIAL_BLOCK_CONTEXT_KEY } from '@/lib/credential-block-copy';
import { displayWorkspaceName, isLiveWorkerStatus, isTerminalTaskStatus, ENTITLEMENT_BLOCK_CONTEXT_KEY, parseEntitlementBlock } from '@buildd/shared';
import { isStorageConfigured, generateDownloadUrl } from '@/lib/storage';
import { isValidTaskId } from '@/lib/task-id';
import PlanningNotice from './PlanningNotice';
import LocalTime from '../LocalTime';
import ReassignButton from './ReassignButton';
import EditTaskButton from './EditTaskButton';
import DeleteTaskButton from './DeleteTaskButton';
import RealTimeWorkerView from './RealTimeWorkerView';
import { getDeliveryViewsForTasks } from '@/lib/workflow/delivery-view';
import { resolvePrDisplayState } from '@/lib/pr-presentation';
import type { DeliveryPillState } from './TaskSidePanel';
import PlanReviewPanel from './PlanReviewPanel';
import PlanChainView from './PlanChainView';

import TaskModelCell from './TaskModelCell';
import { getModelDisplayName, primaryModelFromUsage, compareAssignedActual } from '@buildd/core/model-display';
import TaskAutoRefresh from './TaskAutoRefresh';
import { DisplayTimezoneProvider, ZonedTime } from '@/components/DisplayTimezone';
import { getTeamTimezoneSetting } from '@/lib/team-timezone';
import SwitchBackendButton, { type BackendOption } from './SwitchBackendButton';
import TaskQuestionFeed from './TaskQuestionFeed';
import MarkdownContent from '@/components/MarkdownContent';
import CollapsibleDescription from './CollapsibleDescription';
import AiFeedback from '@/components/AiFeedback';
import { StatusPill } from '@/components/ui/StatePill';
import { displayBranchName } from '@/lib/branch-display';
import { LoopHistory, LoopStatusChip } from '@/components/LoopStatus';
import type { LoopHistoryEntry } from '@buildd/shared';
import { isSummaryDuplicate } from '@/components/artifact-helpers';
import TaskArtifactsSection from './TaskArtifactsSection';
import TaskAccessSection from './TaskAccessSection';
import { loadTaskAccess } from '@/lib/agent-capabilities/access-log';
import { VISUAL_AUDITOR_ROLE_SLUG } from '@/lib/mission-visual-review';
import { loadVisualReview } from '@/lib/visual-review-load';
import { visualReviewRoundOf } from '@/lib/visual-review-rounds';
import { toTaskArtifactItem } from './task-artifact-items';
import { hasCodeDeliverables as hasTaskCodeDeliverables } from './deliverables';
import ArtifactShareControl from '@/components/ArtifactShareControl';
import { refreshWorkerMergeStateIfStale } from '@/lib/pr-reconcile';
import { getBackendAvailability, teamEnabledBackends } from '@/lib/backend-failover';
import { backendLabel, failoverCandidates } from '@buildd/core/backend-policy';
import { deriveTaskModel } from '@/lib/model-presentation';
import { resolveShippedRelease } from '@/lib/task-ship-state';
import { deriveTaskOrigin } from '@/lib/task-origin';
import { originLinkCards } from './origin-links';
import { TaskShipBadge } from '@/components/TaskShipBadge';
import { SpecSourceBlock, type SpecSourceContext } from '@/components/SpecSourceBlock';
import PrDetailsCard, { StoredPrCard } from './PrDetailsCard';
import { loadOpenAttempt } from '@/lib/explain';
import TaskEvidenceCard from './TaskEvidenceCard';
import { plainWorkerError } from '@/lib/provider-auth-failure';
import TaskEvidenceFiles from './TaskEvidenceFiles';
import { listTaskEvidenceObjects, toEvidenceObjectSummary } from '@/lib/evidence-read';
import { evidenceViewOf } from '@/lib/task-evidence';
import MissionContextBar from './MissionContextBar';
import TaskPageActionZone from './TaskPageActionZone';
import { auditTaskIdFor, loadTaskFailureKind } from '@/lib/task-failure-kind-load';
import RunnerReachBanner from './RunnerReachBanner';
import { loadRunnerReachDiagnosis } from '@/lib/runner-reach';
import { canAdministerTeamKeys } from '@/lib/key-level-policy';
import { getTeamPermissionOverrides } from '@/lib/permissions';
import TaskOverflowMenu from './TaskOverflowMenu';
import { AskAboutLink } from '@/components/chat/ChatEntry';
import { missionContextBarFor, missionContextDeliveryTaskIds, type MissionContextBarData } from './mission-context-bar';
import { truncateExcerpt } from './error-excerpt';
import { attemptsNotInPrHistory, descriptionDuplicatesSummary, isAttemptTask, isMeaningfulPlan, partitionChildTasks, selectExecutionPlan } from './execution-plan';
import { MISSION_CARD_TASK_COLUMNS, MISSION_CARD_WORKERS_WITH } from '@/lib/mission-card-views';
import type { MissionCardRow } from '@/lib/mission-card-view';
import { missionTaskHref, taskPageHref } from '@/lib/mission-task-href';
import WorkerSteerPanel from './WorkerSteerPanel';
import { HeaderStatusPill, FactSheet, SideDescription, type FactRow } from './TaskSidePanel';
import { findTaskRole } from './role-lookup';
import { headerLifecycleState, taskHeading } from './task-header';
import Lifecycle from '@/components/ui/Lifecycle';
import { displayTaskTitle } from '@/lib/task-title';
import { linkQuestionNote } from './question-hero';
import { buildLineage } from './pr-lineage';
import { lineageDisplayStatus, lineageWorkerHistory } from './lineage-status';
import type { PrOutcome } from '@/components/task/PrCard';
import { buildHeroPool, pickHeroShots } from '@/lib/mission-shipped';
import { toVisualShots } from '@/lib/mission-visual-review';
import { parseTaskShippedRecord } from '@/lib/task-shipped';
import { buildTaskShippedView } from './task-shipped-header';
import { TaskShippedBody, TaskShippedTitle, type RunDetail } from './TaskShippedHeader';
import { taskHostedRunnerUsage } from '@/lib/hosted-runner-usage-store';
import { taskRunnerLine } from '@/lib/hosted-runner-usage';
import { TaskShippedDetails } from './TaskShippedHeader';
import { formatElapsed } from './format-elapsed';
import TaskVerdictBlock from './TaskVerdictBlock';
import TaskErrorEvidence from './TaskErrorEvidence';
import { buildErrorEvidenceItems } from './error-evidence';
import { nonDiffActions } from './attempt-actions';
import { bookkeepingAttemptRetry } from './bookkeeping-attempt';
import BookkeepingAttemptRow from './BookkeepingAttemptRow';
import { applyVerdictDecision, deriveTaskVerdict, parseStoredVerdictDecision } from '@/lib/task-verdict';
import { buildVerdictInput, traceOutcomeOf } from '@/lib/task-verdict-facts';
import { priorAttemptFactsOf, resolveTraceConsequences } from '@/lib/trace-consequence';
import type { WorkerMilestone } from '@buildd/core/db/schema';
import StartTimeControl from '@/components/StartTimeControl';

// Exit causes that get their own badge instead of a bare "Failed" — each one
// tells the operator where to look (budget, infra, over-claim, dead session).
const BADGED_EXIT_CAUSES = new Set(['budget_limited', 'infra_failure', 'never_started', 'silent_start']);

/** The task's mission executor, for the action zone's `claim_task` hint. */
function missionExecutorOf(row: { executor?: string | null } | null | undefined): 'runner' | 'local' | null {
  return row?.executor === 'local' ? 'local' : row?.executor === 'runner' ? 'runner' : null;
}

export default async function TaskDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ artifact?: string }>;
}) {
  const { id } = await params;
  const { artifact: initialOpenArtifactId } = await searchParams;
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
    where: eq(tasks.id, id),
    with: {
      workspace: true,
      // Explicit allowlist, like every sibling relation in this shape: the two
      // fields the page reads off an account rather than the whole row.
      account: { columns: { name: true } },
      mission: {
        columns: { id: true, title: true, status: true },
        with: { initiative: { columns: { id: true, title: true } } },
      },
      parentTask: { columns: { id: true, title: true, status: true, roleSlug: true, taskClass: true, mode: true, parentTaskId: true, context: true } },
      // taskClass/mode/title tell a subtask from an attempt at this task (D9).
      subTasks: { columns: { id: true, title: true, status: true, taskClass: true, mode: true, parentTaskId: true, createdAt: true }, orderBy: [asc(tasks.createdAt), asc(tasks.id)] },
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

  // These three need nothing but the task row and the access check above, and
  // nothing each other produces, so they are one wait rather than three serial
  // neon-http round trips. The access gate deliberately stays *ahead* of the
  // group rather than joining it: this is an authorization path, and reading a
  // task's workers for a viewer who turns out not to have access is not a
  // trade worth two round trips.
  const depTaskIds = (task.dependsOn as string[] | undefined) || [];
  const [openQuestionRows, depTasks, taskWorkers, missionContextRow] = await Promise.all([
    // Open question notes scoped to this task (drives the "Waiting on you"
    // badge, and lets the live worker view show the note and the worker's
    // waitingFor as ONE question). A mission task's questions carry its
    // missionId too — they are still this task's, so no mission gate (S6).
    db
      .select({
        id: missionNotes.id,
        workerId: missionNotes.workerId,
        type: missionNotes.type,
        status: missionNotes.status,
        title: missionNotes.title,
        body: missionNotes.body,
        defaultChoice: missionNotes.defaultChoice,
        createdAt: missionNotes.createdAt,
      })
      .from(missionNotes)
      .where(and(
        eq(missionNotes.taskId, id),
        eq(missionNotes.type, 'question'),
        eq(missionNotes.status, 'open'),
      ))
      .orderBy(asc(missionNotes.createdAt)),
    // Dependency tasks, if dependsOn has entries
    depTaskIds.length > 0
      ? db.query.tasks.findMany({
          where: inArray(tasks.id, depTaskIds),
          columns: { id: true, title: true, status: true, result: true },
          with: {
            workers: {
              columns: { prUrl: true, prNumber: true, mergedAt: true, prLifecycleStatus: true },
              // Every worker, newest first — NOT limit 1. The gate asks whether
              // ANY worker holds an open PR, the same read the list and the
              // claim route make; the newest alone hid an older open PR.
              orderBy: [desc(workers.createdAt), desc(workers.id)],
            },
          },
        })
      : Promise.resolve([]),
    // Workers for this task
    db.query.workers.findMany({
      where: eq(workers.taskId, id),
      orderBy: [desc(workers.createdAt), desc(workers.id)],
      with: { account: { columns: { name: true } } },
    }),
    // Mission context bar (W6): the mission row and its tasks' light columns —
    // the same selection a Home card makes, so no result/context/artifact
    // content — fed through the builders every mission surface shares.
    task.missionId
      ? db.query.missions.findFirst({
          where: eq(missions.id, task.missionId),
          columns: {
            id: true, title: true, status: true, orchestrationMode: true, dependsOnMissionId: true,
            dependencyMetAt: true, criteriaEscalatedAt: true, isHeld: true, executor: true, startAt: true,
            goalCriteria: true, goalCriteriaState: true, completedAt: true, workingBranch: true,
            integrationBranchEnabled: true, mergePolicy: true, requiresReview: true,
          },
          with: {
            tasks: {
              columns: MISSION_CARD_TASK_COLUMNS,
              with: { workers: MISSION_CARD_WORKERS_WITH },
            },
            schedule: { columns: { id: true, nextRunAt: true, lastRunAt: true, cronExpression: true, lastDeferralReason: true, lastDeferredAt: true, maxConcurrentFromSchedule: true } },
          },
        })
      : Promise.resolve(null),
  ]);
  const failedExcerpt = truncateExcerpt(taskWorkers[0]?.error);
  const taskBackend = (task.backend as 'claude' | 'codex' | null) ?? null;
  // S35: the mission's failed deliverables read through the kernel, as its card does.
  const missionContextDeliveryViews = missionContextRow
    ? await getDeliveryViewsForTasks(missionContextDeliveryTaskIds(missionContextRow as unknown as MissionCardRow))
    : null;
  const missionContextBar: MissionContextBarData | null = missionContextBarFor(
    missionContextRow as unknown as MissionCardRow | null,
    task.id,
    missionContextDeliveryViews,
  );

  // Read-through PR fact import: if the latest worker is completed with an
  // open PR, check GitHub in case the merged webhook was missed. Enqueued after
  // the response, never written during the render (spec workflow-state-kernel
  // §11): this render shows what is stored, the next one what the import found.
  if (task.status === 'completed' && task.workspaceId) {
    const latestWorker = taskWorkers[0];
    if (latestWorker?.prNumber && !latestWorker?.mergedAt && latestWorker?.prUrl) {
      const wsWithInstall = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, task.workspaceId),
        columns: {},
        with: { githubInstallation: { columns: { installationId: true } } },
      });
      const installId = wsWithInstall?.githubInstallation?.installationId;
      if (installId) {
        const stale = { id: latestWorker.id, prNumber: latestWorker.prNumber, prUrl: latestWorker.prUrl };
        after(() => refreshWorkerMergeStateIfStale(stale, installId).catch((err) =>
          console.error('[task-page] PR fact import failed (non-fatal):', err)));
      }
    }
  }

  // Artifacts, error traces and ship state are mutually independent — one wait
  // instead of three. The release *label* genuinely follows the ship-state
  // resolver (it needs the release id it returns), so it stays chained inside
  // that entry rather than becoming a fourth serial step.
  const workerIds = taskWorkers.map(w => w.id);
  // Latest / live / PR worker by (createdAt, id), never by row position: two
  // workers created in the same instant must not trade places between renders.
  const workerPicks = selectTaskWorkers(taskWorkers, isLiveWorkerStatus);
  const prWorker = workerPicks.prWorker ?? null;
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
  const runnerReachLoad = task.status === 'pending' && missionExecutorOf(missionContextRow) !== 'local' && task.workspace
    ? Promise.all([
        loadRunnerReachDiagnosis({
          id: task.workspace.id,
          teamId: task.workspace.teamId,
          accessMode: task.workspace.accessMode,
        }),
        getTeamPermissionOverrides(access.teamId),
      ])
        .then(([diagnosis, overrides]) => diagnosis ? { diagnosis, canFix: canAdministerTeamKeys(access.role, overrides) } : null)
        .catch(() => null)
    : Promise.resolve(null);
  // Cloud runs only: its time on the hosted runner, all attempts. Started
  // here, awaited below, so it adds no round trip of its own.
  const hostedRunnerUsagePromise = taskHostedRunnerUsage(id).catch(() => null);
  const [evidenceReview, evidenceArtifactCount, taskArtifacts, errorTraces, ship, teamTimezone, roleRow, ciAttemptRows, dependentTasks, runnerHeartbeats, auditVisual, evidenceFiles, openAttempt, runnerReachRaw, accessItems, failureKindRaw] = await Promise.all([
    prWorker?.prNumber ? RUN_PROGRESS_READERS.review({ workspaceId: task.workspaceId, prNumber: prWorker.prNumber }).catch(() => null) : Promise.resolve(null),
    taskWorkers.find(w => isLiveWorkerStatus(w.status)) ? getWorkerDeliverableArtifactCount(taskWorkers.find(w => isLiveWorkerStatus(w.status))!.id) : Promise.resolve(0),
    // Artifacts for all workers on this task
    workerIds.length > 0
      ? db.query.artifacts.findMany({ where: inArray(artifacts.workerId, workerIds) })
      : Promise.resolve([]),
    // Agent error traces (pattern-matched failures from tool output).
    // Captured by the runner's error-trace-scanner — see apps/runner/src/error-trace-scanner.ts.
    // Cap to most recent 50 here; full list available via /api/tasks/[id]/error-traces.
    db.query.workerErrorTraces.findMany({
      where: eq(workerErrorTraces.taskId, id),
      orderBy: [desc(workerErrorTraces.ts)],
      limit: 50,
    }),
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
    getTeamTimezoneSetting((task.workspace as any)?.teamId as string | undefined),
    // Role name/colour come from the workspace's role row, never a local map.
    findTaskRole({ workspaceId: task.workspaceId, teamId: (task.workspace as any)?.teamId, slug: task.roleSlug }),
    // CI-retry attempts at this task's PR: each is a fresh worker handed the
    // failure excerpt, on the same branch. They make "How it landed".
    prWorker?.prNumber
      ? db.query.tasks.findMany({
          where: and(eq(tasks.parentTaskId, id), eq(tasks.ciRetryPrNumber, prWorker.prNumber), isNotNull(tasks.ciRetryHeadSha)),
          columns: { id: true, status: true, createdAt: true, ciRetryHeadSha: true, context: true, result: true },
          with: {
            // Full rows, same shape as taskWorkers: Worker history lists them.
            workers: {
              orderBy: [desc(workers.createdAt), desc(workers.id)],
              with: { account: { columns: { name: true } } },
            },
          },
          orderBy: [asc(tasks.createdAt), asc(tasks.id)],
        })
      : Promise.resolve([]),
    // What this task unblocks, once it has landed.
    task.status === 'completed'
      ? db.query.tasks.findMany({
          where: and(eq(tasks.workspaceId, task.workspaceId), sql`${tasks.dependsOn} @> ${JSON.stringify([id])}::jsonb`),
          columns: { id: true, title: true, label: true, status: true },
          limit: 6,
        })
      : Promise.resolve([]),
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
    // The canonical "is a fix attempt open on this task" fact — same
    // predicate explain.ts and Home's action queue use (mission-state-view.ts
    // rule 6½). Joined onto this group, not a fifth serial step.
    prWorker?.prUrl && prWorker.prNumber && prWorker.prLifecycleStatus !== 'closed'
      ? loadOpenAttempt(task.id)
      : Promise.resolve(null),
    runnerReachLoad,
    // What this task's runs were given and refused (agent_capability_decisions).
    // A read failure hides the section; it never fails the page.
    loadTaskAccess(id).catch(() => []),
    // Worker vs verification failure. Costs no query unless the task failed;
    // joined here rather than awaited after the phase is derived.
    loadTaskFailureKind({ id: task.id, title: task.title, status: task.status, missionId: task.missionId ?? null }).catch(() => null),
  ]);
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
  // doc authorized this task, written by approvePlan onto every child of an
  // emitsPlan-originated plan. Absent on ordinary tasks.
  const specSourceRaw = (task.context as Record<string, unknown> | null)?.specSource as
    | Partial<SpecSourceContext>
    | undefined;
  const specSource: SpecSourceContext | null =
    specSourceRaw && typeof specSourceRaw.specPath === 'string' && typeof specSourceRaw.planningTaskId === 'string'
      ? { specPath: specSourceRaw.specPath, planningTaskId: specSourceRaw.planningTaskId }
      : null;

  const deliverableArtifacts = taskArtifacts.filter(
    a => a.type !== 'impl_plan'
  );

  // A completed task leads with "What shipped"; its raw handoff moves behind
  // the Technical summary disclosure instead of the Deliverables block.
  const leadsWithShipped = task.status === 'completed' && task.mode !== 'planning';

  // Dedupe: find if exactly one summary-type artifact duplicates result.summary
  const resultSummary = (task.result as any)?.summary as string | undefined;
  const summaryArtifacts = deliverableArtifacts.filter(a => a.type === 'summary');
  const suppressedSummaryArtifact =
    !leadsWithShipped && resultSummary && summaryArtifacts.length === 1 && isSummaryDuplicate(summaryArtifacts[0].content, resultSummary)
      ? summaryArtifacts[0]
      : null;
  const visibleArtifacts = suppressedSummaryArtifact
    ? deliverableArtifacts.filter(a => a.id !== suppressedSummaryArtifact.id)
    : deliverableArtifacts;
  // D9: when the description is the deliverable summary itself, the summary
  // (under Deliverables) is printed once and the description is not.
  const descriptionIsSummary = descriptionDuplicatesSummary(task.description, resultSummary);

  // D9: this task's children split into genuine subtasks and attempts at it
  // (reviewer passes, retries) — the latter are never listed as subtasks.
  const childTasks = partitionChildTasks(task.subTasks ?? []);
  const isAttempt = isAttemptTask(task);

  // Fetch execution plan chain: siblings (if child) or children (if parent)
  const planParentId = task.parentTaskId ?? (task.subTasks?.length ? task.id : null);
  type ChainTask = {
    id: string; title: string; status: string; roleSlug: string | null;
    taskClass: string | null; roleInferred: boolean;
    worker: {
      prUrl: string | null; prNumber: number | null; turns: number; branch: string;
      status: string; mergedAt: Date | null; prLifecycleStatus: string | null; runner: string | null;
    } | null;
    artifacts: Array<{ id: string; type: string; title: string | null }>;
  };
  let planChain: ChainTask[] = [];
  let roleMap = new Map<string, { name: string; color: string }>();
  // The eyebrow names a running task's runner only when the team has more than
  // one online (lib/task-eyebrow.ts) — with one runner it says nothing new.
  let planOnlineRunners = 0;

  if (planParentId) {
    const chainBase = await db.query.tasks.findMany({
      where: eq(tasks.parentTaskId, planParentId),
      columns: { id: true, title: true, status: true, roleSlug: true, taskClass: true, mode: true, parentTaskId: true, context: true },
      orderBy: [asc(tasks.createdAt), asc(tasks.id)],
    });

    if (chainBase.length > 0) {
      // If current task is a child, prepend the parent to the chain
      let chainTasksToFetch = chainBase;
      if (task.parentTaskId && task.parentTask) {
        chainTasksToFetch = [
          { id: task.parentTaskId, title: task.parentTask.title, status: task.parentTask.status, roleSlug: task.parentTask.roleSlug, taskClass: task.parentTask.taskClass, mode: task.parentTask.mode, parentTaskId: task.parentTask.parentTaskId, context: task.parentTask.context },
          ...chainBase
        ];
      }
      // D9: a reviewer pass or a retry is an attempt at its parent, never a
      // step of an execution plan — and an attempt's page shows no plan.
      chainTasksToFetch = selectExecutionPlan(task, chainTasksToFetch);

      const chainIds = chainTasksToFetch.map(t => t.id);

      const chainWorkers = chainIds.length > 0
        ? await db.query.workers.findMany({
            where: inArray(workers.taskId, chainIds),
            columns: { id: true, taskId: true, prUrl: true, prNumber: true, turns: true, branch: true, status: true, mergedAt: true, prLifecycleStatus: true, runner: true, localUiUrl: true },
            orderBy: [desc(workers.createdAt), desc(workers.id)],
          })
        : [];
      const latestWorker = new Map<string, typeof chainWorkers[0]>();
      for (const w of chainWorkers) {
        if (w.taskId && !latestWorker.has(w.taskId)) latestWorker.set(w.taskId, w);
      }

      const chainWorkerIds = [...latestWorker.values()].map(w => w.id);
      const chainArts = chainWorkerIds.length > 0
        ? await db.query.artifacts.findMany({
            where: and(inArray(artifacts.workerId, chainWorkerIds), ne(artifacts.type, 'impl_plan')),
            columns: { id: true, workerId: true, type: true, title: true },
          })
        : [];
      const artsByWorker = new Map<string, typeof chainArts>();
      for (const a of chainArts) {
        if (!a.workerId) continue;
        if (!artsByWorker.has(a.workerId)) artsByWorker.set(a.workerId, []);
        artsByWorker.get(a.workerId)!.push(a);
      }

      planChain = chainTasksToFetch.map(({ context, ...t }) => {
        const w = latestWorker.get(t.id) ?? null;
        return {
          ...t,
          taskClass: t.taskClass ?? null,
          roleInferred: (context as Record<string, unknown> | null)?.roleInferred != null,
          worker: w ? {
            prUrl: w.prUrl, prNumber: w.prNumber, turns: w.turns, branch: w.branch,
            status: w.status, mergedAt: w.mergedAt, prLifecycleStatus: w.prLifecycleStatus,
            runner: resolveRunnerDisplay(w)?.name ?? null,
          } : null,
          artifacts: w ? (artsByWorker.get(w.id) ?? []) : [],
        };
      });

      // A chain of one is no plan: only this task (a self-loop), or only some
      // other task (a friction report this run filed) shown as if it were.
      if (!isMeaningfulPlan(planChain)) {
        planChain = [];
      }

      const slugs = [...new Set(planChain.map(t => t.roleSlug).filter(Boolean))] as string[];
      if (slugs.length > 0) {
        const roles = await db.query.workspaceSkills.findMany({
          where: and(
            eq(workspaceSkills.workspaceId, task.workspaceId),
            eq(workspaceSkills.isRole, true),
            inArray(workspaceSkills.slug, slugs),
          ),
          columns: { slug: true, name: true, color: true },
        });
        roles.forEach(r => roleMap.set(r.slug, { name: r.name, color: r.color }));
      }

      const teamId = (task.workspace as { teamId?: string } | null)?.teamId;
      if (teamId && planChain.some(t => isLiveWorkerStatus(t.worker?.status))) {
        const now = Date.now();
        const hbs = await getRunnerHeartbeats(teamId, [task.workspaceId]).catch(() => []);
        planOnlineRunners = hbs.filter(hb => isRunnerOnline(hb.lastHeartbeatAt, now)).length;
      }
    }
  }

  // Never revive an ended worker merely because it retained a question.
  const activeWorkerRow = !isTerminalTaskStatus(task.status)
    ? workerPicks.activeWorker : undefined;
  const activeWorker = activeWorkerRow?.waitingFor && !isOpenAsk(task.status, activeWorkerRow.status)
    ? { ...activeWorkerRow, waitingFor: null } : activeWorkerRow;

  const openQuestionCount = openQuestionRows.filter(n => isOpenQuestionNote(n, task.status, activeWorker)).length;

  // A kernel-owned delivery's header reads the kernel's DeliveryView, not the
  // raw task/worker columns below (workflow-state-kernel §17.5). Legacy-owned
  // or PR-less tasks get null and keep today's status.
  const deliveryView = (await getDeliveryViewsForTasks([task.id])).get(task.id) ?? null;
  const deliveryPill: DeliveryPillState | null = deliveryView
    ? { headline: deliveryView.headline, owner: deliveryView.owner, needsYou: deliveryView.needsYou, stage: deliveryView.stage, detail: deliveryView.detail, prState: deliveryView.prState, state: deliveryView.state }
    : null;

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
    prMerged: !!(prWorker && (prWorker.mergedAt || prWorker.prLifecycleStatus === 'merged')),
    prClosed: prWorker?.prLifecycleStatus === 'closed',
    attemptStatuses: ciAttemptTasks.map(t => t.status),
  });

  const initiative = task.mission?.initiative ?? null;


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
    !taskWorkers[0]?.mergedAt &&
    taskWorkers[0]?.prLifecycleStatus !== 'closed'
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
  const failureKind = phase === 'failed' ? failureKindRaw : null;
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
  const headerLifecycle = headerLifecycleState(deliveryView?.stage);
  const heading = taskHeading({ title: task.title, label: (task as { label?: string | null }).label ?? null }, roleName);
  const questionNote = activeWorker?.waitingFor ? linkQuestionNote(openQuestionRows, activeWorker.id) : null;


  let prOutcome: PrOutcome | null = null;
  if (prWorker) {
    const firstAttempt = {
      runner: runnerLabel(prWorker),
      roleName,
      commits: prWorker.commitCount ?? 0,
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
        commits: w.commitCount ?? 0,
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
      pr: { lifecycle: prWorker.prLifecycleStatus ?? null, mergedAt: prWorker.mergedAt?.getTime() ?? null },
    });
    prOutcome = {
      repoLabel: task.workspace?.repo ? normalizeRepoFullName(task.workspace.repo) : null,
      summary: ((task.result as { summary?: string } | null)?.summary) ?? null,
      totals: lineage.totals,
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
  const storedVerdictDecision = parseStoredVerdictDecision((task as { verdictDecision?: unknown }).verdictDecision);
  const rulesVerdict = deriveTaskVerdict(buildVerdictInput({
    task: { status: task.status, mode: task.mode, result: task.result },
    workers: taskWorkers,
    ciAttempts: ciAttemptTasks,
    openAttempt,
    openQuestion: openQuestionCount > 0,
    inRelease: !!shippedRelease,
    // §17.5: a kernel-owned PR's state is the delivery's, not the columns'.
    deliveryPrState: deliveryView?.prState ?? null,
  }));
  const verdict = rulesVerdict ? applyVerdictDecision(rulesVerdict, storedVerdictDecision) : null;
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
  // Attempts the PR history already tells are not listed again under Related tasks.
  const relatedAttempts = attemptsNotInPrHistory(
    childTasks.attempts,
    new Set(prOutcome ? ciAttemptTasks.filter(t => t.workers.length > 0).map(t => t.id) : []),
  );
  const hasRelatedTasks = !!task.parentTask || childTasks.subtasks.length > 0 || relatedAttempts.length > 0;
  // Every worker on this task's PR, the CI-fix attempts' included.
  const workerHistory = lineageWorkerHistory(taskWorkers, ciAttemptTasks);
  const factRows: FactRow[] = [
    ...(prOutcome && prWorker && isTerminal
      ? [{
          key: 'pr',
          label: 'PR',
          value: (
            <a href={prWorker.prUrl!} target="_blank" rel="noopener noreferrer" className="hover:underline">
              <span className="text-accent-text">#{prWorker.prNumber}</span>
              <span className="text-text-muted"> · {(prWorker.mergedAt ? 'merged' : prWorker.prLifecycleStatus ?? 'open').replace(/_/g, ' ')}</span>
            </a>
          ),
        }]
      : []),
    // Completed: workers and scope live in Run details, not here as well.
    ...(prOutcome && ciAttemptWorkers.length > 0 && prWorker && !shippedViewShown
      ? [{
          key: 'workers',
          label: 'Workers',
          value: (
            <ul>
              {[prWorker, ...ciAttemptWorkers].map((w, i) => (
                // One line each: the runner, then its attempt number. "(retry)"
                // is what "attempt 2" already says, and it wrapped on its own.
                <li key={w.id} className="flex min-w-0 min-h-11 md:min-h-0 items-center md:items-baseline gap-2">
                  <span className="min-w-0 truncate">{runnerLabel(w)}</span>
                  <span className="shrink-0 whitespace-nowrap text-text-muted">attempt {i + 1}</span>
                </li>
              ))}
            </ul>
          ),
        }]
      : factWorker && !shippedViewShown
        ? [{ key: 'runner', label: 'Runner', value: runnerLabel(factWorker) }]
        : []),
    ...(factWorker?.branch && !(prOutcome && isTerminal)
      ? [{ key: 'branch', label: 'Branch', value: <span className="block truncate" title={factWorker.branch}>{factWorker.branch}</span> }]
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
                    <Link href={taskPageHref({ taskId: dep.id })} className="min-w-0 truncate hover:underline" title={dep.title}>{displayTaskTitle(dep.title)}</Link>
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
                  Shipped in <Link href={origin.shipped.href} className="text-status-success hover:underline">{origin.shipped.label}</Link>
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
    heroShots: pickHeroShots(undefined, buildHeroPool(toVisualShots(taskArtifacts))),
  });
  const hostedRunnerUsage = await hostedRunnerUsagePromise;
  const runDetails: RunDetail[] = [];
  if (shippedView) {
    const runWorkers = workerHistory.map(h => h.worker);
    const runners = [...new Set(runWorkers.map(w => runnerLabel(w)).filter((n): n is string => !!n))];
    if (runners.length > 0) runDetails.push({ label: 'Runner', value: runners.join(', ') });
    if (runWorkers.length > 1) runDetails.push({ label: 'Attempts', value: String(runWorkers.length) });
    const turns = runWorkers.reduce((n, w) => n + (w.turns ?? 0), 0);
    if (turns > 0) runDetails.push({ label: 'Turns', value: String(turns) });
    const starts = runWorkers.map(w => w.startedAt?.getTime()).filter((t): t is number => t != null);
    const ends = runWorkers.map(w => w.completedAt?.getTime()).filter((t): t is number => t != null);
    if (starts.length > 0 && ends.length > 0) {
      runDetails.push({ label: 'Took', value: formatElapsed(Math.max(...ends) - Math.min(...starts)) });
    }
    const cost = runWorkers.reduce((n, w) => n + parseFloat(w.costUsd?.toString() || '0'), 0);
    const tokens = runWorkers.reduce((n, w) => n + (w.inputTokens || 0) + (w.outputTokens || 0), 0);
    if (cost > 0) runDetails.push({ label: 'Spend', value: `$${cost.toFixed(2)}` });
    else if (tokens > 0) runDetails.push({ label: 'Tokens', value: tokens.toLocaleString() });
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
              Worker History
            </div>
            <div className="border border-border-default overflow-hidden">
              {workerHistory.map(({ worker, attemptLabel }) => {
                const iconStyle = TASK_ICONS[worker.status] || DEFAULT_ICON;
                const bookkeepingRetry = bookkeepingAttemptRetry(worker, task);
                if (bookkeepingRetry) {
                  const shownError = plainWorkerError(worker.error, taskBackend);
                  return (
                    <BookkeepingAttemptRow key={worker.id} workerId={worker.id} retry={bookkeepingRetry} attemptLabel={attemptLabel}>
                      <p>Runner: {runnerLabel(worker) ?? worker.name}{worker.account && ` \u00B7 ${worker.account.name}`}</p>
                      <p className="font-mono">Branch: <span title={worker.branch}>{displayBranchName(worker.branch)}</span></p>
                      {shownError && <p className="font-mono" title={shownError.raw}>{shownError.text}</p>}
                      <p className="font-mono">Worker {worker.id} · {worker.turns} turns</p>
                    </BookkeepingAttemptRow>
                  );
                }
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
                          {worker.continuationTaskId ? (
                            <a href={taskPageHref({ taskId: worker.continuationTaskId, missionId: task.missionId })} className="text-status-info hover:underline">
                              Continued in a new task →
                            </a>
                          ) : (
                            'Continuation task not recorded.'
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
  const planChainView = planChain.length > 0 ? (
    <PlanChainView
      currentTaskId={id}
      tasks={planChain}
      roleMap={Object.fromEntries(roleMap)}
      onlineRunners={planOnlineRunners}
    />
  ) : null;

  return (
    <DisplayTimezoneProvider teamTimezone={teamTimezone}>
    <div className="p-4 md:p-8 overflow-x-hidden overflow-y-auto h-full">
      <div className="max-w-[1384px] w-full">
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

        {/* Mission context (W6): for a mission task, the sticky micro masthead
            replaces the breadcrumb — up to the task's row (#t-), the pulse
            ringed on this task, n / N · PHASE and ‹ › to its siblings. */}
        {missionContextBar ? (
          <MissionContextBar bar={missionContextBar} />
        ) : (
          // Back only: the title is the h1 right below.
          <nav aria-label="Breadcrumb" className="text-sm text-text-secondary mb-2">
            <Link
              href={task.mission ? missionTaskHref({ missionId: task.mission.id, taskId: task.id, mode: 'focus' }) : '/app/tasks'}
              data-testid="task-back"
              className="inline-flex min-h-11 items-center hover:text-text-primary"
            >
              ‹ {task.mission ? task.mission.title : 'Activity'}
            </Link>
          </nav>
        )}

        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_336px] lg:gap-9 lg:items-start">
        <div className="min-w-0" data-testid="task-main">
        {/* Header — eyebrow (type · scope · role), the subject as the title, and
            one status pill with the admin actions behind ⋯ (D9). Chips that
            used to crowd the title line sit on the quiet meta line below. */}
        <div className="mb-5 md:mb-6" data-testid="task-header">
          <div className="flex flex-col-reverse md:flex-row md:items-start md:justify-between gap-3 md:gap-4">
            {shippedView ? (
              <div className="min-w-0 flex-1">
                <TaskShippedTitle view={shippedView} title={heading.heading} />
              </div>
            ) : (
            <div className="min-w-0 flex-1">
              <h1 className="text-[22px] md:text-[24px] font-semibold leading-snug tracking-[-0.2px] break-words max-w-[760px]">{heading.heading}</h1>
            </div>
            )}
            <div className={`flex items-center gap-2 shrink-0 md:mt-0.5 ${shippedView ? 'justify-end' : 'justify-between md:justify-start'}`}>
              {/* With a verdict, the verdict block carries the state (and this hook). */}
              {!shippedView && !verdict && (
                <span data-testid="task-header-status" data-status={displayStatus}>
                  <HeaderStatusPill
                    status={displayStatus}
                    merged={!!(prWorker && (prWorker.mergedAt || prWorker.prLifecycleStatus === 'merged')) && isTerminal}
                    delivery={deliveryPill}
                  />
                </span>
              )}
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
          </div>
          {/* One mono sub-line: type · scope · role, the workspace, loop and ship
              state, the PR. Created, category, project and the error count live
              in Details and the evidence below, not here. */}
          <div data-testid="task-subline" className="mt-2 flex items-center gap-x-2 gap-y-1.5 flex-wrap text-[12px] text-text-muted font-mono">
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
              />
            )}
            <TaskShipBadge release={task.release} shippedReleaseId={shippedRelease?.releaseId ?? null} />
            {workerWithPr && !prOutcome && (
              <a
                href={workerWithPr.prUrl!}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-accent-text hover:underline font-medium"
              >
                PR #{workerWithPr.prNumber} ↗
              </a>
            )}
          </div>
          {/* The one track. A live run's own view leads with it, so it is drawn here only between runs. */}
          {headerLifecycle && !activeWorker && <Lifecycle state={headerLifecycle} className="mt-3" />}
        </div>

        {/* Action first (W6): the phase's one decision, before anything to read.
            The task sheet's own TaskActionZone, for a start and a failure alike,
            so the sheet, this page and the mission drawer cannot offer
            different things. The page alone adds runner targeting. An open
            question is answered in the live worker view below
            (worker-needs-input-banner), which leads the list on mobile. */}
        {verdict && (
          <TaskVerdictBlock verdict={verdict} decision={storedVerdictDecision} displayStatus={displayStatus} showDecisionRows={isPlatformOperator(user)} />
        )}

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
              failureKind={failureKind}
              auditTaskId={auditTaskIdFor(task, failureKind)}
              lastError={failedExcerpt ? { excerpt: failedExcerpt, raw: taskWorkers[0]?.error ?? null } : null}
              worker={null}
              roleSlug={task.roleSlug}
              missionExecutor={missionExecutorOf(missionContextRow)}
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

        {shippedView && <TaskShippedBody view={shippedView} />}

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
                Blocked by {unresolvedDeps.length} {unresolvedDeps.length === 1 ? 'dependency' : 'dependencies'}
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
                        {displayTaskTitle(dep.title)}
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
              Mission budget spent. No worker can claim this task.
            </div>
            <p className="text-[12px] text-text-secondary ml-6">
              Every task in{' '}
              {task.mission ? (
                <Link href={missionTaskHref({ missionId: task.mission.id, taskId: task.id, mode: 'focus' })} className="text-accent-text hover:underline">
                  {task.mission.title}
                </Link>
              ) : 'this mission'}{' '}
              is on hold. Raise the mission budget to release them, or force-start this task.
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
        {task.loopConfig && (
          <LoopHistory
            entries={Array.isArray((task.result as Record<string, unknown> | null)?.loopHistory)
              ? (task.result as Record<string, unknown>).loopHistory as LoopHistoryEntry[]
              : Array.isArray((task.context as Record<string, unknown> | null)?.loopHistory)
                ? (task.context as Record<string, unknown>).loopHistory as LoopHistoryEntry[]
                : []}
            loopState={task.loopState}
            maxLoops={task.loopConfig.maxLoops ?? 5}
          />
        )}

        <TaskEvidenceCard status={task.status} result={task.result} workerError={taskWorkers[0]?.error ?? null} backend={taskBackend} failingChecks={verdict?.failingChecks ?? []} />

        {/* A completed task keeps its evidence files in Run details. */}
        {!shippedView && evidenceFilesSection}

        {/* Agent errors: every captured trace, sorted by what it means for the
            outcome (needs attention / unclear / recovered / exploration noise).
            Any row opens the complete redacted evidence. */}
        <TaskErrorEvidence items={errorEvidenceItems} taskTitle={displayTaskTitle(task.title)} terminalSucceeded={terminalSucceeded} taskState={verdict?.headline ?? null} />

        {/* Execution Plan Chain (replaces Related Tasks when chain data available) */}
        {planChain.length > 0 ? (
          !shippedView && planChainView
        ) : hasRelatedTasks && (
          <div className="mb-6">
            <div className="section-label pb-2 border-b border-border-default mb-4">
              Related Tasks
            </div>
            <div className="card p-4 space-y-3">
              {task.parentTask && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="w-full md:w-auto text-meta text-text-muted">{isAttempt ? 'Attempt at:' : 'Parent:'}</span>
                  <Link
                    href={taskPageHref({ taskId: task.parentTask.id, missionId: task.missionId })}
                    className="min-w-0 text-sm text-primary-400 hover:underline [overflow-wrap:anywhere]"
                  >
                    {displayTaskTitle(task.parentTask.title)}
                  </Link>
                  <StatusPill status={deriveDisplayStatus(task.parentTask.status)} />
                </div>
              )}
              {([
                ['Subtasks', childTasks.subtasks],
                ['Attempts', relatedAttempts],
              ] as const).map(([label, list]) => list.length > 0 && (
                <div key={label} data-testid={`task-related-${label.toLowerCase()}`}>
                  <span className="text-meta text-text-muted">{label} ({list.length}):</span>
                  <div className="mt-2 space-y-1 ml-2 md:ml-4">
                    {list.map((sub) => (
                      <div key={sub.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <Link
                          href={taskPageHref({ taskId: sub.id, missionId: task.missionId })}
                          className="min-w-0 text-sm text-primary-400 hover:underline [overflow-wrap:anywhere]"
                        >
                          {displayTaskTitle(sub.title)}
                        </Link>
                        <StatusPill status={deriveDisplayStatus(sub.status)} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

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

        {/* Active Worker — the hero: the Now strip while it runs, the question
            while it waits. First in the column at every width. */}
        {activeWorker && (
          <div className="mb-8 order-first" data-testid="task-active-worker">
            <RealTimeWorkerView
              delivery={deliveryPill}
              outputRequirement={task.outputRequirement}
              deliverableArtifactCount={evidenceArtifactCount}
              usesReviewer={RUN_PROGRESS_READERS.usesReviewer(task.workspace, missionContextRow, task, { baseRef: activeWorker.prBaseRef })}
              reviewState={evidenceReview?.state}
              taskStatus={task.status}
              taskId={task.id}
              initialWorker={{
                id: activeWorker.id,
                name: activeWorker.name,
                branch: activeWorker.branch,
                status: activeWorker.status,
                currentAction: activeWorker.currentAction,
                milestones: (activeWorker.milestones as any[]) || [],
                turns: activeWorker.turns,
                costUsd: activeWorker.costUsd?.toString() || null,
                inputTokens: activeWorker.inputTokens,
                outputTokens: activeWorker.outputTokens,
                createdAt: activeWorker.createdAt?.toISOString() || null,
                mergedAt: activeWorker.mergedAt?.toISOString() || null,
                dirtyWorktree: activeWorker.dirtyWorktree,
                observedTouches: activeWorker.observedTouches,
                prIsDraft: activeWorker.prIsDraft,
                startedAt: activeWorker.startedAt?.toISOString() || null,
                prUrl: activeWorker.prUrl,
                prNumber: activeWorker.prNumber,
                prLifecycleStatus: activeWorker.prLifecycleStatus,
                localUiUrl: null,
                commitCount: activeWorker.commitCount,
                filesChanged: activeWorker.filesChanged,
                linesAdded: activeWorker.linesAdded,
                linesRemoved: activeWorker.linesRemoved,
                lastCommitSha: activeWorker.lastCommitSha,
                waitingFor: activeWorker.waitingFor as any,
                error: activeWorker.error,
                instructionHistory: (activeWorker.instructionHistory as any[]) || [],
                pendingInstructions: activeWorker.pendingInstructions,
                updatedAt: activeWorker.updatedAt?.toISOString() || null,
                resultMeta: activeWorker.resultMeta as any,
              }}
              modelTier={modelSummary.tierLabel}
              questionNote={questionNote}
              roleName={roleName}
            />
          </div>
        )}

        {/* PR outcome — the diff split by attempt, "How it landed" (attempt →
            CI → retry → merge) and checks per commit (AC-4). Shown for an open
            PR and for one that landed. */}
        {(() => {
          if (!prWorker?.prUrl || !prWorker.prNumber) return null;
          const prState = resolvePrDisplayState({ delivery: deliveryView, prLifecycleStatus: prWorker.prLifecycleStatus, mergedAt: prWorker.mergedAt });
          if (prState === 'closed') return null;
          const storedPrFacts = {
            prUrl: prWorker.prUrl,
            prNumber: prWorker.prNumber,
            prLifecycleStatus: prWorker.mergedAt ? 'merged' : prWorker.prLifecycleStatus,
            prState,
            linesAdded: prWorker.linesAdded,
            linesRemoved: prWorker.linesRemoved,
            filesChanged: prWorker.filesChanged,
            // The header carries the summary and the one action.
            outcome: prOutcome && shippedView ? { ...prOutcome, summary: null } : prOutcome,
            hideAction: !!shippedView,
            openAttempt,
          };
          return (
            <div className={`mb-10 ${activeWorker ? '' : 'order-first'}`} data-testid="task-pr-section">
              {/* The GitHub-derived half of this card (CI runs, reviews,
                  mergeability) is several REST calls, so it streams in behind
                  a boundary instead of holding the whole page. The fallback is
                  the same card rendered from stored state, so the PR is
                  readable and linkable on first paint. */}
              <Suspense fallback={<StoredPrCard {...storedPrFacts} />}>
                <PrDetailsCard workspaceId={task.workspaceId} {...storedPrFacts} />
              </Suspense>
            </div>
          );
        })()}

        </div>{/* end flex container */}

        {/* Completed: the raw handoff and everything about the run (workers,
            scope, evidence files, plan), each collapsed, after the outcome. */}
        {shippedView && (
          <div className="mb-8">
            <TaskShippedDetails
              view={shippedView}
              runDetails={runDetails}
              structuredOutput={shippedResult?.structuredOutput ?? null}
            >
              {workerHistorySection}
              {evidenceFiles.length > 0 && evidenceFilesSection}
              {planChainView}
            </TaskShippedDetails>
          </div>
        )}

        {/* Deliverables */}
        {(task.result as any) && !shippedView && (
          (() => {
            const result = task.result as { summary?: string; summarySource?: string; branch?: string; commits?: number; sha?: string; files?: number; added?: number; removed?: number; prUrl?: string; prNumber?: number; structuredOutput?: Record<string, unknown> };
            const hasCodeDeliverables = hasTaskCodeDeliverables(result);
            const isFallbackSummary = result.summarySource === 'fallback';
            // The PR outcome card already carries the code deliverables and summary.
            if (prOutcome && hasCodeDeliverables && !result.structuredOutput) return null;
            const fallbackChip = (
              <span className="font-mono text-chip border border-border-default rounded-[var(--radius-pill)] text-text-muted px-1 py-px shrink-0">
                unauthored · last message
              </span>
            );

            return (
              <div className="mb-8">
                <div className="section-label pb-2 border-b border-border-default mb-4">
                  Deliverables
                </div>

                {/* Non-code summary — shown prominently when no code deliverables */}
                {!hasCodeDeliverables && result.summary && (
                  <div className="p-5 bg-surface-2 border border-border-default mb-4">
                    {isFallbackSummary && <div className="mb-2">{fallbackChip}</div>}
                    <MarkdownContent content={result.summary} />
                    <div className="mt-3 pt-2 border-t border-border-default/50 flex items-center justify-between gap-3">
                      <AiFeedback entityType="summary" entityId={`task-${task.id}-summary`} />
                      {suppressedSummaryArtifact && (
                        <div className="flex items-center gap-2">
                          <ArtifactShareControl
                            artifactId={suppressedSummaryArtifact.id}
                            baseUrl={process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev'}
                            initialVisibility={(suppressedSummaryArtifact.visibility as 'private' | 'public') ?? 'private'}
                            initialShareToken={suppressedSummaryArtifact.shareToken}
                          />
                          <a
                            href={`/app/artifacts/${suppressedSummaryArtifact.id}`}
                            className="text-[11px] text-text-muted hover:text-text-secondary"
                          >
                            Open ↗
                          </a>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Code deliverables bar — the PR outcome card above carries these */}
                {hasCodeDeliverables && !prOutcome && (
                  <div className="p-4 bg-status-success/10 border border-status-success/20">
                    <div className="flex items-center gap-3 text-sm flex-wrap">
                      {result.branch && (
                        <code className="px-2 py-0.5 bg-status-success/15 text-status-success rounded text-xs">
                          {result.branch}
                        </code>
                      )}
                      {(result.commits ?? 0) > 0 && (
                        <span className="text-text-secondary text-xs">
                          {result.commits} commit{result.commits !== 1 ? 's' : ''}
                        </span>
                      )}
                      {((result.added ?? 0) > 0 || (result.removed ?? 0) > 0) && (
                        <span className="text-xs">
                          <span className="text-status-success">+{result.added}</span>
                          <span className="text-status-error">/{'-'}{result.removed}</span>
                        </span>
                      )}
                      {(result.files ?? 0) > 0 && (
                        <span className="text-xs text-text-secondary">{result.files} files</span>
                      )}
                      {result.sha && (
                        <code className="font-mono text-xs text-text-muted">{result.sha.slice(0, 7)}</code>
                      )}
                      {result.prUrl && (
                        <a
                          href={result.prUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-3 py-[5px] text-xs bg-status-success/10 text-status-success hover:bg-status-success/20"
                        >
                          PR #{result.prNumber}
                        </a>
                      )}
                    </div>
                    {result.summary && (
                      <div className="text-sm text-text-secondary mt-2">
                        {isFallbackSummary && <div className="mb-2">{fallbackChip}</div>}
                        <MarkdownContent content={result.summary} />
                        <div className="mt-2 flex justify-end">
                          <AiFeedback entityType="summary" entityId={`task-${task.id}-summary`} compact />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Structured Output */}
                {result.structuredOutput && (
                  <div className="mt-4">
                    <div className="section-label mb-2">
                      Structured Output
                    </div>
                    <pre className="p-4 bg-surface-2 border border-border-default overflow-x-auto text-sm font-mono text-text-primary">
                      {JSON.stringify(result.structuredOutput, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            );
          })()
        )}

        {/* Artifacts; an audit task's Tray shows even before its first screen
            (queued, no browser runner, boot failed, stalled), with its actions. */}
        {(visibleArtifacts.length > 0 || auditVisual) && (
          <TaskArtifactsSection
            artifacts={visibleArtifacts.map(toTaskArtifactItem)}
            taskId={task.id}
            baseUrl={process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev'}
            initialOpenArtifactId={initialOpenArtifactId}
            missionId={task.missionId ?? null}
            visual={auditVisual}
          />
        )}

        {!shippedView && workerHistorySection}

        <TaskAccessSection items={accessItems} />

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
                  Start it above, or a worker will claim it from the queue.
                </p>
              </>
            )}
          </div>
        )}
        </div>{/* end task-main */}

        {/* Side panel — steer, the facts (runner, branch, needs, scope, origin),
            the description, and the rest of the fleet. On mobile it follows the
            main column; the question or the Now strip stays the first screen. */}
        <aside data-testid="task-side-panel" className="mt-10 lg:mt-0 space-y-6 lg:sticky lg:top-4">
          {activeWorker && (
            <WorkerSteerPanel
              workerId={activeWorker.id}
              status={activeWorker.status}
              hasUnansweredQuestion={!!activeWorker.waitingFor}
              instructionHistory={(activeWorker.instructionHistory as any[]) || []}
              runner={activeWorker.runner}
              taskTerminal={isTerminal}
              earlierRun={(() => {
                // The run before this one, for the messages it ended before reading.
                const prev = workerPicks.ordered.find(w => w.id !== activeWorker.id && compareWorkersChrono(w, activeWorker) < 0);
                return prev ? { workerId: prev.id, status: prev.status, history: (prev.instructionHistory as any[]) || [] } : null;
              })()}
            />
          )}

          <FactSheet rows={factRows} />

          {/* Description — reference material, collapsed in the side panel */}
          {task.description && !descriptionIsSummary && (
            <SideDescription preview={task.description.replace(/[#*_`>\-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)}>
              <CollapsibleDescription content={task.description} />
            </SideDescription>
          )}

          <SpecSourceBlock specSource={specSource} />

          {dependentTasks.length > 0 && (
            <section data-testid="task-unblocked">
              <div className="section-label border-b border-border-default pb-2 mb-1">Unblocked by this</div>
              <ul>
                {dependentTasks.map(d => (
                  <li key={d.id} className="border-b border-border-default">
                    <Link href={taskPageHref({ taskId: d.id, missionId: task.missionId })} className="flex items-center gap-3 min-h-12 hover:bg-surface-2">
                      <span className={`w-[9px] h-[9px] shrink-0 ${d.status === 'pending' ? 'border-2 border-accent' : 'bg-accent'}`} aria-hidden="true" />
                      <span className="flex-1 min-w-0 truncate font-mono text-[13px] text-text-primary">{displayTaskTitle(d.title)}</span>
                      <span className={`shrink-0 font-mono text-[12px] ${d.status === 'completed' ? 'text-status-success' : d.status === 'pending' ? 'text-text-muted' : 'text-accent-text'}`}>
                        {d.status === 'pending' ? 'queued' : d.status === 'in_progress' || d.status === 'assigned' ? 'claimed' : d.status}
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
              <div><dt className="text-meta text-text-muted">Runner</dt><dd className="text-text-primary">{task.runnerPreference}</dd></div>
              {task.backend && <div><dt className="text-meta text-text-muted">Backend</dt><dd className="text-text-primary capitalize">{task.backend}</dd></div>}
              <TaskModelCell summary={modelSummary} />
              <div><dt className="text-meta text-text-muted">Claimed by</dt><dd className="text-text-primary truncate">{task.account?.name || '-'}</dd></div>
              <div><dt className="text-meta text-text-muted">Workers</dt><dd className="text-text-primary">{taskWorkers.length}</dd></div>
              <div><dt className="text-meta text-text-muted">Created</dt><dd className="text-text-primary"><ZonedTime value={task.createdAt} format="date" /></dd></div>
              {task.category && <div><dt className="text-meta text-text-muted">Category</dt><dd className="text-text-primary">{task.category}</dd></div>}
              {task.project && <div><dt className="text-meta text-text-muted">Project</dt><dd className="text-text-primary">{task.project}</dd></div>}
              <div className="col-span-2"><dt className="text-meta text-text-muted">Task ID</dt><dd className="text-text-primary font-mono text-[11px] break-all">{task.id}</dd></div>
            </dl>
          </details>
        </aside>
        </div>{/* end grid */}
      </div>
    </div>
    </DisplayTimezoneProvider>
  );
}

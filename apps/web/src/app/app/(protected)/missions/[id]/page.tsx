import { db } from '@buildd/core/db';
import { after } from 'next/server';
import { missions, workspaces, workspaceSkills, missionNotes, workers, tasks, initiatives, artifacts, orchestrationManifestPredictions } from '@buildd/core/db/schema';
import { eq, and, or, inArray, desc, isNotNull, isNull, ne } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, getUserWorkspaceIds } from '@/lib/team-access';
import { formatCompletionRecord, situationRepeatsCompletion } from '@/lib/mission-completion-record';
import { computeSupersededFailedTasks } from '@/lib/mission-task-superseded';
import { getDeliveryViewsForTasks, replacedFailedTaskIds } from '@/lib/workflow/delivery-view';
import { ownerDeliveryDisplays } from '@/lib/workflow/delivery-display';
import { isDeliverableTask } from '@buildd/core/mission-helpers';
import { deriveTaskHealthSignal, foreignDependencyIds, formatNextRun, selectMissionCompletionSummary, MISSION_COMPLETED_NOTE_TITLE } from '@/lib/mission-helpers';
import { computeMissionProgress, deriveMissionProgressMetric, deriveCriteriaGatePresentation, CRITERIA_GATE_TONE_CLASS, hasPendingDeliverableWork as computeHasPendingDeliverableWork, computeMissionAuthorshipHealth } from '@buildd/core/mission-helpers';
import { isSurfaceAuditTask, surfaceAuditHeadline } from '@buildd/core/surface-audit';
import { loadMissionFollowupTasks } from '@/lib/mission-followups';
import { MissionAuthorshipStats } from '@/components/MissionAuthorshipStats';
import { inferCriteriaFailureReading, describeCriteriaFailureReading } from '@/lib/criteria-rearm';
import { LIVE_WORKER_STATUSES } from '@/lib/task-presentation';
import { isOverdue as checkOverdue } from '@/lib/heartbeat-helpers';
import { describeLastCheck, selectOrganizerRuns } from '@/lib/mission-checkins';
import { isSystemWorkspace, displayWorkspaceName, type GoalCriterion, type GoalCriteriaState } from '@buildd/shared';
import { resolvePolicy } from '@/lib/merge-policy';
import { selectMissionRecords } from '@/lib/flight-strip-nav';
import MissionVerifiedPill from './MissionVerifiedPill';
import MissionOverflowMenu from './MissionOverflowMenu';
import MissionNoticeSlot, { noticeNeedsPerson } from './MissionNoticeSlot';
import { AskAboutLink } from '@/components/chat/ChatEntry';
import MissionMergePolicyRow from '@/components/MissionMergePolicyRow';
import MissionReviewSummary from './MissionReviewSummary';
import MissionInitiativeSelector, { type InitiativeOption } from './MissionInitiativeSelector';
import MissionInlineEdit from './MissionInlineEdit';
import MissionDescription from './MissionDescription';
import MissionShippedHeader from './MissionShippedHeader';
import { buildShippedHeaderView } from '@/lib/mission-shipped-header';
import { shippedArtifactKey } from '@/lib/mission-shipped-report';
import MissionAutoRefresh from './MissionAutoRefresh';
import MissionReconcileOnOpen from './MissionReconcileOnOpen';
import TaskPanelWrapper from './TaskPanelWrapper';
import { buildMissionFeedView, type MissionFeedViewTask } from './mission-feed-view';
import { pulseDoneCounts } from '@/lib/mission-pulse';
import { MISSION_DETAIL_WITH, TASK_DIGEST_SELECTION, taskDigestWhere, indexTaskDigests } from './mission-page-query';
import MissionCheckIns from './MissionCheckIns';
import HeartbeatChecklistEditor from './HeartbeatChecklistEditor';
import QuietHoursConfig from './QuietHoursConfig';
import MissionBackendSelector from './MissionBackendSelector';
import MissionMonitoringToggle from './MissionMonitoringToggle';
import ScheduleWizard from './ScheduleWizard';
import MissionConfig from './MissionConfig';
import { MissionNotesSheet } from './MissionFeed';
import { mastheadBack, parseMissionOrigin } from './MissionDetailView';
import MissionLayoutShell, { MissionBoardHeader, MissionLayoutTabs } from './MissionLayoutShell';
import FlowTimeline from './FlowTimeline';
import { expectedMinutesFromPredictions, sameFilesFromRows } from '@/lib/flow-timeline';
import MissionOverview from './MissionOverview';
import MissionFeedLayout from './MissionFeedLayout';
import { missionSummaryLine } from '@/lib/mission-summary-line';
import { buildMissionBoard, toBoardTaskInput } from '@/lib/mission-board';
import * as missionHelpers from '@buildd/core/mission-helpers';
import { missionTaskDeliveries, type MissionDeliveryTaskRow } from './mission-task-delivery';
import { loadRunnerHeartbeats } from '@/lib/runner-heartbeats';
import { loadFleetCapacity } from '@/lib/home-fleet';
import { parseMissionLayout } from '@/lib/mission-layout';
import { VISUAL_AUDITOR_ROLE_SLUG } from '@/lib/mission-visual-review';
import { loadVisualReview } from '@/lib/visual-review-load';
import type { VisualReviewModel } from '@buildd/shared';
import { MissionVisualReviewProvider } from './MissionVisualReview';
import { MissionSurfaceAuditWaiverProvider } from './MissionSurfaceAuditWaiver';
import { loadSurfaceAuditWaiver } from '@/lib/mission-surface-audit-gate';
import MissionVisualReviewSetting from './MissionVisualReviewSetting';
import MissionScreensRow from './MissionScreensRow';
import MissionRecordsSheet from './MissionRecordsSheet';
import { MissionReleaseSection } from './MissionReleaseSection';
import { buildDeliverySteps, deliveryReleaseInput, missionPrCount, missionTrunkMergedAt } from '@/lib/mission-delivery';
import { classifyReleaseState } from '@/lib/release-state';
import { taskPageHref } from '@/lib/mission-task-href';
import MissionDecisionSheet from './MissionDecisionSheet';
import { buildFileWorkHref } from '@/lib/criteria-decision-links';
import RaiseBudgetButton from './RaiseBudgetButton';
import { getMissionSpendUsd } from '@/lib/mission-budget';
import { getLinksForEntity } from '@buildd/core/external-links';
import TrackerProgressPanel from '@/components/TrackerProgressPanel';
import { resolveMissionBreadcrumb } from '@/lib/initiative-breadcrumb';
import { SwipeProvider } from '@/components/SwipeableRow';
import { DisplayTimezoneProvider } from '@/components/DisplayTimezone';
import { getTeamTimezoneSetting } from '@/lib/team-timezone';
import { refreshWorkerMergeStateIfStale } from '@/lib/pr-reconcile';
import { loadReleaseFooterData } from '@/lib/release-footer';
import { loadMissionCarryingReleaseId } from '@/lib/mission-carrying-release';
import type { WorkspaceReleaseConfig, WorkspaceGitConfig } from '@buildd/core/db/schema';
import { detectArchetype, type ReleaseArchetype } from '@buildd/core/release-archetype';
import { shouldQueryRelease } from '@/lib/release-state';
import { countOf } from '@/lib/plural';
import {
  deriveMissionIntegrationPr,
  shouldRenderMissionPrBlock,
  MISSION_PR_STATE_LABEL,
} from '@/lib/mission-integration-pr';
import { explainMission } from '@/lib/explain';
import { deriveMissionStateView } from '@/lib/mission-state-view';
import { loadDependencyRows } from '@/lib/dependency-rows';
import { resolveEffectiveRoles } from '@/lib/effective-roles';
import MissionSituationBlock, { affordanceFor, MISSION_CRITERIA_ANCHOR } from '@/components/missions/MissionSituationBlock';
import { formatEstimatedUsd, ESTIMATED_COST_TITLE } from '@/lib/cost-label';

export const dynamic = 'force-dynamic';


export default async function MissionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  // `?tab=` is retired: accepted and ignored, so old links still land.
  searchParams: Promise<{ from?: string; initiativeId?: string; artifact?: string; view?: string; layout?: string; visualReview?: string }>;
}) {
  const { id } = await params;
  const { from, initiativeId, artifact: initialOpenArtifactId, view: listViewParam, layout: layoutParam, visualReview: visualReviewParam } = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const teamIds = await getUserTeamIds(user.id);

  // S7 / AC-18: the shared shape selects no artifact `content`, task `result`
  // or task `context`; the few fields the page reads from those two JSON
  // columns arrive as a projected digest, read alongside (mission-page-query.ts).
  const [missionRow, digestRows] = await Promise.all([
    db.query.missions.findFirst({
      where: eq(missions.id, id),
      with: MISSION_DETAIL_WITH,
    }),
    db.select(TASK_DIGEST_SELECTION).from(tasks).where(taskDigestWhere(id)),
  ]);
  let mission = missionRow;
  const taskDigests = indexTaskDigests(digestRows);
  const digestOf = (taskId: string) => taskDigests.get(taskId) ?? { result: null, context: null };

  if (!mission || !teamIds.includes(mission.teamId)) {
    notFound();
  }

  // Read-through PR fact import: any completed worker whose PR merge webhook
  // was missed is re-checked against GitHub after this response.
  if (mission.workspaceId) {
    const staleWorkers = (mission.tasks ?? []).flatMap(t => {
      if (t.status !== 'completed') return [];
      const w = (t.workers as any[])?.[0];
      if (!w?.prNumber || w?.mergedAt || !w?.prUrl) return [];
      return [{ id: w.id as string, prNumber: w.prNumber as number, prUrl: w.prUrl as string }];
    });
    if (staleWorkers.length > 0) {
      const wsWithInstall = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, mission.workspaceId),
        columns: {},
        with: { githubInstallation: { columns: { installationId: true } } },
      });
      const installId = wsWithInstall?.githubInstallation?.installationId;
      if (installId) {
        // Enqueued after the response, never written during the render (spec
        // workflow-state-kernel §11): this render shows what is stored.
        after(() => Promise.all(staleWorkers.map(w => refreshWorkerMergeStateIfStale(w, installId)))
          .catch((err) => console.error('[mission-page] PR fact import failed (non-fatal):', err)));
      }
    }
  }

  // Everything from here to the merge-policy chip reads off the mission row
  // that is already in hand, and nothing in the group consumes another entry's
  // result — so it is one wait instead of five serial neon-http round trips
  // (roles/workspaces, size predictions, steering notes, policy workspace,
  // follow-ups). The derived, purely-computed values follow the group.
  const allMissionTaskIds = (mission.tasks || []).map(t => t.id);

  const [
    scopeResult,
    sizePredictions,
    humanSteeringNotes,
    workspaceForPolicy,
    missionFollowupTasks,
    runnerHeartbeats,
    fleetCapacity,
    quickAddRoles,
    visualModel,
  ] = await Promise.all([
    // Roles and workspaces for this user. getUserWorkspaceIds is React
    // cache()-wrapped, so the protected layout has normally already resolved
    // this scope and only the two reads below are new round trips.
    (async () => {
      const wsIds = await getUserWorkspaceIds(user.id);
      if (wsIds.length === 0) {
        return {
          roles: [] as { slug: string; name: string; color: string }[],
          teamWorkspaces: [] as { id: string; name: string }[],
        };
      }
      const [rolesResult, workspacesResult] = await Promise.all([
        db.query.workspaceSkills.findMany({
          where: and(
            inArray(workspaceSkills.workspaceId, wsIds),
            eq(workspaceSkills.enabled, true),
          ),
          columns: { slug: true, name: true, color: true },
          orderBy: [desc(workspaceSkills.createdAt)],
        }),
        db.query.workspaces.findMany({
          where: inArray(workspaces.teamId, teamIds),
          columns: { id: true, name: true },
        }),
      ]);
      return { roles: rolesResult, teamWorkspaces: workspacesResult };
    })(),
    // The Flow tab's expected task sizes (newest prediction per task).
    // Best-effort: without one, a task's bar uses the fixed default.
    allMissionTaskIds.length > 0
      ? db.select({ taskId: orchestrationManifestPredictions.taskId, expectedSize: orchestrationManifestPredictions.expectedSize })
          .from(orchestrationManifestPredictions)
          .where(and(inArray(orchestrationManifestPredictions.taskId, allMissionTaskIds), isNotNull(orchestrationManifestPredictions.expectedSize)))
          .orderBy(desc(orchestrationManifestPredictions.createdAt))
          .catch(() => [])
      : [],
    // Human-authored mission notes — the flight-strip steering rail's "human
    // touch" diamonds (mission-steering-events.ts). Task-scoped notes (a reply
    // or guidance posted against one task) are written with `missionId: null`
    // (apps/web/src/app/api/tasks/[id]/notes/route.ts) — a human touch on this
    // mission's work, so both arms must be read or most human steering marks
    // would silently vanish from the rail.
    allMissionTaskIds.length > 0
      ? db.query.missionNotes.findMany({
          where: and(
            or(eq(missionNotes.missionId, id), inArray(missionNotes.taskId, allMissionTaskIds)),
            eq(missionNotes.authorType, 'user'),
          ),
          columns: { id: true, authorType: true, createdAt: true },
        })
      : db.query.missionNotes.findMany({
          where: and(eq(missionNotes.missionId, id), eq(missionNotes.authorType, 'user')),
          columns: { id: true, authorType: true, createdAt: true },
        }),
    // BT-21: the workspace row behind the effective merge policy tier.
    mission.workspaceId
      ? db.query.workspaces.findFirst({
          where: eq(workspaces.id, mission.workspaceId),
          columns: { id: true, gitConfig: true },
        })
      : Promise.resolve(null),
    // Steering-cost visibility: how much of this mission a human had to write
    // directly, and how much leaked in after it was marked done. One accessor
    // computes both — see computeMissionAuthorshipHealth's docstring.
    loadMissionFollowupTasks([{
      id: mission.id,
      completedAt: (mission as any).completedAt ?? null,
      taskIds: (mission.tasks || []).map(t => t.id),
    }]),
    // Runner hostnames for the Board and Lanes (runner-display).
    loadRunnerHeartbeats((mission.tasks || []).flatMap(t => (t.workers ?? []) as Array<{ runner?: string | null; localUiUrl?: string | null; accountId?: string | null }>)),
    // The Lanes band's "LIVE n/N slots": N is the team's fleet capacity, the
    // same number Home's "AGENTS LIVE n/N" prints (not the slots drawn here).
    (async () => loadFleetCapacity({ teamId: mission.teamId ?? null, wsIds: await getUserWorkspaceIds(user.id), now: Date.now() }))()
      .catch(() => null),
    // The quick-add picker offers only roles a task in this mission's
    // workspace can carry (role-routing §1 row 3, §3.1).
    mission.workspaceId
      ? resolveEffectiveRoles(mission.workspaceId, user.id).catch(() => [])
      : Promise.resolve([]),
    // The visual review (docs/design/visual-qa-human-review.md): one loader,
    // the only read of audit shots, whenever an audit task exists (pending,
    // boot-failed and stalled ones too). It reads browser-runner heartbeats
    // itself, only when a claimable audit has waited past the window. A
    // mission with no audit skips it. A failed read hides the review rather
    // than the page.
    (mission.tasks ?? []).some(t => t.roleSlug === VISUAL_AUDITOR_ROLE_SLUG)
      ? loadVisualReview({ id: mission.id, workspaceId: mission.workspaceId ?? null }).catch((err): VisualReviewModel | null => {
          console.error('[mission-page] visual review load failed', err);
          return null;
        })
      : Promise.resolve(null as VisualReviewModel | null),
  ]);

  const { roles, teamWorkspaces } = scopeResult;

  const effectivePolicy = resolvePolicy(
    workspaceForPolicy ?? { gitConfig: null },
    { mergePolicy: (mission as any).mergePolicy ?? null },
  );
  const workspaceDefaultPolicy = resolvePolicy(workspaceForPolicy ?? { gitConfig: null });
  const hasPolicyOverride = (mission as any).mergePolicy != null;
  const policyTierLabel: Record<string, string> = {
    'auto-threshold': 'Auto',
    'agent-review': 'Agent Review',
    'human': 'Human Gate',
  };
  const policyLabel = policyTierLabel[effectivePolicy.tier] ?? effectivePolicy.tier;

  // Raw count for "View all N tasks" links — includes bookkeeping and cancelled,
  // but excludes attempt tasks (CI retries, reviewer runs) since they nest under parents.
  const allTasksCount = (mission.tasks || []).filter(t => t.taskClass !== 'attempt').length;
  // Progress uses deliverable non-cancelled tasks only so cancelled duplicates
  // don't inflate the denominator and block the mission from reaching 100%.
  const { totalTasks, awaitingMerge, segments } = computeMissionProgress(mission.tasks || []);
  // Option A′: the mission integration PR is a different object from the task
  // PRs, and no progress counter sees it — `computeMissionProgress` counts
  // deliverable tasks only, and `awaitingMerge` counts task PRs, which for an
  // opted-in mission have all merged into `mission/<slug>` while none of the
  // mission's diff is on trunk. Null for every mission that has not opted in.
  const missionIntegrationPr = deriveMissionIntegrationPr({
    mission: mission as { workingBranch?: string | null; integrationBranchEnabled?: boolean | null },
    tasks: (mission.tasks ?? []) as Array<{ id: string; title: string | null; taskClass: string | null; workers?: Array<{ prUrl?: string | null; prNumber?: number | null; mergedAt?: string | Date | null; prLifecycleStatus?: string | null }> | null }>,
  });
  const progressMetric = deriveMissionProgressMetric(mission.tasks || []);
  const progress = progressMetric.kind === 'value' ? progressMetric.value : undefined;

  const authorshipHealth = computeMissionAuthorshipHealth({
    tasks: mission.tasks || [],
    missionCreatedAt: (mission as any).createdAt,
    missionCompletedAt: (mission as any).completedAt ?? null,
    followupTasks: missionFollowupTasks.get(mission.id) ?? [],
  });
  // Invariant: PRs ≤ totalTasks when totalTasks > 0. A violation means the attempt
  // filter is still overcollapsing or the PR counter is double-counting.
  if (process.env.NODE_ENV === 'development' && totalTasks > 0) {
    const prCount = missionPrCount((mission.tasks ?? []) as Array<{ workers?: Array<{ prUrl?: string | null }> | null }>);
    if (prCount > totalTasks) {
      console.error(`[mission-invariant] mission ${id}: PRS (${prCount}) > TASKS (${totalTasks}) — check attempt-filter logic in computeMissionProgress.`);
    }
  }

  // One vocabulary for "live" on every mission surface (LIVE_WORKER_STATUSES):
  // a worker waiting on input is still a live worker.
  const liveStatuses = new Set<string>(LIVE_WORKER_STATUSES);
  const activeAgents = mission.tasks
    ?.flatMap((t) => t.workers || [])
    .filter((w) => liveStatuses.has(w.status)).length || 0;

  const scheduleCron = (mission.schedule as any)?.cronExpression || null;
  // "No pending deliverable work" for the escalated health state — same
  // definition the `no_open_tasks` criterion uses, so the state agrees with
  // the gate that produced the escalation in the first place.
  const hasPendingDeliverableWork = computeHasPendingDeliverableWork(mission.tasks || []);
  // See heartbeat-prepass.ts: recorded as `nextRunAt` while the heartbeat is
  // deliberately waiting on a known self-resolving condition — read it back so
  // the mission renders BLOCKED, not idle, while it waits.
  const heartbeatWaitingUntil = (mission.schedule as any)?.lastDeferralReason === 'heartbeat_waiting'
    ? (mission.schedule as any)?.nextRunAt ?? null
    : null;
  // Out-of-mission dependencies are loaded by id so they are judged, not guessed.
  // Same superseded rule explain uses (S35): a failed deliverable whose work
  // shipped under another task/PR, or that the kernel already replaced, must
  // not drive this fallback reading to FAILING.
  const failedDeliverableRows = (mission.tasks || []).filter((t) => isDeliverableTask(t as never) && t.status === 'failed');
  const [foreignDeps, supersededMap, deliveryViews] = await Promise.all([
    loadDependencyRows(foreignDependencyIds(mission.tasks || [])),
    computeSupersededFailedTasks(
      mission.id,
      (mission.workspaceId as string | null) ?? null,
      failedDeliverableRows.map((t) => ({ id: t.id, title: t.title, subjectPrNumber: (t as { subjectPrNumber?: number | null }).subjectPrNumber ?? null, createdAt: t.createdAt })),
    ).catch(() => new Map()),
    // One DeliveryView load for the page (§17.5): the failure reading, the
    // board/strip, the timeline cards and the structure view all read it.
    getDeliveryViewsForTasks((mission.tasks || []).map((t) => t.id)),
  ]);
  const kernelReplaced = replacedFailedTaskIds(deliveryViews, failedDeliverableRows.map((t) => t.id));
  const deliveryDisplays = ownerDeliveryDisplays(deliveryViews);
  const healthState = deriveTaskHealthSignal(
    { ...mission, heartbeatWaitingUntil },
    (mission.tasks || []).map((t) => ({ ...t, superseded: supersededMap.has(t.id) || kernelReplaced.has(t.id) })),
    { dependencies: foreignDeps },
  );

  // Orchestration mode
  const orchestrationMode = (mission.orchestrationMode as 'auto' | 'manual') ?? 'auto';
  const isHeld = (mission as any).isHeld === true;

  // Goal criteria that have not been verified keep the mission open — the header
  // must say that rather than "READY FOR REVIEW".
  const missionCriteria = (mission as any).goalCriteria as unknown[] | null;
  const missionCriteriaOverall = ((mission as any).goalCriteriaState as { overall?: string } | null)?.overall ?? null;

  // Shared presentation for the above-fold banner and Summary view — same
  // helper the mission card pill and initiative KPI chip read from, so this
  // page never invents its own vocabulary for the same verdict. `completionAttempted`
  // is what separates a young/active mission's unevaluated criteria (quiet)
  // from a mission whose work is otherwise done and completion has actually
  // been refused (prominent) — see `deriveCriteriaGatePresentation`.
  const criteriaStateItems = ((mission as any).goalCriteriaState as { criteria?: Array<{ verdict: string; label?: string; type?: string; evidence?: string }> } | null)?.criteria ?? [];
  const criteriaGate = !['completed', 'cancelled', 'archived'].includes(mission.status)
    ? deriveCriteriaGatePresentation({
        criteriaCount: Array.isArray(missionCriteria) ? missionCriteria.length : 0,
        overall: (missionCriteriaOverall as any) ?? null,
        items: criteriaStateItems as any,
        completionAttempted: progress !== undefined && progress >= 100,
      })
    : null;

  // ── What is this mission actually waiting on? ──
  // Read from `explain`, which runs the one shared mission-state accessor. The
  // page does NOT assemble its own accessor input and does NOT re-derive the
  // answer: this screen's whole defect was that the platform already knew the
  // next action and the screen declined to say it, and a second derivation here
  // would be the same failure with better intentions.
  // Cost budget is read straight off the mission row, so the spend lookup can
  // start alongside the explain accessor rather than waiting behind it.
  const costBudgetUsd = (mission as any).costBudgetUsd as string | null ?? null;

  // explainMission, the mission spend and the tracker links share no inputs
  // beyond the mission id, so they are one wait instead of three.
  const [explained, spendUsd, trackerLinks, teamTimezone] = await Promise.all([
    explainMission(id),
    costBudgetUsd != null ? getMissionSpendUsd(id) : Promise.resolve(null),
    // Linear Phase 2: only mount the tracking panel if this mission has a linear link.
    getLinksForEntity(db, 'mission', id),
    // Stamps render in this mission's team zone; null → the viewer's browser
    // zone, never the server's UTC. Never throws.
    getTeamTimezoneSetting(mission.teamId),
  ]);
  const missionAnswer = explained?.subjects[0] ?? null;

  // Single derived display state for the header chip and CTA — read off the
  // SAME accessor answer the waiting-on panel renders, so the chip cannot say
  // AUTO/RUNNING while the panel below says blocked or idle. When the explain
  // read failed, the same accessor is asked directly from what the page already
  // holds (no completion or wait reads), never a second derivation.
  const fallbackView = missionAnswer ? null : deriveMissionStateView({
    status: mission.status,
    isHeld,
    executor: (mission as any).executor ?? null,
    orchestrationMode,
    activeAgents,
    health: healthState,
    progress,
    dependsOnMissionId: (mission as any).dependsOnMissionId ?? null,
    criteriaGate,
    criteriaEscalatedAt: (mission as any).criteriaEscalatedAt ?? null,
    hasPendingDeliverableWork,
  });
  const displayState = missionAnswer?.displayState ?? fallbackView!.displayState;
  const stateChip = missionAnswer?.chip ?? fallbackView!.chip;

  // The Verified pill is the page's only `#mission-criteria` target. It is
  // hidden on a terminal mission whose criteria do not pass, and renders
  // nothing on a terminal mission with no criteria; the situation must not
  // link to it then. Same predicate as `showVerifiedPill` below.
  const missionIsTerminal = ['completed', 'archived'].includes(mission.status);
  const criteriaReachable = (!missionIsTerminal || missionCriteriaOverall === 'pass')
    && !(missionIsTerminal && (((mission as any).goalCriteria as unknown[] | null) ?? []).length === 0);

  // Whether the situation block is offering a wired affordance. When it is, the
  // settings panel must not raise a competing primary button — an action at
  // parity with the one right action is what made this screen unreadable.
  const primaryAffordance = missionAnswer
    ? affordanceFor(missionAnswer.situation.focus, { missionId: id, criteriaReachable })
    : null;
  const hasPrimaryAction = primaryAffordance !== null;

  const detailNextRunAt = (mission.schedule as any)?.nextRunAt;
  const detailNextScanMins = detailNextRunAt ? Math.max(0, Math.round((new Date(detailNextRunAt).getTime() - Date.now()) / 60_000)) : null;
  const driveNextRun = formatNextRun(detailNextScanMins, detailNextRunAt ? String(detailNextRunAt) : null);

  // Heartbeat data — derived from schedule's taskTemplate.context
  const templateContext = (mission.schedule as any)?.taskTemplate?.context as Record<string, unknown> | undefined;
  const isHeartbeat = (templateContext?.heartbeat === true) || false;
  const heartbeatChecklist = (templateContext?.heartbeatChecklist as string) ?? null;
  const activeHoursStart = (templateContext?.activeHoursStart as number) ?? null;
  const activeHoursEnd = (templateContext?.activeHoursEnd as number) ?? null;
  const activeHoursTimezone = (templateContext?.activeHoursTimezone as string) ?? null;

  // Configuration from schedule template
  const configModel = (templateContext?.model as string) || null;

  // Organizer runs from every trigger (event, wake, check-in, manual, retry),
  // newest first, labelled by tasks.context.triggerSource.
  const organizerRuns = selectOrganizerRuns(
    (mission.tasks || []).map(t => ({
      id: t.id,
      mode: t.mode,
      title: t.title,
      createdAt: t.createdAt,
      status: t.status,
      context: digestOf(t.id).context,
    })),
  );
  const TERMINAL_STATUSES = ['completed', 'cancelled', 'budget_exhausted'];
  const heartbeatOverdue = isHeartbeat && !TERMINAL_STATUSES.includes(mission.status) && mission.schedule?.nextRunAt && scheduleCron
    ? checkOverdue(mission.schedule.nextRunAt, scheduleCron)
    : false;

  const scheduleNextRunAt = (mission.schedule as any)?.nextRunAt as string | null | undefined;
  const scheduleNextMs = scheduleNextRunAt ? new Date(scheduleNextRunAt).getTime() : null;
  const scheduleOverdue = mission.status === 'active' && scheduleNextMs != null && scheduleNextMs < Date.now();
  const scheduleOverdueMinutes = scheduleOverdue && scheduleNextMs != null ? Math.floor((Date.now() - scheduleNextMs) / 60000) : 0;
  // Check-ins: what the last hourly stuck check found (lib/mission-checkins.ts).
  const lastCheck = describeLastCheck({
    lastDeferralReason: (mission.schedule as any)?.lastDeferralReason ?? null,
    lastDeferredAt: (mission.schedule as any)?.lastDeferredAt ?? null,
    lastRunAt: (mission.schedule as any)?.lastRunAt ?? null,
    isOverdue: !!heartbeatOverdue,
    latestOrganizerRun: organizerRuns[0] ?? null,
  });

  // Build roles map for color lookup
  const rolesMap = new Map<string, { name: string; color: string }>();
  roles.forEach((r) => rolesMap.set(r.slug, { name: r.name, color: r.color }));

  // Build task ID map for blocked-state computation (dependsOn resolution)
  const taskMap = new Map((mission.tasks || []).map((t) => [t.id, t]));

  // A task is "blocked" when it has unresolved dependsOn entries (upstream task
  // not yet completed, or completed but PR not yet merged).
  function getBlockingTask(task: typeof allTasks[0]) {
    const deps = (task.dependsOn as string[] | null | undefined) ?? [];
    if (deps.length === 0) return null;
    if (task.status !== 'pending' && task.status !== 'assigned') return null;
    for (const depId of deps) {
      const dep = taskMap.get(depId);
      if (!dep) continue;
      if (dep.status !== 'completed') return dep;
      // Completed but PR not yet merged → still blocking
      const depWorker = (dep.workers as Array<{ prNumber?: number | null; mergedAt?: string | Date | null }> | null | undefined)?.[0];
      if (depWorker?.prNumber && !depWorker.mergedAt) return dep;
    }
    return null;
  }

  // Build orchestration timeline: group tasks into cycles
  // Planning tasks = evaluation nodes, execution tasks = branches
  const allTasks = (mission.tasks || []).slice().sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  // Verified step: a raw pass count, not `deriveCriteriaGatePresentation`'s
  // label/tone. `passed: null` when the gate has never been evaluated, so the
  // step says `?/N` rather than misreporting `0/N`.
  const criteriaTotal = Array.isArray(missionCriteria) ? missionCriteria.length : 0;
  const criteriaPassed = criteriaStateItems.length > 0
    ? criteriaStateItems.filter(c => c.verdict === 'pass').length
    : null;

  const allWorkers = allTasks.flatMap(t => (t.workers || []) as any[]);

  // PRs with failing CI — surfaced in the all_prs_merged criterion panel (AC-3).
  // Derived from the same worker state the Activity chip reads (no extra GitHub call).
  const failingCiPrNumbers = allWorkers
    .filter(w => w.prNumber && w.prLifecycleStatus === 'ci_failed')
    .map(w => w.prNumber as number)
    .filter((n, i, arr) => arr.indexOf(n) === i) // dedup
    .sort((a, b) => a - b);

  // Collect all artifacts
  const allArtifacts = mission.tasks?.flatMap((t) =>
    t.workers?.flatMap((w) =>
      (w.artifacts || []).map((a) => ({ ...a, taskTitle: t.title, workerStatus: w.status }))
    ) || []
  ) || [];

  const missionRecords = selectMissionRecords(allArtifacts);

  // Goal criteria — hoisted so the header's Verified pill and its bottom
  // sheet (MissionVerifiedPill) read the same values the removed
  // always-visible block used to.
  const goalCriteria = ((mission as any).goalCriteria as GoalCriterion[] | null) ?? [];
  const goalCriteriaStateFull = (mission as any).goalCriteriaState as GoalCriteriaState | null;
  const autoVerifyFlag = (mission as any).autoVerify as boolean | null;

  // ── Mission feed (knowledge-base: buildd/design/mission-feed-mobile-continuity.md) ──────────
  // Every mission task in the one input shape the pulse, the grouped list and
  // the task sheet all read — so the header pulse, the list and `n / N` count
  // the same rows (addendum D1). Attempts and bookkeeping are folded by the
  // builders, never here (mission-feed-view.ts, unit-tested).
  const {
    feedTasks, pulseSegments, segmentLabels, pulseCaption, recordsCountByTask, liveLines,
  } = buildMissionFeedView(allTasks as unknown as MissionFeedViewTask[], { activeAgents, liveStatuses });
  const feedCounts = pulseDoneCounts(pulseSegments);
  const renderedAt = Date.now();

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev';

  const missionTaskIds = allTasks.map((t) => t.id);
  // workerId → status as rendered, so the live policy can tell a heartbeat
  // from a status change on the first event it sees.
  const renderedWorkerStatuses: Record<string, string> = Object.fromEntries(
    allTasks.flatMap(t => ((t.workers ?? []) as Array<{ id: string; status: string }>).map(w => [w.id, w.status])),
  );

  // Fetch team's active/paused initiatives for the initiative selector
  const isTerminal = ['completed', 'archived'].includes(mission.status);

  // Release section (§8.5): reads the same workspace-scoped loader as the
  // mission-card footer (lib/release-footer.ts) so the two surfaces cannot
  // disagree about queue depth or deploy state (AC-41).
  const releaseWorkspace = mission.workspace as
    | { id: string; name: string; gitConfig: unknown; releaseConfig: WorkspaceReleaseConfig | null }
    | null
    | undefined;
  // §9.1 / AC-42: `none` skips the baseline and queue queries entirely.
  // detectArchetype is pure (config only, no I/O), so this gate costs nothing.
  const releaseArchetype: ReleaseArchetype = releaseWorkspace
    ? detectArchetype({
        name: releaseWorkspace.name,
        releaseConfig: releaseWorkspace.releaseConfig,
        gitConfig: releaseWorkspace.gitConfig as WorkspaceGitConfig | null,
      })
    : 'none';

  // The breadcrumb initiative, the initiative-selector options, the release
  // footer and the completion note are mutually independent.
  const [initiativeName, teamInitiativeOptions, releaseFooterData, completionNote, carryingReleaseId, feedNoteRows, shippedRow, surfaceAuditWaiver] = await Promise.all([
    // Breadcrumb: URL param takes priority, DB-stored initiative is the fallback
    // so users see the parent initiative even when navigating directly to the mission.
    (from === 'initiative' && initiativeId)
      ? db.query.initiatives.findFirst({
          where: eq(initiatives.id, initiativeId),
          columns: { title: true },
        }).then(row => row?.title)
      : Promise.resolve(undefined),
    isTerminal
      ? Promise.resolve([] as InitiativeOption[])
      : db.query.initiatives.findMany({
          where: and(
            inArray(initiatives.teamId, teamIds),
            inArray(initiatives.status, ['active', 'paused']),
          ),
          columns: { id: true, title: true, status: true },
          orderBy: [desc(initiatives.priority), desc(initiatives.createdAt)],
          limit: 50,
        }).then(rows => rows.map(r => ({ id: r.id, title: r.title, status: r.status, progress: 0 }))),
    // The mission reads only its own Shipped fact from this (D6); the
    // workspace queue and the Release now trigger are not rendered here.
    shouldQueryRelease(releaseArchetype) && releaseWorkspace
      ? loadReleaseFooterData({
          id: releaseWorkspace.id,
          name: releaseWorkspace.name,
          gitConfig: releaseWorkspace.gitConfig,
          releaseConfig: releaseWorkspace.releaseConfig,
        })
      : Promise.resolve(null),
    // D3: the completion summary reads the mission's own completion record,
    // never the latest task's summary.
    mission.status === 'completed'
      ? db.query.missionNotes.findFirst({
          where: and(eq(missionNotes.missionId, id), eq(missionNotes.title, MISSION_COMPLETED_NOTE_TITLE)),
          columns: { body: true, createdAt: true },
          orderBy: desc(missionNotes.createdAt),
        }).then(row => row ?? null)
      : Promise.resolve(null),
    // F6: the Shipped link opens the release carrying THIS mission's work
    // (release_tasks attribution), not the workspace's latest release.
    shouldQueryRelease(releaseArchetype) ? loadMissionCarryingReleaseId(id) : Promise.resolve(null),
    // The Feed's escalations and answers: agent questions and human replies,
    // on the mission or on any of its tasks (task-scoped notes carry no missionId).
    db.query.missionNotes.findMany({
      where: and(
        allMissionTaskIds.length > 0 ? or(eq(missionNotes.missionId, id), inArray(missionNotes.taskId, allMissionTaskIds)) : eq(missionNotes.missionId, id),
        or(eq(missionNotes.type, 'question' as any), eq(missionNotes.authorType, 'user')),
      ),
      columns: { id: true, type: true, authorType: true, title: true, taskId: true, createdAt: true },
      orderBy: desc(missionNotes.createdAt),
      limit: 200,
    }),
    // The stored "What shipped" record. A read failure only costs the header.
    mission.status === 'completed'
      ? db.query.artifacts.findFirst({
          where: and(eq(artifacts.missionId, id), eq(artifacts.key, shippedArtifactKey(id))),
          columns: { metadata: true },
        }).then(row => row ?? null, () => null)
      : Promise.resolve(null),
    // The person-set "Waive visual audit" record, if any. A failed read only
    // costs the record line; the waiver action stays.
    loadSurfaceAuditWaiver(id).catch(() => null),
  ]);
  const shippedView = mission.status === 'completed'
    ? buildShippedHeaderView((shippedRow?.metadata as { shipped?: unknown } | null)?.shipped, (mission as any).completedAt)
    : null;
  const feedNotes = feedNoteRows.map(n => ({
    id: n.id, type: n.type as string, authorType: n.authorType as string, title: n.title ?? null,
    taskId: n.taskId ?? null, createdAt: new Date(n.createdAt).getTime(),
  }));

  const dbInitiative = (mission as any).initiative as { id: string; title: string } | null | undefined;

  const breadcrumb = resolveMissionBreadcrumb({
    from,
    initiativeId,
    initiativeName,
    dbInitiativeId: dbInitiative?.id,
    dbInitiativeName: dbInitiative?.title,
    missionTitle: mission.title,
  });


  // ── Delivery (W2, addendum D5) ─────────────────────────────────────────────
  // One stepper for what used to be the progress card, the mission PR card,
  // the release card, the budget cards and the completion stat tiles.
  const releaseState = mission.workspaceId
    ? classifyReleaseState({ archetype: releaseArchetype, data: releaseFooterData })
    : ({ state: 'none' } as const);
  const budgetUsd = costBudgetUsd != null ? parseFloat(costBudgetUsd) : null;
  // Distinct PRs, not worker rows — a CI retry pushes to its parent's PR.
  const prCount = missionPrCount(allTasks as Array<{ workers?: Array<{ prUrl?: string | null }> | null }>);
  // Visual review: the model is passed whenever an audit exists (no
  // "shots only" guard), so a queued, runner-less, boot-failed or stalled
  // audit is on the page. The Visual step is an adapter over the same model.
  const boardVisual: VisualReviewModel | null = visualModel && visualModel.phase !== 'off' ? visualModel : null;
  // "Waive visual audit" (a person's call): offered beside the Visual review
  // control and on the audit task's drawer whenever the mission has an audit,
  // is blocked on a missing one, or already carries a waiver.
  const auditWaiverProps = {
    missionId: id,
    waiver: surfaceAuditWaiver ?? null,
    missionBranch: (mission as { integrationBranchEnabled?: boolean | null }).integrationBranchEnabled === true,
    readonly: isTerminal,
  };
  const showAuditWaiver = !!surfaceAuditWaiver
    || (mission.tasks ?? []).some(t => isSurfaceAuditTask(t.title ?? '') || t.roleSlug === VISUAL_AUDITOR_ROLE_SLUG)
    || (missionAnswer?.waitingOn?.kind === 'human_decision' && missionAnswer.waitingOn.surfaceAudit === true);
  const vs = boardVisual?.summary;
  const visualReview = vs
    ? {
        shots: vs.shots, ok: vs.ok, issues: vs.issues, unsure: vs.unsure,
        ...(vs.required != null ? { required: vs.required, covered: vs.covered } : {}),
        ...(vs.bootFailed ? { bootFailed: true } : {}),
      }
    : null;
  // The footer renders Shipped and Screens; the band says the rest.
  const deliverySteps = buildDeliverySteps({
    missionStatus: mission.status,
    totalTasks: feedCounts.total,
    completedTasks: feedCounts.done,
    awaitingMerge,
    integrationPr: missionIntegrationPr,
    criteria: { total: criteriaTotal, passed: criteriaPassed, overall: missionCriteriaOverall },
    visual: visualReview,
    visualPhase: boardVisual,
    // D6: this mission's own trunk merges, read against the release baseline.
    mergedAt: missionTrunkMergedAt(
      (mission.tasks ?? []) as Array<{ id: string; workers?: Array<{ mergedAt?: string | Date | null }> | null }>,
      missionIntegrationPr,
    ),
    release: deliveryReleaseInput(releaseState),
    budget: budgetUsd != null
      ? { budgetUsd, spendUsd, exhausted: mission.status === 'budget_exhausted' }
      : null,
    prCount: mission.status === 'completed' ? prCount : undefined,
    durationLabel: null,
  });
  const shippedStep = deliverySteps.find(s => s.key === 'shipped');
  const visualStep = deliverySteps.find(s => s.key === 'visual') ?? null;
  const missionPrCard = shouldRenderMissionPrBlock(missionIntegrationPr, { workLanded: feedCounts.total > 0 && feedCounts.done >= feedCounts.total }) && missionIntegrationPr ? (
    // Mission integration PR (Option A′): the mission's review gate, and a
    // different object from the task PRs that fed the branch. One line.
    <div data-testid="mission-pr-line" className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <p className="min-w-0 text-body text-text-secondary">
        <span className="font-semibold text-text-primary">Mission PR</span>
        <span className={`ml-2 font-mono text-meta ${missionIntegrationPr.state === 'merged' ? 'text-status-success' : missionIntegrationPr.state === 'closed' ? 'text-status-error' : 'text-text-muted'}`}>
          {MISSION_PR_STATE_LABEL[missionIntegrationPr.state]}
        </span>
        <span className="ml-2 font-mono text-meta text-text-muted [overflow-wrap:anywhere]">{missionIntegrationPr.branch}</span>
        <span className="mt-0.5 block">
          {missionIntegrationPr.state === 'not_opened'
            ? 'Task PRs merge into the integration branch. No PR to the target branch is open, so none of this work has shipped.'
            : missionIntegrationPr.state === 'merged'
              ? "This mission's work reached the target branch through one PR from its integration branch."
              : "The mission's review gate: one PR from the integration branch into the target branch. The merge policy applies to this PR only."}
        </span>
      </p>
      {missionIntegrationPr.prUrl && (
        <a
          href={missionIntegrationPr.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 font-mono text-meta text-text-secondary hover:text-text-primary"
        >
          #{missionIntegrationPr.prNumber} →
        </a>
      )}
    </div>
  ) : null;

  const reviewSummary = displayState === 'review' ? (
    <MissionReviewSummary
      missionId={id}
      tasks={allTasks
        .filter(t => t.category !== 'review' && t.status !== 'cancelled')
        .map(t => {
          const w = (t.workers as any[])?.[0];
          return {
            id: t.id,
            title: t.title,
            status: t.status,
            prUrl: w?.prUrl ?? null,
            prNumber: w?.prNumber ?? null,
            prMerged: !!w?.mergedAt,
            prClosed: w?.prLifecycleStatus === 'closed',
          };
        })}
    />
  ) : null;

  const budgetDetail = budgetUsd == null ? null : mission.status === 'budget_exhausted' ? (
    <div className="flex items-start justify-between gap-3">
      <p className="text-body text-text-secondary">
        {spendUsd != null
          ? `${formatEstimatedUsd(spendUsd, 4)} of $${budgetUsd.toFixed(2)} budget spent. No new tasks will start.`
          : `Budget of $${budgetUsd.toFixed(2)} reached. No new tasks will start.`}
        {' '}Raise the budget to resume.
      </p>
      <div className="shrink-0">
        <RaiseBudgetButton missionId={id} currentBudget={costBudgetUsd!} />
      </div>
    </div>
  ) : spendUsd != null ? (
    <p className="text-[12px] font-mono text-status-warning" title={ESTIMATED_COST_TITLE}>
      {formatEstimatedUsd(spendUsd)} / ${budgetUsd.toFixed(2)}
    </p>
  ) : null;

  // D3: the mission's own completion/decision record — never whichever work
  // task or retry finished last (selectMissionCompletionSummary).
  const completionPick = mission.status === 'completed'
    ? selectMissionCompletionSummary({
        tasks: allTasks.map(t => ({
          id: t.id, title: t.title, status: t.status, mode: t.mode, taskClass: t.taskClass,
          kind: t.kind, category: t.category, createdAt: t.createdAt, updatedAt: t.updatedAt, result: digestOf(t.id).result,
        })),
        completionNote,
      })
    : null;

  // D2: beside a terminal mission's chip the pill only ever says Verified —
  // never "Needs verification" next to COMPLETE.
  const showVerifiedPill = !isTerminal || missionCriteriaOverall === 'pass';

  const artifactItems = allArtifacts.map((a) => ({
    id: a.id,
    type: a.type,
    title: a.title ?? a.key ?? null,
    // Fetched when the Records sheet opens (AC-18).
    content: null,
    storageKey: a.storageKey ?? null,
    shareToken: a.shareToken ?? null,
    visibility: (a.visibility as 'private' | 'public') ?? 'private',
    metadata: (a.metadata as Record<string, unknown>) ?? {},
    createdAt: String(a.createdAt),
    taskTitle: a.taskTitle ?? null,
  }));
  const recordIds = new Set(missionRecords.map(a => a.id));
  const recordItems = artifactItems.filter(a => recordIds.has(a.id));

  const decisionBlock = displayState === 'waiting_decision' && (() => {
        const reading = inferCriteriaFailureReading(goalCriteriaStateFull);
        const readingCopy = describeCriteriaFailureReading(reading);
        // First non-passing criterion, by its stable `index` — not array
        // position in `criteria`, which can skip entries.
        const failingState = (goalCriteriaStateFull?.criteria ?? []).find(c => c.verdict !== 'pass') ?? null;
        const failingCriterionIndex = failingState ? failingState.index : null;
        const failingCriterion = failingCriterionIndex != null ? goalCriteria[failingCriterionIndex] ?? null : null;
        const waitingOn = missionAnswer?.waitingOn ?? null;
        const surfaceAuditBlocked = waitingOn?.kind === 'human_decision' && waitingOn.surfaceAudit === true;
        const surfaceAuditPaths = surfaceAuditBlocked && waitingOn.surfaceAuditPaths ? waitingOn.surfaceAuditPaths : [];
        const criteriaUnmet = goalCriteria.length > 0 && goalCriteriaStateFull?.overall !== 'pass';
        const fileWorkHref = buildFileWorkHref({
          missionId: id,
          missionTitle: mission.title,
          criterion: failingCriterion,
          evidence: failingState?.evidence ?? null,
        });
        return (
          <div data-testid="mission-decision">
            <p className="text-body text-text-secondary [overflow-wrap:anywhere]">
              <span className="font-semibold text-accent-text">Decision needed. </span>
              {surfaceAuditBlocked ? surfaceAuditHeadline(surfaceAuditPaths.length) : readingCopy}
            </p>
            <MissionDecisionSheet
              missionId={id}
              goalCriteria={goalCriteria}
              failingCriterionIndex={failingCriterionIndex}
              fileWorkHref={fileWorkHref}
              criteriaUnmet={criteriaUnmet}
              surfaceAudit={surfaceAuditBlocked
                ? { paths: surfaceAuditPaths, executorLocal: (mission as any).executor === 'local' }
                : null}
            />
          </div>
        );
      })();

  // The mission's settings: rendered inside the ⋯ sheet, the one place the
  // mission is configured (MissionOverflowMenu).
  const settings = (
    <>
      {/* Where this mission sits, and the chips that used to crowd the header. */}
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-text-muted">
        {mission.workspace && !isSystemWorkspace(mission.workspace.name) && (
          <span>
            Workspace:{' '}
            <Link href={`/app/workspaces/${mission.workspace.id}`} className="text-text-primary underline underline-offset-4">
              {displayWorkspaceName(mission.workspace.name)}
            </Link>
          </span>
        )}
        {displayState === 'active' && driveNextRun.text && (
          <span className="font-mono text-[11px]">{driveNextRun.text}</span>
        )}
        {mission.workspaceId && (hasPolicyOverride || awaitingMerge > 0) && (
          <Link
            href={`/app/settings/workspace/${mission.workspaceId}`}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] md:text-[10px] font-mono bg-surface-3 text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors"
            title={`Merge policy: ${policyLabel}${hasPolicyOverride ? ' (overridden)' : ' (inherited)'}`}
          >
            {policyLabel}
            {hasPolicyOverride && <span className="opacity-60">·override</span>}
          </Link>
        )}
      </div>

      <MissionInitiativeSelector
        missionId={id}
        currentInitiativeId={dbInitiative?.id ?? null}
        currentInitiativeName={dbInitiative?.title ?? null}
        initiatives={teamInitiativeOptions}
        readonly={isTerminal}
      />

      {/* Rename only: the masthead shows the title, the description has its
          own place under the masthead (MissionDescription). */}
      <MissionInlineEdit missionId={id} initialTitle={mission.title} />

      {/* Monitoring toggle — schedules only */}
      {scheduleCron && !['completed', 'archived'].includes(mission.status) && (
        <MissionMonitoringToggle
          missionId={id}
          initialStatus={mission.status}
          hasSchedule={!!scheduleCron}
          schedule={mission.schedule ? {
            nextRunAt: (mission.schedule as any).nextRunAt?.toISOString?.() || (mission.schedule as any).nextRunAt || null,
            lastRunAt: (mission.schedule as any).lastRunAt?.toISOString?.() || (mission.schedule as any).lastRunAt || null,
          } : null}
          orchestrationMode={orchestrationMode}
          isHeartbeat={isHeartbeat}
        />
      )}

      {/* Check-ins: the hourly stuck check (the internal "heartbeat" schedule). */}
      {isHeartbeat && <MissionCheckIns lastCheck={lastCheck} />}

      {!['completed', 'archived'].includes(mission.status) && (
        <div>
          <h3 className="mb-2 text-body font-semibold text-text-primary">Agent backend</h3>
          <MissionBackendSelector missionId={id} initialBackend={((mission as { defaultBackend?: 'claude' | 'codex' | null }).defaultBackend) ?? null} />
          <p className="text-[11px] text-text-muted mt-1.5">Default engine for this mission&apos;s tasks. Auto uses the role or workspace default.</p>
        </div>
      )}

      {/* Visual review: the auto-audit switch (modelled on auto-verify) and
          the audit's live Line. */}
      <MissionVisualReviewSetting
        missionId={id}
        initialEnabled={(mission as { autoSurfaceAudit?: boolean | null }).autoSurfaceAudit ?? null}
        visual={boardVisual}
        readonly={isTerminal}
        auditWaiver={showAuditWaiver ? auditWaiverProps : null}
      />

      {/* Organizer runs are in History › Everything, not repeated here. */}

      {isHeartbeat && (
        <>
          <HeartbeatChecklistEditor missionId={id} checklist={heartbeatChecklist} />
          <QuietHoursConfig
            missionId={id}
            activeHoursStart={activeHoursStart}
            activeHoursEnd={activeHoursEnd}
            activeHoursTimezone={activeHoursTimezone}
          />
        </>
      )}

      {!scheduleCron && !['completed', 'archived'].includes(mission.status) && (
        <ScheduleWizard missionId={id} hasWorkspace={!!mission.workspaceId} workspaces={teamWorkspaces} />
      )}

      {!['completed', 'archived'].includes(mission.status) && (
        <div>
          <h3 className="mb-3 text-body font-semibold text-text-primary">Configuration</h3>
          <MissionConfig
            missionId={id}
            workspaceId={mission.workspaceId}
            model={configModel}
            workspaces={teamWorkspaces}
            maxConcurrentTasks={mission.maxConcurrentTasks}
            activeTasks={(mission.tasks || []).filter(t => ['pending', 'assigned', 'in_progress'].includes(t.status)).length}
            costBudgetUsd={costBudgetUsd}
          />
          {mission.workspaceId && (
            <div className="mt-4 pt-3 border-t border-border-default">
              <div className="flex items-center justify-between mb-1">
                <span className="text-body font-semibold text-text-primary">Merge policy</span>
              </div>
              <MissionMergePolicyRow
                missionId={id}
                missionTitle={mission.title}
                roles={roles.map(r => ({ slug: r.slug, name: r.name }))}
                missionPolicy={(mission as any).mergePolicy ?? null}
                workspaceDefaultTier={workspaceDefaultPolicy.tier}
                workspaceName={mission.workspace?.name ?? null}
              />
            </div>
          )}
        </div>
      )}

      {trackerLinks.some(l => l.provider === 'linear') && (
        <TrackerProgressPanel entityType="mission" entityId={id} />
      )}

      {/* Diagnostics — steering-cost stats live here, not in the header
          chip row (addendum D2: no internal jargon on cards or headers).
          Collapsed by default: this is debug detail, not a primary setting. */}
      <details className="group border-t border-border-default pt-3" data-testid="mission-diagnostics">
        <summary className="min-h-11 cursor-pointer list-none text-body text-text-secondary md:min-h-0">
          <span aria-hidden className="inline-block w-3 group-open:rotate-90 transition-transform">▸</span> Advanced
        </summary>
        <div className="mt-2">
          <MissionAuthorshipStats health={authorshipHealth} />
        </div>
      </details>
    </>
  );

  // ── Board / Flow (MissionBoard, FlowTimeline) ─────────────────────────────
  // One model for both, from the same rows the feed reads; `buildMissionBoard`
  // folds and states them with the feed's own rules, so the counts agree.
  const boardModel = buildMissionBoard({
    runnerHeartbeats,
    fleetCapacity,
    tasks: allTasks.map(t => toBoardTaskInput({ ...t, delivery: deliveryDisplays.get(t.id) ?? null } as unknown as Parameters<typeof toBoardTaskInput>[0])),
    roles,
    now: renderedAt,
    missionCreatedAt: new Date((mission as any).createdAt).getTime(),
    missionCompletedAt: (mission as any).completedAt ? new Date((mission as any).completedAt).getTime() : null,
    missionStatus: mission.status,
    criteria: goalCriteria as Array<{ type: string; label?: string; key?: string; artifactType?: string }>,
    criteriaState: goalCriteriaStateFull?.criteria ?? [],
    artifacts: allArtifacts.map(a => ({ key: a.key ?? null, type: a.type ?? null })),
    humanTouches: humanSteeringNotes.map(n => new Date(n.createdAt).getTime()),
    // Another mission's dependency is judged by the claim gate, not dropped.
    externalDeps: [...foreignDeps.values()],
  });
  // Flow: the same-files waits Buildd added, and each task's expected size.
  const flowSameFiles = sameFilesFromRows(allTasks as Array<{ id: string; pathDeclaration?: unknown }>);
  const flowExpectedMinutes = expectedMinutesFromPredictions(sizePredictions);
  // The drawer's per-task Build › Audit › Land and audit/repair evidence: the
  // shared delivery projection over the same rows (Home, Missions, Activity).
  const taskDeliveries = missionTaskDeliveries({
    mission: { id, title: mission.title, status: mission.status, isHeld, integrationBranch: (mission as { integrationBranchEnabled?: boolean | null }).integrationBranchEnabled === true },
    tasks: allTasks as unknown as MissionDeliveryTaskRow[],
    digestOf,
    rules: missionHelpers,
  });
  // The lede answers "what changed for me?" in place of the D3 text; every
  // other header variant sits above it.
  const completionText = completionPick && !shippedView?.lede
    ? (completionPick.source === 'completion_record' ? formatCompletionRecord(completionPick.text) : completionPick.text)
    : null;
  // The band says running / needs-you / done by itself. Anything else the
  // mission is waiting on (a decision gate, a block, a stall) still gets its
  // one sentence and its one action above the columns.
  // The integration PR card and the review summary ride along on every layout.
  const quietState = ['running', 'active', 'complete'].includes(displayState);
  const budgetExhausted = budgetUsd != null && mission.status === 'budget_exhausted';
  const boardNotice = quietState && !missionPrCard && !reviewSummary ? null : (
    <MissionNoticeSlot
      needsYou={!quietState && noticeNeedsPerson({
        displayState,
        budgetExhausted,
        focusKind: missionAnswer?.situation.focus?.kind ?? null,
      })}
    >
      {!quietState && missionAnswer && (
        <MissionSituationBlock
          missionId={id}
          situation={missionAnswer.situation}
          because={missionAnswer.because}
          criteriaReachable={criteriaReachable}
        />
      )}
      {!quietState && decisionBlock}
      {!quietState && budgetExhausted && budgetDetail}
      {missionPrCard}
      {reviewSummary}
    </MissionNoticeSlot>
  );
  const boardLink = { missionId: id, from: parseMissionOrigin(from), initiativeId: initiativeId ?? null };
  // The Landed strip's drawer: the tasks' actions run in this workspace, and
  // when the situation block's one affordance is a single task, the drawer
  // opens on it with the accessor's sentence (and the block points at it).
  const boardStrip = {
    workspaceId: mission.workspaceId ?? null,
    executor: ((mission as any).executor === 'local' ? 'local' : (mission as any).executor === 'runner' ? 'runner' : null) as 'local' | 'runner' | null,
    stripFocus: !quietState && missionAnswer && primaryAffordance?.kind === 'internal' && primaryAffordance.taskId
      ? { taskId: primaryAffordance.taskId, reason: missionAnswer.situation.headline }
      : null,
    deliveries: taskDeliveries,
  };
  const verifiedPill = (
    <MissionVerifiedPill
      sheetOnly={!showVerifiedPill}
      missionId={id}
      criteria={goalCriteria}
      criteriaState={goalCriteriaStateFull}
      autoVerify={autoVerifyFlag}
      readonly={isTerminal}
      failingCiPrNumbers={failingCiPrNumbers.length > 0 ? failingCiPrNumbers : undefined}
      missionPrCount={prCount}
      overall={missionCriteriaOverall as 'pass' | 'fail' | 'UNVERIFIED' | 'NOT_EVALUATED' | 'PENDING' | null}
    />
  );
  // Chat is how you ask about work: opens a conversation with this mission docked.
  const askAbout = <AskAboutLink kind="mission" id={id} teamId={mission.teamId} workspaceId={mission.workspaceId} />;
  // The mission's visual review as a mission command (never the task composer),
  // started from ⋯ on any open mission with a workspace to run it in; once an
  // audit exists the footer's Screens row is where it is reviewed.
  const visualReviewEntry = !isTerminal && mission.workspaceId ? { initialOpen: visualReviewParam === '1' } : null;
  const overflowMenu = (
    <MissionOverflowMenu
      missionId={id}
      currentStatus={mission.status}
      cronExpression={scheduleCron}
      workspaceId={mission.workspaceId}
      roles={quickAddRoles}
      hasSchedule={!!scheduleCron}
      orchestrationMode={mission.orchestrationMode as 'auto' | 'manual' | undefined ?? 'auto'}
      isHeld={isHeld}
      displayState={displayState}
      hasPrimaryAction={hasPrimaryAction}
      executor={(mission as any).executor === 'local' ? 'local' : (mission as any).executor === 'runner' ? 'runner' : null}
      visualReview={visualReviewEntry}
      settings={settings}
    />
  );
  const back = mastheadBack(from, breadcrumb.links);
  // One sentence of what the mission is for; the full text is behind "Description".
  const goalLine = missionSummaryLine(mission.description);
  const footerRows = (
    <>
      {/* F6: this mission's own release status, linking to the release. */}
      {mission.workspaceId && shippedStep && (
        <div className="border-t border-border-default">
          <MissionReleaseSection step={shippedStep} releaseId={carryingReleaseId} workspaceId={mission.workspaceId} />
        </div>
      )}
      {/* The visual review, live: opens the review deck (or, before any
          screen, the phase and its actions). Any audit phase shows it. */}
      {boardVisual && <MissionScreensRow missionId={id} step={visualStep} />}
      <MissionRecordsSheet
        missionId={id}
        baseUrl={baseUrl}
        records={recordItems}
        allArtifacts={artifactItems}
        initialArtifactId={initialOpenArtifactId ?? null}
      />
    </>
  );
  const boardHeader = (content: React.ReactNode) => (
    <MissionBoardHeader
      back={back}
      title={mission.title}
      chip={stateChip}
      verified={verifiedPill}
      actions={<>{askAbout}{overflowMenu}</>}
      goal={goalLine}
      description={mission.description || !isTerminal ? <MissionDescription missionId={id} initialDescription={mission.description} readonly={isTerminal} defaultExpanded /> : undefined}
      serverNow={renderedAt}
      startedAt={boardModel.startedAt}
      endedAt={boardModel.endedAt}
      activeMs={boardModel.activeMs}
    >
      {shippedView && <MissionShippedHeader missionId={id} view={shippedView} />}
      {content}
      <div data-testid="mission-board-footer" className="mt-10">
        {footerRows}
      </div>
    </MissionBoardHeader>
  );

  return (
    <DisplayTimezoneProvider teamTimezone={teamTimezone}>
    <SwipeProvider>
    {/* Task sheet owner (S4): ?task= via native history, never the router. */}
    <TaskPanelWrapper
      missionId={id}
      workspaceId={mission.workspaceId}
      missionTitle={mission.title}
      chip={stateChip}
      feedTasks={feedTasks}
      from={from === 'home' || from === 'missions' || from === 'initiative' ? from : null}
      initiativeId={initiativeId ?? null}
    >
      {/* Real-time (S7): progress patches the live store the list reads;
          structural events re-render at most once per 3s, scroll-anchored. */}
      <MissionAutoRefresh
        missionId={id}
        workspaceId={mission.workspaceId ?? ''}
        taskIds={missionTaskIds}
        workerStatuses={renderedWorkerStatuses}
        renderedAt={renderedAt}
      >
      <MissionReconcileOnOpen missionId={id} />

      <MissionVisualReviewProvider missionId={id} visual={boardVisual}>
      <MissionSurfaceAuditWaiverProvider {...auditWaiverProps}>
      <MissionLayoutShell
        initial={parseMissionLayout(layoutParam, listViewParam)}
        board={boardHeader(<MissionOverview model={boardModel} completionText={completionText} notice={boardNotice} visual={boardVisual} {...boardLink} {...boardStrip} />)}
        flow={boardHeader(<FlowTimeline model={boardModel} sameFiles={flowSameFiles} expectedMinutes={flowExpectedMinutes} {...boardLink} />)}
        feed={boardHeader(
          <MissionFeedLayout
            model={boardModel}
            notes={feedNotes}
            completionText={completionText}
            notice={boardNotice}
            visual={boardVisual}
            notesEntry={<MissionNotesSheet missionId={id} />}
            {...boardLink}
          />,
        )}
      />
      </MissionSurfaceAuditWaiverProvider>
      </MissionVisualReviewProvider>
      </MissionAutoRefresh>
    </TaskPanelWrapper>
    </SwipeProvider>
    </DisplayTimezoneProvider>
  );
}


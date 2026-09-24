import { db } from '@buildd/core/db';
import { missions, workspaces, workspaceSkills, missionNotes, workers, tasks, initiatives } from '@buildd/core/db/schema';
import { eq, and, or, inArray, desc, isNotNull, isNull, ne } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, getUserWorkspaceIds } from '@/lib/team-access';
import { formatCompletionRecord } from '@/lib/mission-completion-record';
import { deriveTaskHealthSignal, formatNextRun, deriveMissionDisplayState, getMissionStateChip, selectMissionCompletionSummary, MISSION_COMPLETED_NOTE_TITLE, buildReviewerRetryMap } from '@/lib/mission-helpers';
import { computeMissionProgress, deriveMissionProgressMetric, deriveTaskType, deriveCriteriaGatePresentation, CRITERIA_GATE_TONE_CLASS, hasPendingDeliverableWork as computeHasPendingDeliverableWork, computeMissionAuthorshipHealth, computeMissionFlightStrip } from '@buildd/core/mission-helpers';
import { loadMissionFollowupTasks } from '@/lib/mission-followups';
import { MissionAuthorshipStats } from '@/components/MissionAuthorshipStats';
import { inferCriteriaFailureReading, describeCriteriaFailureReading } from '@/lib/criteria-rearm';
import { deriveChainPosition, LIVE_WORKER_STATUSES, type ChainPositionResult, type ChainPositionDep } from '@/lib/task-presentation';
import { getHeartbeatStatus, isOverdue as checkOverdue } from '@/lib/heartbeat-helpers';
import { isSystemWorkspace, displayWorkspaceName, type GoalCriterion, type GoalCriteriaState } from '@buildd/shared';
import { resolvePolicy } from '@/lib/merge-policy';
import { buildSteeringEvents, countOrchestratorPlans } from '@/lib/mission-steering-events';
import { selectMissionRecords } from '@/lib/flight-strip-nav';
import MissionVerifiedPill from './MissionVerifiedPill';
import MissionOverflowMenu from './MissionOverflowMenu';
import MissionMergePolicyRow from '@/components/MissionMergePolicyRow';
import MissionReviewSummary from './MissionReviewSummary';
import MissionInitiativeSelector, { type InitiativeOption } from './MissionInitiativeSelector';
import MissionInlineEdit from './MissionInlineEdit';
import MissionDescription from './MissionDescription';
import MissionAutoRefresh from './MissionAutoRefresh';
import MissionReconcileOnOpen from './MissionReconcileOnOpen';
import CondensedTimeline from './CondensedTimeline';
import type { CondensedTimelineGroups, CondensedTimelineTask, BookkeepingTask } from './CondensedTimeline';
import { buildAttemptStrips, partitionBookkeeping, repoFullNameFromPrUrl } from '@/lib/attempt-strip';
import { groupChainUnits } from '@/lib/condensed-timeline';
import type { CondensedTask, CondensedTaskWorker, ChainUnit } from '@/lib/condensed-timeline';
import StructureView from './StructureView';
import TaskPanelWrapper from './TaskPanelWrapper';
import { buildMissionFeedView, type MissionFeedViewTask } from './mission-feed-view';
import { MISSION_DETAIL_WITH, TASK_DIGEST_SELECTION, taskDigestWhere, indexTaskDigests } from './mission-page-query';
import HeartbeatStatusBadge from './HeartbeatStatusBadge';
import HeartbeatChecklistEditor from './HeartbeatChecklistEditor';
import QuietHoursConfig from './QuietHoursConfig';
import HeartbeatTimeline from './HeartbeatTimeline';
import MissionBackendSelector from './MissionBackendSelector';
import MissionMonitoringToggle from './MissionMonitoringToggle';
import ScheduleWizard from './ScheduleWizard';
import MissionConfig from './MissionConfig';
import MissionTabs from './MissionTabs';
import { parseMissionListView } from '@/lib/mission-list-view';
import { MissionNotesSheet } from './MissionFeed';
import MissionSecondaryPanel from './MissionSecondaryPanel';
import MissionDetailView, { mastheadBack, parseMissionOrigin } from './MissionDetailView';
import MissionDelivery from './MissionDelivery';
import MissionRecordsSheet from './MissionRecordsSheet';
import { MissionFlightStripInline, MissionStripExpand } from './MissionStripControls';
import { buildDeliverySteps, deliveryReleaseInput, missionTrunkMergedAt } from '@/lib/mission-delivery';
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
import { refreshWorkerMergeStateIfStale } from '@/lib/pr-reconcile';
import { loadReleaseFooterData } from '@/lib/release-footer';
import { MissionReleaseSection } from './MissionReleaseSection';
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
import MissionSituationBlock, { affordanceFor, MISSION_CRITERIA_ANCHOR } from '@/components/missions/MissionSituationBlock';
import { formatEstimatedUsd, ESTIMATED_COST_TITLE } from '@/lib/cost-label';

export const dynamic = 'force-dynamic';


export default async function MissionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  // `?tab=` is retired: accepted and ignored, so old links still land.
  searchParams: Promise<{ from?: string; initiativeId?: string; artifact?: string; view?: string }>;
}) {
  const { id } = await params;
  const { from, initiativeId, artifact: initialOpenArtifactId, view: listViewParam } = await searchParams;
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

  // Read-through refresh: stamp mergedAt on any completed workers whose PR
  // webhook was missed, so the timeline renders the correct state immediately.
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
        const refreshed = await Promise.all(
          staleWorkers.map(w => refreshWorkerMergeStateIfStale(w, installId))
        );
        if (refreshed.some(Boolean)) {
          const refreshedMission = await db.query.missions.findFirst({
            where: eq(missions.id, id),
            with: MISSION_DETAIL_WITH,
          });
          if (refreshedMission) mission = refreshedMission;
        }
      }
    }
  }

  // Everything from here to the merge-policy chip reads off the mission row
  // that is already in hand, and nothing in the group consumes another entry's
  // result — so it is one wait instead of five serial neon-http round trips
  // (roles/workspaces, reviewer notes, steering notes, policy workspace,
  // follow-ups). The derived, purely-computed values follow the group.
  const allMissionTaskIds = (mission.tasks || []).map(t => t.id);

  const [
    scopeResult,
    reviewerNotes,
    humanSteeringNotes,
    workspaceForPolicy,
    missionFollowupTasks,
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
    // Reviewer verdict notes for BT-16 (verdict chips)
    allMissionTaskIds.length > 0
      ? db.query.missionNotes.findMany({
          where: and(
            inArray(missionNotes.taskId, allMissionTaskIds),
            inArray(missionNotes.type, ['reviewer_approved', 'reviewer_request_changes', 'reviewer_escalated'] as any[]),
          ),
          columns: {
            taskId: true,
            type: true,
            title: true,
            body: true,
            status: true,
            supersededByPrNumber: true,
            createdAt: true,
          },
          orderBy: desc(missionNotes.createdAt),
        })
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
  ]);

  const { roles, teamWorkspaces } = scopeResult;

  // Map taskId → latest reviewer note
  const reviewerNoteMap = new Map<string, {
    type: string;
    title: string;
    body: string | null;
    status: string;
    supersededByPrNumber: number | null;
    createdAt: Date;
  }>();
  for (const note of reviewerNotes) {
    if (note.taskId && !reviewerNoteMap.has(note.taskId)) {
      reviewerNoteMap.set(note.taskId, note);
    }
  }

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
  const { totalTasks, completedTasks, awaitingMerge, segments } = computeMissionProgress(mission.tasks || []);
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
    const prCount = (mission.tasks ?? []).flatMap(t => (t.workers as any[] ?? [])).filter(w => w.prUrl).length;
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
  const healthState = deriveTaskHealthSignal({ ...mission, heartbeatWaitingUntil }, mission.tasks || []);

  // Orchestration mode
  const orchestrationMode = (mission.orchestrationMode as 'auto' | 'manual') ?? 'auto';
  const isHeld = (mission as any).isHeld === true;

  // Goal criteria that have not been verified keep the mission open — the header
  // must say that rather than "READY FOR REVIEW".
  const missionCriteria = (mission as any).goalCriteria as unknown[] | null;
  const missionCriteriaOverall = ((mission as any).goalCriteriaState as { overall?: string } | null)?.overall ?? null;
  const criteriaUnverified = Array.isArray(missionCriteria) && missionCriteria.length > 0 && missionCriteriaOverall !== 'pass';

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
  const [explained, spendUsd, trackerLinks] = await Promise.all([
    explainMission(id),
    costBudgetUsd != null ? getMissionSpendUsd(id) : Promise.resolve(null),
    // Linear Phase 2: only mount the tracking panel if this mission has a linear link.
    getLinksForEntity(db, 'mission', id),
  ]);
  const missionAnswer = explained?.subjects[0] ?? null;

  // Single derived display state for the header chip and CTA — read off the
  // SAME accessor answer the waiting-on panel renders, so the chip cannot say
  // AUTO/RUNNING while the panel below says blocked or idle. The historical
  // chain is only the fallback for when the explain read failed.
  const displayState = missionAnswer?.displayState ?? deriveMissionDisplayState({
    status: mission.status,
    isHeld,
    orchestrationMode,
    activeAgents,
    health: healthState,
    progress,
    criteriaUnverified,
    criteriaEscalatedAt: (mission as any).criteriaEscalatedAt ?? null,
    hasPendingDeliverableWork,
  });
  const stateChip = missionAnswer?.chip ?? getMissionStateChip(displayState);

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
  const hasPrimaryAction = missionAnswer
    ? affordanceFor(missionAnswer.situation.focus, { missionId: id, criteriaReachable }) !== null
    : false;

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

  // Settings panel summary — non-default values for the collapsed header
  const configSummaryParts: string[] = [];
  if (configModel) configSummaryParts.push(configModel.replace(/^claude-/, '').replace(/-latest$/, ''));
  if (mission.maxConcurrentTasks != null) configSummaryParts.push(`${mission.maxConcurrentTasks} concurrent`);
  if (costBudgetUsd != null) configSummaryParts.push(`$${parseFloat(costBudgetUsd).toFixed(0)} budget`);
  const configSummary = configSummaryParts.length > 0 ? configSummaryParts.join(', ') : null;

  // Heartbeat status
  const { lastStatus: lastHeartbeatStatus, lastAt: lastHeartbeatAt } = getHeartbeatStatus(
    (mission.tasks || []).map(t => ({
      id: t.id,
      createdAt: t.createdAt,
      status: t.status,
      result: digestOf(t.id).result,
    }))
  );
  const TERMINAL_STATUSES = ['completed', 'cancelled', 'budget_exhausted'];
  const heartbeatOverdue = isHeartbeat && !TERMINAL_STATUSES.includes(mission.status) && mission.schedule?.nextRunAt && scheduleCron
    ? checkOverdue(mission.schedule.nextRunAt, scheduleCron)
    : false;

  const scheduleNextRunAt = (mission.schedule as any)?.nextRunAt as string | null | undefined;
  const scheduleNextMs = scheduleNextRunAt ? new Date(scheduleNextRunAt).getTime() : null;
  const scheduleOverdue = mission.status === 'active' && scheduleNextMs != null && scheduleNextMs < Date.now();
  const scheduleOverdueMinutes = scheduleOverdue && scheduleNextMs != null ? Math.floor((Date.now() - scheduleNextMs) / 60000) : 0;
  const heartbeatTasks = isHeartbeat
    ? (mission.tasks || []).filter(t => t.status === 'completed' || t.status === 'failed')
    : [];

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

  // BT-16: Map reviewer tasks by their parentTaskId for chip tappability.
  // Reviewer tasks (category='review') are NOT shown as separate timeline rows;
  // they surface as inline verdict chips on the task they reviewed.
  const reviewerTaskMap = new Map<string, { id: string; status: string }>();
  for (const t of allTasks) {
    if (t.category === 'review' && t.parentTaskId) {
      reviewerTaskMap.set(t.parentTaskId, { id: t.id, status: t.status });
    }
  }

  // Fix tasks dispatched after a reviewer requested changes, parentTaskId →
  // the NEWEST retry (AC-21). allTasks is sorted ascending, so the old
  // "first entry wins" loop kept the oldest; the helper is order-independent.
  const reviewerRetryMap = buildReviewerRetryMap(allTasks.map(t => ({
    id: t.id,
    status: t.status,
    title: t.title,
    parentTaskId: t.parentTaskId,
    reviewerRetryPrNumber: (t as { reviewerRetryPrNumber?: number | null }).reviewerRetryPrNumber ?? null,
    createdAt: t.createdAt,
    workers: (t.workers as Array<{ prNumber?: number | null }> | null) ?? null,
  })));

  // §3.6: Deliverable tasks appear in the timeline; taskClass='work' → timeline.
  const timelineTasks = allTasks.filter(t => t.taskClass === 'work');

  // U8: attempts move onto their parent task's row via `attachAttempts` (wrapped
  // by buildAttemptStrips), so the footer keeps only genuine housekeeping —
  // orchestration planning runs, plus any attempt whose parent row is not
  // rendered (dropping those would delete the run's only published trace).
  const renderedTaskIds = new Set(timelineTasks.map(t => t.id));
  const attemptStrips = buildAttemptStrips(
    allTasks.map(t => ({
      id: t.id,
      status: t.status,
      taskClass: t.taskClass,
      parentTaskId: t.parentTaskId,
      roleSlug: t.roleSlug,
      creationSource: t.creationSource,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      ciRetryPrNumber: (t as any).ciRetryPrNumber ?? null,
      reviewerRetryPrNumber: (t as any).reviewerRetryPrNumber ?? null,
      conflictRetryPrNumber: (t as any).conflictRetryPrNumber ?? null,
      context: digestOf(t.id).context,
    })),
    {
      // No repo column is loaded here; every PR url on this mission points at
      // the same repo, so the first one names it. Null → no PR link, never a
      // guessed one.
      repoFullName: repoFullNameFromPrUrl(
        allTasks.flatMap(t => (t.workers || []) as Array<{ prUrl?: string | null }>).find(w => w.prUrl)?.prUrl,
      ),
      roleNameBySlug: new Map(roles.map(r => [r.slug, r.name])),
    },
  );

  const { footer: footerTasks } = partitionBookkeeping(allTasks, renderedTaskIds);

  // Collect bookkeeping tasks for the expandable footer
  const bookkeepingTasks: BookkeepingTask[] = footerTasks.map(t => {
    const lw = (t.workers as any[])?.[0];
    return {
      id: t.id,
      title: t.title,
      taskUpdatedAt: t.updatedAt.toISOString(),
      latestWorker: lw ? { prUrl: lw.prUrl ?? null, mergedAt: lw.mergedAt ? String(lw.mergedAt) : null } : null,
    };
  });

  // Compute chain positions for mission tasks
  const chainByTaskId = new Map<string, ChainPositionResult | null>();
  for (const task of allTasks) {
    const depIds = (task.dependsOn as string[] | null) ?? [];
    if (depIds.length === 0) {
      chainByTaskId.set(task.id, null);
      continue;
    }
    const deps = depIds.map(depId => {
      const dep = taskMap.get(depId);
      if (!dep) return null;
      // Map every loaded worker, not just the latest: the gate asks whether ANY
      // worker holds an open PR. prLifecycleStatus='closed' releases the guard.
      const depWorkers = (dep.workers as Array<{ prUrl?: string | null; prNumber?: number | null; mergedAt?: Date | string | null; prLifecycleStatus?: string | null }> | null) ?? [];
      return {
        id: dep.id,
        title: dep.title,
        status: dep.status,
        dependsOn: (dep.dependsOn as string[] | null) ?? [],
        workers: depWorkers.map(w => ({
          prUrl: w.prUrl ?? null,
          prNumber: w.prNumber ?? null,
          mergedAt: w.mergedAt ? String(w.mergedAt) : null,
          prLifecycleStatus: w.prLifecycleStatus ?? null,
        })),
      };
    }).filter(Boolean) as ChainPositionDep[];
    const dependents = allTasks.filter(t => ((t.dependsOn as string[] | null) ?? []).includes(task.id)).length;
    chainByTaskId.set(task.id, deriveChainPosition({ task: { id: task.id, status: task.status }, deps, dependents }));
  }

  // ── I-7: Condensed timeline — build groups ────────────────────────────────

  // Normalise a DB worker row to CondensedTaskWorker (all strings, no Date objects)
  function normaliseWorker(w: {
    id: string;
    status: string;
    prUrl?: string | null;
    prNumber?: number | null;
    prLifecycleStatus?: string | null;
    mergedAt?: Date | string | null;
    completedAt?: Date | string | null;
    startedAt?: Date | string | null;
    currentAction?: string | null;
    branch?: string | null;
    waitingFor?: unknown;
  }): CondensedTaskWorker {
    return {
      id: w.id,
      status: w.status,
      prUrl: w.prUrl ?? null,
      prNumber: w.prNumber ?? null,
      prLifecycleStatus: w.prLifecycleStatus ?? null,
      mergedAt: w.mergedAt ? String(w.mergedAt) : null,
      completedAt: w.completedAt ? String(w.completedAt) : null,
      startedAt: w.startedAt ? String(w.startedAt) : null,
      currentAction: w.currentAction ?? null,
      branch: w.branch ?? null,
      waitingFor: (w.waitingFor as { type: string; prompt: string; options?: string[] } | null) ?? null,
    };
  }

  // Build CondensedTask objects for the grouping function.
  // A completed task with an unmerged PR always lands in "Waiting on you" —
  // its terminal state is its PR's state, not the task's (task facae217) —
  // regardless of merge-policy tier or reviewer verdict. See isWaitingOnYou
  // in condensed-timeline.ts.
  const condensedTasksForGrouping: CondensedTask[] = timelineTasks.map(task => ({
    id: task.id,
    status: task.status,
    dependsOn: (task.dependsOn as string[] | null) ?? null,
    workers: ((task.workers || []) as any[]).map(normaliseWorker),
  }));
  const condensedTaskMapForGrouping = new Map(condensedTasksForGrouping.map(t => [t.id, t]));

  const rawGroups = groupChainUnits(condensedTasksForGrouping, condensedTaskMapForGrouping);

  // Mission-level claim gate, hoisted once: `mission` is a reassignable `let`, so
  // TS cannot narrow it inside the closure below.
  const missionBudgetExhausted = mission?.status === 'budget_exhausted';

  // Convert a raw group member to a CondensedTimelineTask with enriched display fields
  function toTimelineTask(condensedTask: CondensedTask): CondensedTimelineTask {
    const task = taskMap.get(condensedTask.id)!;
    const role = task.roleSlug ? rolesMap.get(task.roleSlug) : null;
    const reviewerNote = reviewerNoteMap.get(task.id) ?? null;
    const reviewerTaskRef = reviewerTaskMap.get(task.id);
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      taskCreatedAt: task.createdAt.toISOString(),
      taskUpdatedAt: task.updatedAt.toISOString(),
      roleColor: role?.color ?? '#8A8478',
      dependsOn: (task.dependsOn as string[] | null) ?? null,
      pathManifest: ((task as any).pathManifest as string[] | null) ?? null,
      chain: chainByTaskId.get(task.id) ?? null,
      // Mission-level claim gate: a budget_exhausted mission blocks every one of
      // its pending tasks until a human raises the budget, and it never clears on
      // its own. Surfacing it per row keeps this timeline from showing an
      // unclaimable task as QUEUED (rule CG-2).
      missionBudgetExhausted: missionBudgetExhausted,
      latestWorker: condensedTask.workers[0] ?? null,
      taskType: deriveTaskType({ title: task.title, parentTaskId: task.parentTaskId, mode: task.mode }),
      // The three `deriveWorkKind` inputs, plus the stored phase. Carried as
      // data on the task object so `buildRail` and `computeStructureLayout` —
      // both pure functions over the task array, neither holding a database
      // handle — read the identical value.
      kind: task.kind ?? null,
      roleSlug: task.roleSlug ?? null,
      missionPhaseIndex: task.missionPhaseIndex ?? null,
      missionPhaseLabel: task.missionPhaseLabel ?? null,
      loopState: task.loopState ?? null,
      loopMaxLoops: task.loopConfig ? ((task.loopConfig as any).maxLoops ?? 5) : null,
      loopIteration: task.loopConfig ? task.loopIteration : null,
      startAt: task.startAt?.toISOString() ?? null,
      loopExitConditionType: (task.loopConfig as any)?.exitCondition?.type ?? null,
      reviewerNote: reviewerNote
        ? {
            type: reviewerNote.type,
            title: reviewerNote.title,
            body: reviewerNote.body,
            status: reviewerNote.status,
            supersededByPrNumber: reviewerNote.supersededByPrNumber,
          }
        : null,
      reviewerTaskHref: reviewerTaskRef ? `/app/tasks/${reviewerTaskRef.id}` : null,
      reviewerRetryTask: reviewerRetryMap.get(task.id) ?? null,
      attempts: attemptStrips.get(task.id) ?? null,
    };
  }

  function toChainUnit(chain: ChainUnit<CondensedTask>): ChainUnit<CondensedTimelineTask> {
    return { head: toTimelineTask(chain.head), tail: chain.tail.map(toTimelineTask), shape: chain.shape };
  }

  const timelineGroups: CondensedTimelineGroups = {
    waitingOnYou: rawGroups.waitingOnYou.map(toChainUnit),
    running: rawGroups.running.map(toChainUnit),
    nextQueued: rawGroups.nextQueued.map(toChainUnit),
    blocked: rawGroups.blocked.map(toChainUnit),
    done: rawGroups.done.map(toChainUnit),
    failed: rawGroups.failed.map(toChainUnit),
  };

  // Structure view: flat chain list (same identifyChains result shared with Timeline)
  const allChains: ChainUnit<CondensedTimelineTask>[] = [
    ...timelineGroups.waitingOnYou,
    ...timelineGroups.running,
    ...timelineGroups.nextQueued,
    ...timelineGroups.blocked,
    ...timelineGroups.done,
    ...timelineGroups.failed,
  ];

  // Retry lineage: childId → parentId for tasks both present in the timeline task
  // set. Consumed by StructureView only; the mobile feed folds a retry under its
  // parent row as an attempt instead (addendum D1).
  const timelineTaskIdSet = new Set(timelineTasks.map(t => t.id));
  const retryLinks = new Map<string, string>();
  for (const t of timelineTasks) {
    if (t.parentTaskId && timelineTaskIdSet.has(t.parentTaskId)) {
      retryLinks.set(t.id, t.parentTaskId);
    }
  }

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

  // ── Flight strip navigator (docs/design/mission-flight-strip.md §7) ────────
  // Bars come from deliverable (taskClass='work') spans only — an orchestrator
  // planning task has no lane and would otherwise render as a misclassified
  // BUILD bar. Steering marks are supplied separately, on the options bag.
  const flightStripTasks = timelineTasks.map(t => ({
    id: t.id, status: t.status, taskClass: t.taskClass, roleSlug: t.roleSlug, kind: t.kind, title: t.title,
    creationSource: t.creationSource, mode: t.mode,
  }));
  const flightStripWorkers = timelineTasks.flatMap(t =>
    ((t.workers ?? []) as any[]).map(w => ({
      id: w.id, taskId: t.id, status: w.status, startedAt: w.startedAt, completedAt: w.completedAt,
      updatedAt: w.updatedAt, exitCause: w.exitCause,
    }))
  );
  const steeringEvents = buildSteeringEvents(
    allTasks.map(t => ({
      id: t.id, mode: t.mode, creationSource: t.creationSource,
      workers: ((t.workers ?? []) as any[]).map(w => ({ turns: w.turns, startedAt: w.startedAt })),
    })),
    humanSteeringNotes,
  );
  const flightStripData = computeMissionFlightStrip(flightStripTasks, flightStripWorkers, {
    missionCompletedAt: (mission as any).completedAt ?? null,
    steeringEvents,
  });
  const orchestratorPlans = countOrchestratorPlans(flightStripData.rail);
  const orchestratorTicks = (mission.schedule as any)?.totalChecks ?? 0;
  const missionRecords = selectMissionRecords(allArtifacts);

  // Goal criteria — hoisted so the header's Verified pill and its bottom
  // sheet (MissionVerifiedPill) read the same values the removed
  // always-visible block used to.
  const goalCriteria = ((mission as any).goalCriteria as GoalCriterion[] | null) ?? [];
  const goalCriteriaStateFull = (mission as any).goalCriteriaState as GoalCriteriaState | null;
  const autoVerifyFlag = (mission as any).autoVerify as boolean | null;

  // ── Mission feed (docs/design/mission-feed-mobile-continuity.md) ──────────
  // Every mission task in the one input shape the pulse, the grouped list and
  // the task sheet all read — so the header pulse, the list and `n / N` count
  // the same rows (addendum D1). Attempts and bookkeeping are folded by the
  // builders, never here (mission-feed-view.ts, unit-tested).
  const {
    feedTasks, pulseSegments, segmentLabels, pulseCaption, recordsCountByTask, liveLines,
  } = buildMissionFeedView(allTasks as unknown as MissionFeedViewTask[], { activeAgents, liveStatuses });
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
  const [initiativeName, teamInitiativeOptions, releaseFooterData, completionNote] = await Promise.all([
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
  ]);

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
  const prCount = allWorkers.filter(w => w.prUrl).length;
  const durationLabel = mission.status === 'completed'
    ? (flightStripData.agentTimeMin > 0 ? fmtMin(flightStripData.agentTimeMin) : flightStripData.axisSpanMin > 0 ? fmtMin(flightStripData.axisSpanMin) : null)
    : null;
  const deliverySteps = buildDeliverySteps({
    missionStatus: mission.status,
    totalTasks,
    completedTasks,
    awaitingMerge,
    integrationPr: missionIntegrationPr,
    criteria: { total: criteriaTotal, passed: criteriaPassed, overall: missionCriteriaOverall },
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
    durationLabel: durationLabel ? `${durationLabel} agent time` : null,
  });

  const missionPrCard = shouldRenderMissionPrBlock(missionIntegrationPr, { workLanded: totalTasks > 0 && completedTasks >= totalTasks }) && missionIntegrationPr ? (
    // Mission integration PR (Option A′) — the mission's review gate, and a
    // different object from the task PRs that fed the branch.
    <div className={`card p-3 border-l-2 ${missionIntegrationPr.state === 'merged' ? 'border-status-success/40' : missionIntegrationPr.state === 'closed' ? 'border-status-error/40' : 'border-status-warning/40'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-[10px] font-mono uppercase tracking-wider text-text-muted">Mission PR</span>
            <span className={`shrink-0 border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${missionIntegrationPr.state === 'merged' ? 'border-status-success/40 text-status-success' : missionIntegrationPr.state === 'closed' ? 'border-status-error/40 text-status-error' : 'border-status-warning/40 text-status-warning'}`}>
              {MISSION_PR_STATE_LABEL[missionIntegrationPr.state]}
            </span>
            <span className="text-[10px] font-mono text-text-muted truncate">{missionIntegrationPr.branch}</span>
          </div>
          <p className="text-[13px] text-text-secondary">
            {missionIntegrationPr.state === 'not_opened'
              ? `Every task PR under this mission merges into its integration branch. No PR from that branch into the target branch exists yet — so none of this mission's work has reached the target branch.`
              : missionIntegrationPr.state === 'merged'
                ? `This mission's work reached the target branch through one PR from its integration branch.`
                : `This is the mission's review gate: one PR from the integration branch into the target branch. The merge policy applies here, not to the task PRs that fed it.`}
          </p>
        </div>
        {missionIntegrationPr.prUrl && (
          <a
            href={missionIntegrationPr.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-[12px] font-mono text-text-secondary hover:text-text-primary transition-colors"
          >
            #{missionIntegrationPr.prNumber} →
          </a>
        )}
      </div>
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
      <p className="text-[12px] text-text-secondary">
        {spendUsd != null
          ? `${formatEstimatedUsd(spendUsd, 4)} spent vs $${budgetUsd.toFixed(2)} budget — no new tasks will spawn.`
          : `Budget of $${budgetUsd.toFixed(2)} reached — no new tasks will spawn.`}
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
    shareToken: a.shareToken ?? null,
    visibility: (a.visibility as 'private' | 'public') ?? 'private',
    metadata: (a.metadata as Record<string, unknown>) ?? {},
    createdAt: String(a.createdAt),
    taskTitle: a.taskTitle ?? null,
  }));
  const recordIds = new Set(missionRecords.map(a => a.id));
  const recordItems = artifactItems.filter(a => recordIds.has(a.id));

  const situation = (
    <>
      {/* ── The situation — what this mission is waiting on, and the one
          action that advances it. Rendered from `explain`'s answer, the shared
          accessor; the mission card renders the same sentence. */}
      {missionAnswer && (
        <MissionSituationBlock
          missionId={id}
          situation={missionAnswer.situation}
          because={missionAnswer.because}
          criteriaReachable={criteriaReachable}
        />
      )}

      {/* ── Waiting on: owner decision — one owner for mission state. Naming
          which remedy the cycle history supports (inferCriteriaFailureReading)
          is the difference between an owner editing one line and an owner
          filing a phantom task. */}
      {displayState === 'waiting_decision' && (() => {
        const reading = inferCriteriaFailureReading(goalCriteriaStateFull);
        const readingCopy = describeCriteriaFailureReading(reading);
        // First non-passing criterion, by its stable `index` — not array
        // position in `criteria`, which can skip entries.
        const failingState = (goalCriteriaStateFull?.criteria ?? []).find(c => c.verdict !== 'pass') ?? null;
        const failingCriterionIndex = failingState ? failingState.index : null;
        const failingCriterion = failingCriterionIndex != null ? goalCriteria[failingCriterionIndex] ?? null : null;
        const fileWorkHref = buildFileWorkHref({
          missionId: id,
          missionTitle: mission.title,
          criterion: failingCriterion,
          evidence: failingState?.evidence ?? null,
        });
        return (
          <div className="mb-3 border border-status-warning/30 bg-status-warning/5 px-3 py-2.5">
            <div className="flex items-start gap-2">
              <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-status-warning">
                Waiting for human decision
              </span>
              <span className="text-[12px] text-text-secondary">{readingCopy}</span>
            </div>
            <MissionDecisionSheet
              missionId={id}
              goalCriteria={goalCriteria}
              failingCriterionIndex={failingCriterionIndex}
              fileWorkHref={fileWorkHref}
            />
          </div>
        );
      })()}

      {/* ── Criteria gate, only for a caller the accessor could not answer for
          (the explain read failed), so the gate is never silent. */}
      {!missionAnswer && displayState !== 'waiting_decision' && criteriaGate && criteriaGate.state === 'unverified' && (
        <p className="mb-3 text-[12px] text-text-muted">
          Completion gated by {countOf(missionCriteria!.length, 'criterion', 'criteria')}, not yet verified.
        </p>
      )}
      {!missionAnswer && displayState !== 'waiting_decision' && criteriaGate && (criteriaGate.state === 'failing' || criteriaGate.state === 'refused') && (
        <div className={`mb-3 flex items-start gap-2 border px-3 py-2.5 ${criteriaGate.tone === 'error' ? 'border-status-error/30 bg-status-error/5' : 'border-status-warning/30 bg-status-warning/5'}`}>
          <span className={`shrink-0 text-[11px] font-semibold uppercase tracking-wide ${CRITERIA_GATE_TONE_CLASS[criteriaGate.tone]}`}>
            {criteriaGate.label}
          </span>
          {criteriaGate.detail && <span className="text-[12px] text-text-secondary">{criteriaGate.detail}</span>}
        </div>
      )}

      {/* Completion summary — the outcome, for a completed mission. */}
      {completionPick && (
        <div className="card p-3 mb-3 border-l-2 border-status-success/40">
          <div className="flex items-center gap-2 mb-1.5">
            <h3 className="text-[10px] font-semibold tracking-wider text-text-muted uppercase">
              Completed {new Date(mission.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </h3>
            {completionPick.source === 'completion_record' && (
              <span className="font-mono text-[9px] uppercase tracking-wide border border-text-muted/40 text-text-muted px-1 py-px shrink-0">
                completion record
              </span>
            )}
          </div>
          <p className="text-[13px] text-text-secondary leading-relaxed whitespace-pre-line">
            {/* The record's body is machine-shaped (a status histogram, a raw ISO
                time); read it the way the rest of the page reads. */}
            {completionPick.source === 'completion_record' ? formatCompletionRecord(completionPick.text) : completionPick.text}
          </p>
        </div>
      )}
    </>
  );

  const delivery = (
    <MissionDelivery
      steps={deliverySteps}
      details={{
        integrated: missionPrCard || reviewSummary ? <div className="space-y-2">{missionPrCard}{reviewSummary}</div> : undefined,
        // W2: Verified → the Verified pill's sheet (it opens on this hash).
        verified: criteriaReachable ? (
          <a
            href={`#${MISSION_CRITERIA_ANCHOR}`}
            className="flex min-h-11 items-center gap-2 font-mono text-[12px] text-accent-text hover:underline"
          >
            <span className="flex-1">Open goal criteria</span>
            <span aria-hidden="true">›</span>
          </a>
        ) : undefined,
        budget: budgetDetail ?? undefined,
      }}
      rows={{
        // F6: one line for THIS mission's release status, linking to the
        // release. No workspace queue, no Release now.
        shipped: mission.workspaceId ? (
          <MissionReleaseSection
            step={deliverySteps.find(s => s.key === 'shipped')}
            releaseId={releaseFooterData?.releaseId ?? null}
            workspaceId={mission.workspaceId}
          />
        ) : undefined,
      }}
    />
  );

  const settings = (
    <MissionSecondaryPanel variant="row" configSummary={configSummary}>
      {/* Where this mission sits, and the chips that used to crowd the header. */}
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-text-muted">
        {mission.workspace && !isSystemWorkspace(mission.workspace.name) && (
          <Link href={`/app/workspaces/${mission.workspace.id}`} className="text-accent-text hover:underline">
            {displayWorkspaceName(mission.workspace.name)}
          </Link>
        )}
        {displayState === 'active' && driveNextRun.text && (
          <span className="font-mono text-[11px]">{driveNextRun.text}</span>
        )}
        {isHeartbeat && (
          <HeartbeatStatusBadge lastStatus={lastHeartbeatStatus} lastAt={lastHeartbeatAt} isOverdue={heartbeatOverdue} />
        )}
        {mission.workspaceId && (hasPolicyOverride || awaitingMerge > 0) && (
          <Link
            href={`/app/settings/workspace/${mission.workspaceId}`}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono bg-surface-3 text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors"
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
        />
      )}

      {!['completed', 'archived'].includes(mission.status) && (
        <div>
          <h2 className="section-label mb-2">Agent backend</h2>
          <MissionBackendSelector missionId={id} initialBackend={((mission as { defaultBackend?: 'claude' | 'codex' | null }).defaultBackend) ?? null} />
          <p className="text-[11px] text-text-muted mt-1.5">Default engine for tasks spawned by this mission. Auto inherits the role or workspace default.</p>
        </div>
      )}

      {/* Evaluation Log — heartbeat missions only */}
      {isHeartbeat && heartbeatTasks.length > 0 && (
        <HeartbeatTimeline
          tasks={heartbeatTasks.map(t => ({
            id: t.id,
            createdAt: t.createdAt,
            status: t.status,
            result: digestOf(t.id).result,
          }))}
        />
      )}

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
        <div className="card p-4">
          <h2 className="section-label mb-4">Configuration</h2>
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
                <span className="text-[11px] text-text-muted uppercase tracking-wider font-semibold">Merge Policy</span>
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
          chip row (addendum D2: no internal jargon on cards or headers). */}
      <div className="card p-4" data-testid="mission-diagnostics">
        <h2 className="section-label mb-2">Diagnostics</h2>
        <MissionAuthorshipStats health={authorshipHealth} />
      </div>
    </MissionSecondaryPanel>
  );

  return (
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

      <MissionDetailView
        missionId={id}
        title={mission.title}
        chip={stateChip}
        segments={pulseSegments}
        segmentLabels={segmentLabels}
        caption={pulseCaption}
        back={mastheadBack(from, breadcrumb.links)}
        verified={showVerifiedPill ? (
          <MissionVerifiedPill
            missionId={id}
            criteria={goalCriteria}
            criteriaState={goalCriteriaStateFull}
            autoVerify={autoVerifyFlag}
            readonly={isTerminal}
            failingCiPrNumbers={failingCiPrNumbers.length > 0 ? failingCiPrNumbers : undefined}
            overall={missionCriteriaOverall as 'pass' | 'fail' | 'UNVERIFIED' | 'NOT_EVALUATED' | 'PENDING' | null}
          />
        ) : undefined}
        actions={(
          <MissionOverflowMenu
            missionId={id}
            currentStatus={mission.status}
            cronExpression={scheduleCron}
            workspaceId={mission.workspaceId}
            roles={roles}
            hasSchedule={!!scheduleCron}
            orchestrationMode={mission.orchestrationMode as 'auto' | 'manual' | undefined ?? 'auto'}
            isHeld={isHeld}
            displayState={displayState}
            hasPrimaryAction={hasPrimaryAction}
          />
        )}
        expand={<MissionStripExpand data={flightStripData} missionId={id} missionTitle={mission.title} />}
        desktopStrip={<MissionFlightStripInline data={flightStripData} />}
        description={<MissionDescription missionId={id} initialDescription={mission.description} readonly={isTerminal} />}
        situation={situation}
        delivery={delivery}
        feed={{
          tasks: feedTasks,
          now: renderedAt,
          from: parseMissionOrigin(from),
          initiativeId: initiativeId ?? null,
          recordsCountByTask,
          liveLines,
        }}
        desktopList={(
          <MissionTabs
            initialView={parseMissionListView(listViewParam)}
            timelineContent={(
              <CondensedTimeline
                groups={timelineGroups}
                segments={segments}
                effectivePolicyTier={effectivePolicy.tier}
                policyLabel={policyLabel}
                missionId={id}
                allTasksCount={allTasksCount}
                missionCompleted={mission.status === 'completed'}
                bookkeepingTasks={bookkeepingTasks}
              />
            )}
            structureContent={allChains.length > 0 ? (
              <StructureView
                chains={allChains}
                taskMap={condensedTaskMapForGrouping}
                missionId={id}
                retryLinks={retryLinks.size > 0 ? retryLinks : undefined}
              />
            ) : undefined}
          />
        )}
        orchestratorRow={(orchestratorPlans > 0 || bookkeepingTasks.length > 0) ? (
          <details data-testid="mission-orchestrator-row" className="group border-t border-border-default">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 font-mono text-[12px] text-text-secondary hover:text-text-primary [&::-webkit-details-marker]:hidden">
              <span aria-hidden="true" className="text-text-muted">─</span>
              <span className="flex-1">
                {`Orchestrator · ${countOf(orchestratorPlans, 'plan', 'plans')}, ${countOf(orchestratorTicks, 'tick', 'ticks')}`}
              </span>
              <span aria-hidden="true" className="group-open:rotate-90">›</span>
            </summary>
            <ul className="pb-2">
              {bookkeepingTasks.map(t => (
                <li key={t.id}>
                  <Link
                    href={taskPageHref({ taskId: t.id, missionId: id })}
                    className="flex min-h-11 items-center gap-2 pl-5 font-mono text-[11px] text-text-secondary hover:text-text-primary"
                  >
                    <span className="min-w-0 truncate">{t.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        ) : undefined}
        footer={(
          <>
            <MissionRecordsSheet
              missionId={id}
              baseUrl={baseUrl}
              records={recordItems}
              allArtifacts={artifactItems}
              initialArtifactId={initialOpenArtifactId ?? null}
            />
            <MissionNotesSheet missionId={id} />
            {settings}
          </>
        )}
      />
      </MissionAutoRefresh>
    </TaskPanelWrapper>
    </SwipeProvider>
  );
}

function fmtMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  if (h >= 24) { const d = Math.floor(h / 24); return `${d}d ${h % 24}h`; }
  return `${h}h ${m}m`;
}

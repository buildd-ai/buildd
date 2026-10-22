import { admitsNoteToNeedsYou } from '@buildd/core/needs-you';
import { after } from 'next/server';
import { repoFullNameFromPrUrl } from '@/lib/repo-scope';
import { peekGithubApproval, refreshGithubApprovals, type ApprovalRefresh } from '@/lib/github-approval';
import { WORKSPACE_INSTALLATION_WITH, pickWorkspaceRepoIdentity, createTeamInstallationResolver } from '@/lib/workspace-installation';
import { resolveHumanPrReview, isCurrentReviewApproved, reviewFactsForAdvice, type HumanPrReview } from '@/lib/reviewer-gate';
import { attachMergeAdvice } from '@/lib/merge-advice-server';
import { db } from '@buildd/core/db';
import { readRound } from '@/lib/read-round';
import { tasks, workers, missions as missionsTable, missionSummaries, initiatives, workspaceSkills, workspaces as workspacesTable, teams as teamsTable, missionNotes, secrets, connectors, actionQueueSnoozes, specDiscrepancies } from '@buildd/core/db/schema';
import { eq, and, inArray, desc, gte, gt, sql, isNotNull, or, isNull, ne } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { readGithubAccessBlock } from '@/lib/github-repo-access';
import { getUserTeamRole, resolveActiveTeamScope } from '@/lib/team-access';
import { allowanceHoursOf, hostedRunnerBannerFor } from '@/lib/hosted-runner-usage-store';
import { HostedRunnerBanner } from '@/components/hosted-runner/HostedRunnerBanner';
import { EMPTY_SERVICE_STATUS, serviceStatusReads, serviceStatusView, type ServiceStatusView } from '@/lib/service-status-loader';
import { ServiceStatusBanner } from '@/components/service-status/ServiceStatusList';
import ModelUpgradeNotice from '@/components/models/ModelUpgradeNotice';
import { roleHas as roleHasPermission } from '@/lib/permission-registry';
import { homeAudience, homeChatPlacement, type HomeChatPlacement } from './home-view';
import { resolvePolicy, isMissionIntegrationBase } from '@/lib/merge-policy';
import { noRowOfPrMerged, oneRowPerPr } from '@/lib/pr-merge-stamp';
import { workerNotDependencyBotPr } from '@/lib/dependency-bot-pr';
import { missionPrMergeDecision } from '@/lib/mission-pr';
import { isMissionPrTask } from '@buildd/core/mission-integration';
import { getDeliveryViewsForTasks } from '@/lib/workflow/delivery-view';
import { prLifecycleFor } from '@/lib/delivery-overlay';
import { classifyConflictFix } from '@/lib/conflict-fix-liveness';
import { isActionableChip, kernelInboxMembership, missionPrRoleOf, reviewMachineActing, buildActionQueue, buildDecideItems, buildDiscrepancyItems, buildFailedTaskItems, summariseActionQueueAge } from '@/lib/action-queue';
import { describeConflictReason } from '@/lib/merge-blocker';
import { describeCriteriaBlocker } from '@/lib/criteria-blocker-copy';
import { resolveCiGate } from '@/lib/ci-gate';
import { DEFAULT_MAX_CI_RETRIES } from '@/lib/ci-retry';
import type { CiGate, PrLifecycle } from '@/lib/ci-gate';
import type { ActionQueueItem, EscalationGateMark, WaitingOnYouRawItem } from '@/lib/action-queue';
import { gateEscalations } from '@/lib/escalation-gate-check';
import { agentReviewsDataMigrations, MISSION_SUMMARY_VERSION } from '@buildd/shared';
import { ACCESS_NEEDS_YOU, SCHEDULE_MOVE_NEEDS_YOU, ESCALATION_GATE_READ_DEPS, HOME_MISSION_SUMMARIES } from '@/modules';
import type { MissionHomeReading } from '@/lib/mission-summary';
import type { LiveHomeReading } from '@/lib/mission-summary-home';
import { loadLandingStalls, prSubjectFor } from '@/lib/escalation-subjects';
import { needsReconnect } from '@/lib/connector-status';
import { refreshStaleWorkersForWorkspaces } from '@/lib/pr-state-refresh';
import { DEFAULT_MAX_CONFLICT_ITERATIONS, isAutoResolveMergeConflictsEnabled } from '@/lib/conflict-retry';
import { Suspense } from 'react';
import PrActionSheet from './PrActionSheet';
import { parsePrParam, prSheetSignInHref } from './pr-sheet';
import InitiativeFilterChips from '@/components/InitiativeFilterChips';
import { LIVE_TASK_STATUSES, LIVE_WORKER_STATUSES } from '@/lib/task-presentation';
import { homeMissionRecencyWhere, MISSION_CARD_TASK_COLUMNS, MISSION_CARD_TASK_EXTRAS, MISSION_CARD_WORKERS_WITH } from '@/lib/mission-card-views';
import { sqlExtras, sqlOrderBy, sqlOrderByFn, sqlWhere } from '@buildd/core/db/relational-sql';
import { resolveLandingOwnership, landingModeOf, resolveReviewerGate, resolveReviewInFlight, deriveStoredVerdictFallback, gateReachesActionQueue } from '@/lib/reviewer-gate';
import type { ReviewerGateResult, ReviewerTaskStatus } from '@/lib/reviewer-gate';
import { createReviewerStallFactsLoader } from '@/lib/reviewer-stall-facts';
import { selectReviewerEvidence } from '@/lib/reviewer-evidence';
import HomeLive, { type HomeRegion } from './HomeLive';
import { deliveryAtRead, groupQuietCauses, quietCauseOf, selectHomeMilestones, type MissionDeliveryRow, type QuietMissionCause } from '@/lib/delivery-projection';
import { deriveHomeNeedsYou } from '@/lib/home-needs-you';
import type { HomeListedMission } from '@/lib/home-attention';
import type { HomeHeldMission, HomeQuestion } from './NeedsYouCards';
import { fleetHeartbeatsQuery, homeQuestionsFrom, homeQuestionWorkersQuery, admittedQuestionRows, loadHomeFleet, loadQueueHistory } from '@/lib/home-fleet';
import { loadSupersededQuestionTaskIds } from '@/lib/incident-recovery-load';
import { AgentsPanel } from './AgentsPanel';
import { LandedThisWeek, type LandedMission } from './LandedThisWeek';
import { buildAgentsModel } from '@/lib/home-agents';
import { idleWhileQueued } from '@/lib/idle-while-queued';
import { loadOccupancySeries } from '@/lib/fleet-occupancy-query';
import { startOfDayInZone, type FleetHeartbeatRow } from '@/lib/fleet-view';
import { withLiveRunnerBeats } from '@/lib/runner-beats';
import { shortAgo } from '@/lib/mission-list-card';
import { applyStrandChoice } from '@/lib/strand-choice-shadow';
import { missionTaskHref, taskAnswerHref } from '@/lib/mission-task-href';
import { getChatAvailability } from '@/lib/chat-availability';
import HomeChatCard from '@/components/chat/HomeChatCard';
import GettingStartedChecklist from '@/components/onboarding/GettingStartedChecklist';
import { firstTaskState, gettingStartedChecklist, type FirstTaskState } from '@/lib/getting-started';
import { agentCredentialProbe } from '@/lib/getting-started-load';
import { teamCredentialWhere } from '@buildd/core/secrets/team-scope';
import { missionCardHref, type MissionCardRow } from '@/lib/mission-card-view';
import type { MissionVisualReviewState } from '@/lib/workflow/visual-review-state';
import { HOME_JUST_LANDED_WINDOW_MS, isRecentlyDelivered } from '@/lib/recently-delivered';
import { withPageBudget } from '@/lib/page-budget-watch';

export const dynamic = 'force-dynamic';

/*
 * Home's data (Living Spec "Fast at any size": R-1, R-9, R-11..R-15, R-18).
 *
 * One loader, `loadHomeView`, returns exactly what Home renders, in at most
 * three rounds of database calls, each one round trip (a neon-http batch of
 * the round's independent reads):
 *
 *   1. everything that depends only on the team and its workspaces: the
 *      missions from their stored summaries (`mission_summaries`, bounded:
 *      the three moving toward delivery, the held / stranded / just-landed
 *      ones, and counts), the open PRs, the Needs-you sources, the banners;
 *   2. what those rows point at: reviewer tasks and notes, fix attempts,
 *      upstream tasks, delivery views, initiative names;
 *   3. the escalation gate's stored verdicts and the merge advice ledger.
 *
 * The user, the team scope and chat availability are the protected layout's
 * reads, shared per request (React cache()). Nothing here calls GitHub or a
 * model, or writes, before the response: GitHub approvals and the visual
 * review are read from cache or from the stored summary, and their refreshes,
 * the PR fact import and the lapsed-grant expiry run in after(). The Agents
 * panel (fleet lanes, the day's occupancy) streams in behind Suspense.
 */

/** Missions Home derives live, per load, while their stored summary is missing (not yet backfilled). */
const HOME_LIVE_SUMMARY_CAP = 100;
/** Held, stranded and just-landed missions read for Needs you and Landed. */
const HOME_LISTED_MISSION_CAP = 40;
/** A completed mission lands on Home for this long. */
const RECENT_DONE_MS = HOME_JUST_LANDED_WINDOW_MS;
const OPEN_MISSION_STATUSES = ['active', 'paused', 'budget_exhausted'] as const;
const MOVING_KINDS = ['landing', 'audit', 'repair', 'build'] as const;

/** What Home renders, and nothing else. */
interface HomeView {
  teamWorkspaces: { id: string; name: string }[];
  workspaceCount: number;
  refreshWorkspaceIds: string[];
  serviceStatus: ServiceStatusView;
  hostedRunnerBanner: { level: 'warn' | 'used'; text: string } | null;
  modelUpgradeTeamId: string | null;
  chatPlacement: HomeChatPlacement;
  chatTeamId: string | null;
  hasAgentCredential: boolean | null;
  firstTask: FirstTaskState;
  runnerConnected: boolean | undefined;
  actionQueue: ActionQueueItem[];
  discrepancyOverflowCount: number;
  actionQueueInitiatives: Array<{ id: string; title: string }>;
  questions: HomeQuestion[];
  held: HomeHeldMission[];
  listed: HomeListedMission[];
  openMissions: number;
  milestones: MissionDeliveryRow[];
  quietMissions: number;
  quietCauses: QuietMissionCause[];
  landedWeek: LandedMission[];
  teamTz: string | null;
  /** The Agents panel's scope, streamed in after the page shows. */
  agents: { teamId: string; wsIds: string[]; timezone: string | null } | null;
}

const EMPTY_VIEW: HomeView = {
  teamWorkspaces: [], workspaceCount: 0, refreshWorkspaceIds: [],
  serviceStatus: EMPTY_SERVICE_STATUS, hostedRunnerBanner: null, modelUpgradeTeamId: null,
  chatPlacement: { kind: 'none' }, chatTeamId: null, hasAgentCredential: null, firstTask: 'none',
  runnerConnected: undefined, actionQueue: [], discrepancyOverflowCount: 0, actionQueueInitiatives: [],
  questions: [], held: [], listed: [], openMissions: 0, milestones: [], quietMissions: 0, quietCauses: [],
  landedWeek: [], teamTz: null, agents: null,
};

/**
 * Home's body grid. split: Moving left (~1.5fr), Agents over Landed right (min
 * 300px). side: nothing is moving, so Agents and Landed share the row. single:
 * one column. Below 900px every layout reads Agents, Moving, Landed.
 */
async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<{ workspace?: string; initiative?: string; pr?: string; t?: string }>;
}) {
  const { workspace: wsFilter, initiative: initFilter, pr: prParam, t: prToken } = (await searchParams) ?? {};
  const user = await getCurrentUser();
  // `?pr=<n>&t=<token>`: a landing alert's action sheet (the old /app/prs/:n/act).
  // Signing in must not drop the single-use token, so it comes back here.
  const sheetPr = parsePrParam(prParam);

  const isDev = process.env.NODE_ENV === 'development' && (!process.env.DATABASE_URL || !process.env.DEV_USER_EMAIL); // placeholder unless dev has a DB + dev user
  if (sheetPr && !user && !isDev) redirect(prSheetSignInHref(sheetPr, prToken));

  let view = EMPTY_VIEW;
  if (!isDev) {
    if (!user) redirect('/app/auth/signin');
    try {
      view = await loadHomeView(user.id, { wsFilter: wsFilter ?? null, now: Date.now() });
    } catch (error) {
      console.error('Home page query error:', error);
    }
  }
  const renderNow = Date.now();

  // Chips SCOPE the Waiting-on-you queue (never group it). The section still
  // gates on the unfiltered queue so a filter that empties it doesn't hide the
  // chips (leaving the user unable to clear the filter).
  const filteredActionQueue = initFilter
    ? view.actionQueue.filter((i) => i.initiativeId === initFilter)
    : view.actionQueue;
  // What a live event re-reads (HomeLive): the queue and the moving missions.
  // Everything else on the page stays as this render drew it.
  async function loadRegion(): Promise<HomeRegion | null> {
    'use server';
    const viewer = await getCurrentUser();
    if (!viewer) return null;
    return homeRegionOf(await loadHomeView(viewer.id, { wsFilter: wsFilter ?? null, now: Date.now() }), initFilter);
  }
  // One ordered getting-started list (lib/getting-started.ts), from real data.
  // Shown until a runner, an agent key and a task that succeeded all exist; a lookup that
  // did not run or failed never shows it.
  const gettingStarted = view.workspaceCount > 0 && view.hasAgentCredential !== null
    ? gettingStartedChecklist({
        runnerConnected: view.runnerConnected ?? true,
        hasAgentCredential: view.hasAgentCredential,
        firstTask: view.firstTask,
      })
    : null;
  const showGettingStarted = gettingStarted?.visible === true;

  // The one list of what needs you, at every width: the headline counts it.
  const region = homeRegionOf(view, initFilter);
  const attention = region.items;
  const { chatPlacement, chatTeamId, teamWorkspaces } = view;
  // Chat is where work starts, and it has its own tab. On a phone a team with
  // chat keeps the composer under the headline; desktop gets one quiet link.
  // Chat setup (no key yet) lives on the Chat page: Home says so in one line.
  const ask = chatPlacement.kind === 'chat' && chatTeamId ? (
    <>
      <div className="md:hidden">
        <HomeChatCard teamId={chatTeamId} workspaces={teamWorkspaces} recent={[]} initialWorkspaceId={wsFilter ?? null} phoneInbox />
      </div>
      <p className="mb-6 hidden md:block">
        <Link href="/app/chat" data-testid="home-ask-link" className="text-body text-text-secondary hover:text-text-primary">Ask buildd →</Link>
      </p>
    </>
  ) : null;
  // Setup steps, each one line: a new team's next step.
  const createWorkspace = view.workspaceCount === 0;
  const chatSetup = chatTeamId && (chatPlacement.kind === 'onboarding' || chatPlacement.kind === 'connect-own') && !showGettingStarted;
  const setup = (createWorkspace || (showGettingStarted && gettingStarted) || chatSetup) ? (
    <>
      {createWorkspace && (
        <p data-testid="home-create-workspace" className="mb-6 border-y border-border-default py-3 text-body text-text-secondary">
          This team has no workspace. <Link href="/app/workspaces/new" className="font-medium text-text-primary underline">Connect a repo</Link> to run agents.
        </p>
      )}
      {/* While Get started shows, chat setup folds into its footer line. */}
      {showGettingStarted && gettingStarted && (
        <GettingStartedChecklist checklist={gettingStarted} chatSetupHref={chatPlacement.kind === 'onboarding' ? '/app/chat' : null} />
      )}
      {chatSetup && (
        <p data-testid="home-chat-setup" className="mb-6 border-y border-border-default py-3 text-body text-text-secondary">
          {chatPlacement.kind === 'onboarding' ? 'Chat needs a key.' : 'Chat needs your own key.'}{' '}
          <Link href="/app/chat" className="font-medium text-text-primary underline">Connect</Link>
        </p>
      )}
    </>
  ) : null;
  const { discrepancyOverflowCount } = view;

  return (
    <main className="min-h-screen pt-14 px-4 pb-20 md:pt-8 md:px-8 md:pb-8">
      {sheetPr && user && (
        <Suspense fallback={null}>
          <PrActionSheet prNumber={sheetPr} token={prToken} userId={user.id} />
        </Suspense>
      )}
      {view.hostedRunnerBanner && (
        <div className="mx-auto max-w-[1320px]">
          <HostedRunnerBanner level={view.hostedRunnerBanner.level} text={view.hostedRunnerBanner.text} />
        </div>
      )}
      {view.serviceStatus.banner && (
        <div className="mx-auto max-w-[1320px]">
          <ServiceStatusBanner status={view.serviceStatus.banner} href="/app/health" />
        </div>
      )}
      {view.modelUpgradeTeamId && (
        <div className="mx-auto max-w-[1320px]">
          <ModelUpgradeNotice teamId={view.modelUpgradeTeamId} />
        </div>
      )}
      <HomeLive
          region={region}
          load={loadRegion}
          workspaceIds={view.refreshWorkspaceIds}
          ask={ask}
          setup={setup}
          runnerConnected={view.runnerConnected}
          agents={view.agents ? (
            // The fleet lanes and the day's occupancy stream in after the page shows (R-12).
            <Suspense fallback={<section data-testid="home-agents" aria-busy="true" style={{ gridArea: 'agents' }} className="min-w-0 min-h-24" />}>
              <HomeAgents {...view.agents} now={renderNow} />
            </Suspense>
          ) : null}
          landed={view.landedWeek.length > 0 ? <LandedThisWeek missions={view.landedWeek} timeZone={view.teamTz} /> : null}
          lead={(attention.length > 0 || initFilter) && (
            // Initiative scoping chips: they SCOPE the list, never group it.
            <div className="mb-3">
              <InitiativeFilterChips initiatives={view.actionQueueInitiatives} selectedId={initFilter ?? null} workspaceFilter={wsFilter ?? null} />
              {initFilter && filteredActionQueue.length === 0 && <p className="text-body text-text-muted">Nothing waiting for this initiative.</p>}
            </div>
          )}
          foot={discrepancyOverflowCount > 0 && (
            // §12: overflow past the top-10-per-workspace cap is never silently dropped.
            <p className="mt-3 text-meta text-text-muted">
              +{discrepancyOverflowCount} more spec{discrepancyOverflowCount === 1 ? '' : 's'} with open discrepancies beyond the visible top 10
            </p>
          )}
        />
    </main>
  );
}

/** The data HomeBody renders from, derived from one load: also what a live event re-reads. */
function homeRegionOf(view: HomeView, initFilter: string | undefined): HomeRegion {
  const queue = initFilter ? view.actionQueue.filter((i) => i.initiativeId === initFilter) : view.actionQueue;
  const { items, inProgress } = deriveHomeNeedsYou({ queue, missions: view.listed, questions: view.questions, held: view.held, isActionable: isActionableChip, status: view.serviceStatus.needsYou });
  return {
    items,
    inProgress,
    counts: { openMissions: view.openMissions, executingMissions: 0, liveAgents: 0, slots: { used: 0, total: 0 } },
    milestones: view.milestones,
    quietMissions: view.quietMissions,
    quietCauses: view.quietCauses,
  };
}

/**
 * The Agents panel: the fleet's slots with their lanes, the day's busy-slot
 * water level and the stretches work waited with slots idle. Its own loader,
 * streamed behind Suspense; a failed read leaves the panel out.
 */
async function HomeAgents({ teamId, wsIds, timezone, now }: { teamId: string; wsIds: string[]; timezone: string | null; now: number }) {
  // Role colours for the lanes, and the titles of the missions the slots work on.
  const roleRows = await db.query.workspaceSkills.findMany({
    where: sqlWhere(and(
      // Team-level roles (workspaceId NULL, teamId set) are the default
      // shape; workspace-scoped ones override per workspace.
      or(inArray(workspaceSkills.workspaceId, wsIds), and(isNull(workspaceSkills.workspaceId), eq(workspaceSkills.teamId, teamId))),
      eq(workspaceSkills.enabled, true),
      eq(workspaceSkills.isRole, true),
    )),
    columns: { name: true, color: true, slug: true },
    orderBy: sqlOrderBy([desc(workspaceSkills.createdAt)]),
    limit: 20,
  }).catch(() => []);
  const roles = new Map<string, { name: string; color: string | null }>();
  for (const r of roleRows) if (!roles.has(r.slug) && roles.size < 8) roles.set(r.slug, { name: r.name, color: r.color ?? null });
  const [fleetData, occupancy, queueHistory] = await Promise.all([
    loadHomeFleet({ teamId, wsIds, now, dayStart: startOfDayInZone(now, timezone), roles }).catch(err => {
      console.error('[home] fleet load failed (non-fatal):', err);
      return null;
    }),
    // The Agents live sparkline: the last day's busy slots, same scope as the fleet.
    loadOccupancySeries(wsIds, '24h', now, 0, null, teamId).catch(err => {
      console.error('[home] occupancy load failed (non-fatal):', err);
      return null;
    }),
    loadQueueHistory({ wsIds, from: now - 24 * 3_600_000, now }).catch(err => {
      console.error('[home] queue history load failed (non-fatal):', err);
      return null;
    }),
  ]);
  if (!fleetData) return null;
  const lanes = fleetData.fleet.sessions ? [...fleetData.fleet.runners, fleetData.fleet.sessions] : fleetData.fleet.runners;
  const missionIds = [...new Set(lanes.flatMap(r => r.slots.flatMap(s => s.lane.bars.map(b => b.missionId ?? null))).filter((m): m is string => !!m))];
  const titleRows = missionIds.length > 0
    ? await db.select({ id: missionsTable.id, title: missionsTable.title }).from(missionsTable).where(inArray(missionsTable.id, missionIds)).catch(() => [])
    : [];
  const missionTitleById = new Map(titleRows.map(m => [m.id, m.title] as const));
  const idle = queueHistory ? idleWhileQueued({ ...queueHistory, from: now - 24 * 3_600_000, to: now }) : [];
  const model = buildAgentsModel(fleetData.fleet, now, missionTitleById, ({ missionId, taskId }) => missionTaskHref({ missionId, taskId, from: 'home' }));
  return <AgentsPanel model={model} occupancy={occupancy} idle={idle} />;
}

/** A stored summary's Home reading, or one derived live, with the mission facts the sections read. */
interface MissionReading {
  id: string;
  title: string;
  status: string;
  completedAt: Date | null;
  home: MissionHomeReading;
  /** When the reading was computed: a stranded mission's quiet time is as of then. */
  computedAt: number;
}

async function loadHomeView(userId: string, opts: { wsFilter: string | null; now: number }): Promise<HomeView> {
  const { wsFilter, now } = opts;
  const cookieStore = await cookies();
  // Same resolver as the app shell (layout.tsx), so the team the header
  // names is the team whose workspaces Home shows: valid cookie → personal
  // team → first team. No cookie is no longer a cross-team view. Shared with
  // the layout per request, as are the role and chat availability.
  const scope = await resolveActiveTeamScope(userId, cookieStore.get('buildd-team')?.value);
  const teamId = scope.teamId;
  const teamWsIds = scope.workspaces.map((w) => w.id);
  // Narrow to selected workspace if filter is set (must belong to team)
  const wsIds = (wsFilter && teamWsIds.includes(wsFilter)) ? [wsFilter] : teamWsIds;
  const view: HomeView = {
    ...EMPTY_VIEW,
    teamWorkspaces: scope.workspaces,
    // Every workspace of the active team — the empty-state input. Not the
    // filter list's length alone, and not narrowed by ?workspace=.
    workspaceCount: teamWsIds.length,
    // Workspace channels HomeAutoRefresh subscribes to, so an open tab never
    // holds a stale action queue (e.g. a Merge card for an already-merged PR).
    refreshWorkspaceIds: wsIds,
    teamTz: scope.timezone,
  };
  if (!teamId) return view;

  const [role, chatAvail] = await Promise.all([
    getUserTeamRole(userId, teamId).catch(() => null),
    getChatAvailability(userId, teamId).catch(() => null),
  ]);
  if (roleHasPermission(role, 'manage_model_tiers')) view.modelUpgradeTeamId = teamId;
  view.chatPlacement = homeChatPlacement(homeAudience(role), chatAvail);
  view.chatTeamId = teamId;
  const statusPlan = await serviceStatusReads(teamId, now);
  const hasWs = wsIds.length > 0;
  if (hasWs) view.agents = { teamId, wsIds, timezone: scope.timezone };

  // ── Round 1: everything that depends only on the team and its workspaces ──
  const missionScope = and(
    wsFilter && wsIds.includes(wsFilter)
      ? and(eq(missionsTable.teamId, teamId), or(eq(missionsTable.workspaceId, wsFilter), isNull(missionsTable.workspaceId)))
      : eq(missionsTable.teamId, teamId),
    // Archived missions never show; completed ones only inside the window Home reads them for.
    ne(missionsTable.status, 'archived'),
    homeMissionRecencyWhere(now),
  );
  const stored = and(eq(missionSummaries.missionId, missionsTable.id), eq(missionSummaries.version, MISSION_SUMMARY_VERSION));
  const home = sql`${missionSummaries.summary}->'home'`;
  const deliveryKind = sql`${missionSummaries.summary}->'home'->'delivery'->>'kind'`;
  const missionColumns = {
    id: missionsTable.id, title: missionsTable.title, status: missionsTable.status, completedAt: missionsTable.completedAt,
    home: sql<MissionHomeReading>`${home}`, computedAt: missionSummaries.computedAt,
  };
  const ACCESS = hasWs && roleHasPermission(role, 'manage_connectors') ? await ACCESS_NEEDS_YOU(teamId, wsIds) : null;
  const SCHEDULE_MOVES = hasWs && roleHasPermission(role, 'delegate_schedule_access') ? await SCHEDULE_MOVE_NEEDS_YOU(wsIds) : null;
  const r1 = await readRound({
    ss0: statusPlan.queries[0], ss1: statusPlan.queries[1], ss2: statusPlan.queries[2], ss3: statusPlan.queries[3],
    ss4: statusPlan.queries[4], ss5: statusPlan.queries[5], ss6: statusPlan.queries[6],
    // A failed lookup reads as "has a key" below: never nag a working team.
    agentKey: agentCredentialProbe(teamId),
    team: db.select({ hostedRunnerHours: teamsTable.hostedRunnerHours }).from(teamsTable).where(eq(teamsTable.id, teamId)).limit(1),
    // Connector credentials that can no longer re-authorise themselves (a team resource).
    credentials: db.select({ label: secrets.label, tokenExpiresAt: secrets.tokenExpiresAt, lastVerificationError: secrets.lastVerificationError })
      .from(secrets).where(teamCredentialWhere({ teamId: [teamId], purpose: 'mcp_connector_credential' })),
    // This user's active gate-card snoozes, re-checked against `now`.
    snoozes: db.select({ subjectKey: actionQueueSnoozes.subjectKey }).from(actionQueueSnoozes)
      .where(and(eq(actionQueueSnoozes.userId, userId), gt(actionQueueSnoozes.snoozedUntil, new Date(now)))),
    // Missions, from their stored summaries: open count and quiet causes...
    missionCounts: db.select({ cause: sql<string | null>`${missionSummaries.summary}->'home'->>'quietCause'`, n: sql<number>`count(*)::int` })
      .from(missionsTable).innerJoin(missionSummaries, stored)
      .where(and(missionScope, inArray(missionsTable.status, [...OPEN_MISSION_STATUSES])))
      .groupBy(sql`${missionSummaries.summary}->'home'->>'quietCause'`),
    // ...the three closest to a delivery milestone (selectHomeMilestones' order)...
    moving: db.select(missionColumns).from(missionsTable).innerJoin(missionSummaries, stored)
      .where(and(missionScope, inArray(missionsTable.status, [...OPEN_MISSION_STATUSES]), inArray(deliveryKind, [...MOVING_KINDS])))
      .orderBy(
        sql`case ${deliveryKind} when 'landing' then 0 when 'audit' then 1 when 'repair' then 2 else 3 end`,
        sql`case when (${home}->'delivery'->>'total')::int > 0 then (${home}->'delivery'->>'landed')::float8 / (${home}->'delivery'->>'total')::int else 0 end desc`,
        sql`${missionsTable.id}::text collate "C"`,
      )
      .limit(3),
    // ...the held, the stranded and the just landed...
    listedMissions: db.select(missionColumns).from(missionsTable).innerJoin(missionSummaries, stored)
      .where(and(missionScope, or(
        sql`${home}->'card'->>'kind' = 'held'`,
        sql`(${home}->'card'->>'listed')::boolean and jsonb_typeof(${home}->'card'->'strand') = 'object'`,
        and(eq(missionsTable.status, 'completed'), gte(missionsTable.completedAt, new Date(now - RECENT_DONE_MS))),
      )))
      .orderBy(desc(missionsTable.priority), desc(missionsTable.createdAt))
      .limit(HOME_LISTED_MISSION_CAP),
    // ...and the ones with no stored summary yet, derived live below.
    missingSummaries: db.select({ id: missionsTable.id }).from(missionsTable).leftJoin(missionSummaries, stored)
      .where(and(missionScope, isNull(missionSummaries.missionId)))
      .orderBy(desc(missionsTable.priority), desc(missionsTable.createdAt))
      .limit(HOME_LIVE_SUMMARY_CAP + 1),
    // Count total tasks: whether a first task has succeeded. Attempt tasks nest under parents.
    taskCounts: hasWs ? db.select({ status: tasks.status, count: sql<number>`count(*)::int` }).from(tasks)
      .where(and(inArray(tasks.workspaceId, wsIds), isNull(tasks.parentTaskId))).groupBy(tasks.status) : null,
    // The team's workspaces, for the PR cards' policy and names.
    inboxWorkspaces: hasWs ? db.query.workspaces.findMany({
      where: sqlWhere(inArray(workspacesTable.id, wsIds)),
      columns: { id: true, name: true, repo: true, gitConfig: true, teamId: true, maxConcurrentTasks: true, dataClass: true },
      with: WORKSPACE_INSTALLATION_WITH,
    }) : null,
    // One PR can sit on several worker rows (a CI-retry attempt adopts
    // its parent's PR). A merge seen by any of them means the PR merged,
    // and the rest collapse to the owner row: one PR, one card.
    // One PR can sit on several worker rows; they collapse to one card below.
    openPrWorkers: hasWs ? openPrWorkersQuery(wsIds) : null,
    // PR blockers: pending tasks whose upstream deps may hold open PRs.
    pendingWithDeps: hasWs ? db.select({ id: tasks.id, missionId: tasks.missionId, dependsOn: tasks.dependsOn }).from(tasks)
      .where(and(
        inArray(tasks.workspaceId, wsIds),
        eq(tasks.status, 'pending'),
        sql`${tasks.dependsOn} IS NOT NULL AND ${tasks.dependsOn}::jsonb != '[]'::jsonb`,
      ))
      .limit(300) : null,
    // Tasks that failed for a reason the owner fixes in settings. Recent only:
    // an old failure the owner already moved past is not a live ask.
    failedTasks: hasWs ? db.query.tasks.findMany({
      where: sqlWhere(and(
        inArray(tasks.workspaceId, wsIds),
        eq(tasks.status, 'failed'),
        isNull(tasks.parentTaskId),
        gte(tasks.updatedAt, new Date(now - 7 * 86_400_000)),
      )),
      columns: { id: true, title: true, status: true, backend: true, missionId: true, workspaceId: true },
      extras: sqlExtras({ context: sql<Record<string, unknown>>`jsonb_build_object('githubAccessBlock', ${tasks.context}->'githubAccessBlock')` }),
      with: {
        mission: { columns: { id: true, title: true } },
        workers: {
          columns: { error: true },
          orderBy: sqlOrderByFn((w, { desc: descOrder }) => [descOrder(w.createdAt)]),
          limit: 1,
        },
      },
      orderBy: sqlOrderBy(desc(tasks.updatedAt)),
      limit: 5,
    }) : null,
    // Workers parked on a question: Needs you's questions and answer cards.
    questionWorkers: hasWs ? homeQuestionWorkersQuery(wsIds) : null,
    // The runners those questions wait on, and whether any runner is connected.
    heartbeats: hasWs ? fleetHeartbeatsQuery({ teamId, wsIds, now }) : null,
    // Pending plan approvals: planning tasks completed with a plan and no child task yet.
    planningTasks: hasWs ? db.query.tasks.findMany({
      where: sqlWhere(and(
        inArray(tasks.workspaceId, wsIds),
        eq(tasks.mode, 'planning'),
        eq(tasks.status, 'completed'),
        isNotNull(tasks.result),
      )),
      columns: { id: true, title: true, missionId: true },
      extras: sqlExtras({
        planSteps: sql<number>`case when jsonb_typeof(${tasks.result}->'structuredOutput'->'plan') = 'array' then jsonb_array_length(${tasks.result}->'structuredOutput'->'plan') else 0 end`,
        approved: sql<boolean>`exists (select 1 from ${tasks} as child where child.parent_task_id = ${tasks.id})`,
      }),
      with: { mission: { columns: { id: true, title: true } } },
      orderBy: sqlOrderBy(desc(tasks.updatedAt)),
      limit: 10,
    }) : null,
    // Missions whose goal-criteria gate escalated to the owner.
    escalatedMissions: hasWs ? db.query.missions.findMany({
      where: sqlWhere(and(
        inArray(missionsTable.workspaceId, wsIds),
        isNotNull(missionsTable.criteriaEscalatedAt),
        inArray(missionsTable.status, ['active', 'paused']),
      )),
      columns: {
        id: true, title: true, status: true,
        criteriaEscalatedAt: true, criteriaRearmFingerprint: true, goalCriteriaState: true,
      },
    }) : null,
    // Open spec discrepancy ledger rows (§7/§12); buildDiscrepancyItems re-derives membership.
    discrepancies: hasWs ? db.query.specDiscrepancies.findMany({
      where: sqlWhere(inArray(specDiscrepancies.workspaceId, wsIds)),
      columns: {
        id: true, workspaceId: true, specPath: true, assertionId: true,
        direction: true, status: true, firstSeenAt: true, promotedMissionId: true,
        docFixTaskId: true, lastCheckedAt: true,
        recheckRequestedAt: true, autoFollowUpTaskId: true,
      },
      extras: sqlExtras({ declaredStatus: sql<string | null>`${specDiscrepancies.evidence}->>'declaredStatus'` }),
    }) : null,
    access: ACCESS?.query ?? null,
    scheduleMoves: SCHEDULE_MOVES?.query ?? null,
  });

  // Bookkeeping after the response: the PR fact import catches missed merge
  // webhooks (spec workflow-state-kernel §11: this render shows what is
  // stored, the next one what the import found), and lapsed grants expire.
  if (hasWs) {
    after(() => refreshStaleWorkersForWorkspaces(wsIds).catch(err =>
      console.error('[home] pr-state-refresh failed (non-fatal):', err),
    ));
  }
  if (ACCESS) after(() => ACCESS.expire().catch(err => console.warn('[home] grant expiry failed (non-fatal):', err)));

  view.hasAgentCredential = r1.agentKey ? r1.agentKey.length > 0 : true;
  const countsByStatus = Object.fromEntries((r1.taskCounts ?? []).map((r) => [r.status, r.count || 0]));
  view.firstTask = firstTaskState(countsByStatus);

  const wsById = new Map((r1.inboxWorkspaces ?? []).map(ws => [ws.id, ws]));
  const openPrWorkers = oneRowPerPr(r1.openPrWorkers ?? []);
  const openTaskIds = openPrWorkers.map(w => w.taskId).filter((id): id is string => !!id);
  const openPrNumbers = [...new Set(openPrWorkers.map(w => w.prNumber).filter((n): n is number => n != null))];
  const pendingWithDeps = r1.pendingWithDeps ?? [];
  const upstreamIds = [...new Set(pendingWithDeps.flatMap(t => (t.dependsOn as string[] | null) ?? []))];
  const failedTaskRows = r1.failedTasks ?? [];
  const asking = admittedQuestionRows(r1.questionWorkers ?? [], now);
  const staleCredentials = (r1.credentials ?? []).filter(c => c.label && needsReconnect(c));
  const escalatedMissions = r1.escalatedMissions ?? [];
  const discrepancyRows = r1.discrepancies ?? [];
  const docFixTaskIds = [...new Set(discrepancyRows.map((r) => r.docFixTaskId).filter(Boolean) as string[])];
  const missionPrMissionIds = [...new Set(openPrWorkers.flatMap(w => (w.task && isMissionPrTask(w.task) && w.task.missionId ? [w.task.missionId] : [])))];
  const allowanceHours = allowanceHoursOf(r1.team?.[0]?.hostedRunnerHours);
  const missingIds = (r1.missingSummaries ?? []).map(m => m.id);
  // Every mission a queue card can name, for the initiative chips.
  const queueMissionIds = [...new Set([
    ...openPrWorkers.map(w => w.task?.missionId),
    ...pendingWithDeps.map(t => t.missionId),
    ...failedTaskRows.map(t => t.missionId),
    ...asking.map(r => r.missionId),
    ...(r1.planningTasks ?? []).map(t => t.missionId),
    ...escalatedMissions.map(m => m.id),
    ...discrepancyRows.map(r => r.promotedMissionId),
  ].filter((id): id is string => !!id))];

  // GitHub approval facts, from the cache only; a miss is refreshed after the response.
  const approvalPeeks = Promise.all(openPrWorkers.map(async w => {
    const repo = repoFullNameFromPrUrl(w.prUrl);
    if (!repo || !w.prNumber) return [w.id, null, null] as const;
    return [w.id, await peekGithubApproval(repo, w.prNumber, w.lastCommitSha ?? null), repo] as const;
  }));

  // ── Round 2: what round 1's rows point at ──
  const [r2, deliveryViewsAll, superseded, statusFacts, live, peeks] = await Promise.all([
    readRound({
      // The reviewer gate needs the CURRENT state of each original task's most
      // recent reviewer task. parentTaskId is a real column (createReviewerTask).
      reviewerTasks: openTaskIds.length > 0 ? db.query.tasks.findMany({
        where: sqlWhere(and(inArray(tasks.parentTaskId, openTaskIds), eq(tasks.category, 'review'))),
        columns: { id: true, parentTaskId: true, status: true, roleSlug: true, createdAt: true, context: true, result: true, startAt: true },
        with: {
          mission: { columns: { status: true } },
          workers: {
            where: sqlWhere(inArray(workers.status, [...LIVE_WORKER_STATUSES])),
            columns: { id: true, status: true, startedAt: true },
            limit: 1,
          },
        },
        orderBy: sqlOrderBy([desc(tasks.createdAt)]),
      }) : null,
      reviewerNotes: openTaskIds.length > 0 ? db.query.missionNotes.findMany({
        where: sqlWhere(and(
          inArray(missionNotes.taskId, openTaskIds),
          inArray(missionNotes.type, ['reviewer_escalated', 'reviewer_approved']),
        )),
        columns: { taskId: true, type: true, body: true, title: true, status: true, createdAt: true },
      }) : null,
      // Conflict retries on these PRs, newest first: the live one renders as
      // RESOLVING, the newest names the conflict, and the finished ones count
      // toward the dead zone (conflict fixes spent).
      conflictTasks: openPrNumbers.length > 0 ? db.query.tasks.findMany({
        where: sqlWhere(and(inArray(tasks.workspaceId, wsIds), inArray(tasks.conflictRetryPrNumber, openPrNumbers))),
        columns: { id: true, workspaceId: true, conflictRetryPrNumber: true, creationSource: true, status: true, createdAt: true, claimedAt: true },
        extras: sqlExtras({
          context: sql<Record<string, unknown>>`jsonb_build_object('failureContext', ${tasks.context}->'failureContext', 'conflictIteration', ${tasks.context}->'conflictIteration', 'conflictRecovery', ${tasks.context}->'conflictRecovery')`,
        }),
        orderBy: sqlOrderBy([desc(tasks.createdAt)]),
      }) : null,
      // CI / reviewer-retry fix attempts, matched on context.prNumber.
      attemptTasks: openPrNumbers.length > 0 ? db.query.tasks.findMany({
        where: sqlWhere(and(
          inArray(tasks.workspaceId, wsIds),
          eq(tasks.taskClass, 'attempt'),
          sql`(${tasks.context}->>'prNumber') IN (${sql.join(openPrNumbers.map(n => sql`${String(n)}`), sql`, `)})`,
        )),
        columns: { id: true, workspaceId: true, status: true, title: true, reviewerRetryPrNumber: true },
        extras: sqlExtras({
          context: sql<Record<string, unknown>>`jsonb_build_object('prNumber', ${tasks.context}->'prNumber', 'iteration', ${tasks.context}->'iteration')`,
          result: sql<{ nextSuggestion?: string } | null>`jsonb_build_object('nextSuggestion', ${tasks.result}->'nextSuggestion')`,
        }),
        with: {
          workers: {
            where: sqlWhere(inArray(workers.status, [...LIVE_WORKER_STATUSES])),
            columns: { id: true },
            limit: 1,
          },
        },
        orderBy: sqlOrderBy([desc(tasks.createdAt)]),
      }) : null,
      upstreamTasks: upstreamIds.length > 0 ? db.query.tasks.findMany({
        where: sqlWhere(and(inArray(tasks.id, upstreamIds), eq(tasks.status, 'completed'))),
        columns: { id: true, title: true, missionId: true },
        with: {
          workers: {
            where: sqlWhere(and(
              isNotNull(workers.prUrl),
              isNull(workers.mergedAt),
              // A sibling row (e.g. a CI-retry attempt) may be the one
              // that recorded the merge.
              noRowOfPrMerged(),
            )),
            columns: {
              prUrl: true, prNumber: true, prLifecycleStatus: true,
              // Freshness inputs — a blocker-derived merge card is still
              // a claim that this PR is open right now.
              completedAt: true, createdAt: true, prLastVerifiedAt: true,
              // Pending-gate inputs: a merge card is also a claim that
              // CI and the review have finished (resolveMergeChip).
              updatedAt: true,
            },
            orderBy: sqlOrderBy(desc(workers.createdAt)),
            limit: 1,
          },
          mission: { columns: { id: true, title: true } },
        },
      }) : null,
      // Mission titles for the downstream blocked tasks.
      downstreamMissions: pendingWithDeps.some(t => t.missionId)
        ? db.select({ id: missionsTable.id, title: missionsTable.title }).from(missionsTable)
          .where(inArray(missionsTable.id, [...new Set(pendingWithDeps.map(t => t.missionId).filter(Boolean) as string[])]))
        : null,
      connectorNames: staleCredentials.length > 0
        ? db.select({ id: connectors.id, name: connectors.name }).from(connectors).where(inArray(connectors.id, staleCredentials.map(c => c.label as string)))
        : null,
      escalationNotes: escalatedMissions.length > 0 ? db.query.missionNotes.findMany({
        where: sqlWhere(and(
          inArray(missionNotes.missionId, escalatedMissions.map(m => m.id)),
          eq(missionNotes.type, 'question'),
          eq(missionNotes.status, 'open'),
        )),
        orderBy: sqlOrderBy(desc(missionNotes.createdAt)),
        columns: { id: true, missionId: true, title: true, body: true, type: true, authorType: true, disposition: true },
      }) : null,
      // The doc-fix claim is a stored id, read against the task's CURRENT
      // status, and its PR state (the most recently started worker wins).
      docFixTasks: docFixTaskIds.length > 0
        ? db.select({ id: tasks.id, status: tasks.status }).from(tasks).where(inArray(tasks.id, docFixTaskIds))
        : null,
      docFixWorkers: docFixTaskIds.length > 0 ? db.query.workers.findMany({
        where: sqlWhere(inArray(workers.taskId, docFixTaskIds)),
        columns: { taskId: true, prUrl: true, prNumber: true, prLifecycleStatus: true, mergedAt: true },
        orderBy: sqlOrderByFn((w, { desc: descOrder }) => [descOrder(w.startedAt)]),
      }) : null,
      // The initiative of every mission a card can name: the scoping chips.
      initiativeOfMission: queueMissionIds.length > 0
        ? db.select({ missionId: missionsTable.id, id: initiatives.id, title: initiatives.title }).from(missionsTable)
          .innerJoin(initiatives, eq(initiatives.id, missionsTable.initiativeId))
          .where(inArray(missionsTable.id, queueMissionIds))
          .orderBy(desc(initiatives.priority), desc(initiatives.createdAt))
        : null,
      // A mission PR's merge gate reads its mission's stored work holder and visual review.
      missionPrSummaries: missionPrMissionIds.length > 0
        ? db.select({
            missionId: missionSummaries.missionId,
            visualReview: sql<MissionVisualReviewState | null>`${missionSummaries.summary}->'visualReview'`,
            workHolder: sql<string | null>`${missionSummaries.summary}->>'missionPrWorkHolder'`,
          }).from(missionSummaries)
          .where(and(inArray(missionSummaries.missionId, missionPrMissionIds), eq(missionSummaries.version, MISSION_SUMMARY_VERSION)))
        : null,
    }),
    // One delivery-view read for every task a card or chip can read it for:
    // kernel-owned deliveries decide inbox membership (S36), lifecycle (§7)
    // and a failed attempt the kernel already replaced (S35).
    getDeliveryViewsForTasks([...openTaskIds, ...failedTaskRows.map(t => t.id), ...upstreamIds, ...docFixTaskIds]),
    // A question recovery superseded is the incident's, not the owner's (failure-incident-recovery §17.2).
    asking.length > 0 ? loadSupersededQuestionTaskIds(asking.map(r => r.taskId ?? '')) : Promise.resolve(new Set<string>()),
    statusPlan.facts([r1.ss0!, r1.ss1!, r1.ss2!, r1.ss3!, r1.ss4!, r1.ss5!, r1.ss6!]).catch(err => {
      console.error('[service-status] load failed (non-fatal):', err);
      return null;
    }),
    // Missions whose stored summary is missing: derived live (no visual review,
    // so no GitHub), and written after the response so the next load reads them.
    missingIds.length > 0
      ? HOME_MISSION_SUMMARIES.derive(missingIds.slice(0, HOME_LIVE_SUMMARY_CAP), now).catch(err => {
          console.error('[home] live mission readings failed (non-fatal):', err);
          return [] as LiveHomeReading[];
        })
      : Promise.resolve([] as LiveHomeReading[]),
    approvalPeeks,
    allowanceHours !== null
      ? hostedRunnerBannerFor(teamId, allowanceHours, new Date(now)).then(b => { view.hostedRunnerBanner = b; }, () => {})
      : null,
  ]);
  if (missingIds.length > 0) HOME_MISSION_SUMMARIES.refresh(...missingIds);
  view.serviceStatus = statusFacts ? serviceStatusView(statusFacts, userId) : EMPTY_SERVICE_STATUS;

  // ── Missions ──
  applyMissions(view, {
    counts: r1.missionCounts ?? [],
    moving: (r1.moving ?? []).map(toReading),
    listed: (r1.listedMissions ?? []).map(toReading),
    live,
    now,
  });
  // Stranded local missions: the decision shadow can only order their buttons;
  // a cached pick applies now, a miss is asked after the response.
  await orderStrandButtons(view.listed, teamId, userId, now);

  // ── Questions ──
  const { questions, runnerConnected } = homeQuestionsFrom({ heartbeats: await withLiveRunnerBeats((r1.heartbeats ?? []) as FleetHeartbeatRow[]), rows: asking, superseded, now });
  view.runnerConnected = hasWs ? runnerConnected : undefined;
  view.questions = questions.map(q => ({
    workerId: q.workerId, taskId: q.taskId, label: q.label, runnerName: q.runnerName,
    askedAt: q.askedAt, question: q.question,
    // A question opens where it is answered in full: the task page.
    href: q.taskId ? taskAnswerHref({ taskId: q.taskId, missionId: q.missionId }) : null,
  }));

  // ── Escalation inbox: the open PRs that fell to a person ──
  const github = new Map(peeks.map(([workerId, facts]) => [workerId, facts] as const));
  const missedApprovals = peeks.filter(([, facts, repo]) => !facts && repo);
  if (missedApprovals.length > 0) {
    const installations = createTeamInstallationResolver();
    const byId = new Map(openPrWorkers.map(w => [w.id, w]));
    const refresh: ApprovalRefresh[] = missedApprovals.flatMap(([workerId, , repo]) => {
      const w = byId.get(workerId)!;
      const ws = wsById.get(w.workspaceId);
      return [{
        repoFullName: repo!, prNumber: w.prNumber!, workerSha: w.lastCommitSha ?? null,
        // Read through the PR's own team's installation only.
        installationId: async () => {
          const identity = pickWorkspaceRepoIdentity(ws);
          return (await installations.resolve(repo!, { teamId: ws?.teamId, fullName: identity.fullName, installationId: identity.installationId })).installationId;
        },
      }];
    });
    after(() => refreshGithubApprovals(refresh).then(() => undefined));
  }
  const inbox = await buildEscalationInbox({
    openPrWorkers, wsById, github, r2, deliveryViews: deliveryViewsAll, now, wsIds,
    missionPrSummaries: new Map((r2.missionPrSummaries ?? []).map(s => [s.missionId, s])),
    liveMissionPrState: new Map(live.map(m => [m.id, m])),
  });

  // ── "Waiting on You": every other source ──
  const waitingOnYou: WaitingOnYouRawItem[] = [];
  // 1. PR blockers: pending tasks whose upstream deps are completed but have open PRs.
  {
    const downstreamMissionMap = new Map((r2.downstreamMissions ?? []).map(m => [m.id, m.title]));
    for (const upstream of r2.upstreamTasks ?? []) {
      const w = (upstream.workers as Array<Record<string, any>>)[0];
      if (!w?.prNumber) continue;
      // A kernel-owned PR is a merge for you only when its delivery says so
      // (approved, and the policy leaves the merge to a person); merged, in
      // review or being fixed, it is not, whatever the worker row says.
      const uv = deliveryViewsAll.get(upstream.id);
      const kernelOwned = !!uv && uv.ownerTaskId === upstream.id && uv.prNumber === w.prNumber;
      if (kernelOwned && !(uv!.state === 'APPROVED' && uv!.needsYou)) continue;
      const blockedTasks = pendingWithDeps.filter(t => ((t.dependsOn as string[]) ?? []).includes(upstream.id));
      if (blockedTasks.length === 0) continue;
      const blockedMissionIds = [...new Set(blockedTasks.map(t => t.missionId).filter(Boolean) as string[])];
      const missionTitle = blockedMissionIds.length === 1
        ? (downstreamMissionMap.get(blockedMissionIds[0]) ?? upstream.mission?.title ?? null)
        : null;
      // The reviewer gate decides who this PR is waiting on. Pending or
      // running reviewer work, or a platform-owned merge, is not a person's
      // MERGE card (`!== 'human'`: an Option A′ task PR merges unattended).
      const gate = inbox.reviewerGateMap.get(upstream.id);
      if (gate && gate.actor !== 'human') continue;
      waitingOnYou.push({
        kind: 'merge',
        prUrl: w.prUrl,
        prNumber: w.prNumber,
        prLifecycleStatus: (w.prLifecycleStatus as 'open' | 'merged' | 'closed' | 'unresolvable' | null) ?? null,
        prOpenedAt: w.completedAt ?? w.createdAt ?? null,
        prLifecycleVerifiedAt: w.prLastVerifiedAt ?? null,
        prLifecycleUpdatedAt: w.updatedAt ?? null,
        reviewInFlight: inbox.reviewInFlightByTaskId.get(upstream.id) ?? null,
        upstreamTaskId: upstream.id,
        upstreamTaskTitle: upstream.title,
        unblockCount: blockedTasks.length,
        missionId: blockedMissionIds[0] ?? null,
        missionTitle,
      });
    }
    // Most impactful first.
    waitingOnYou.sort((a, b) => (b.unblockCount ?? 0) - (a.unblockCount ?? 0));
  }

  // 1b. Tasks that failed for a reason the owner fixes in settings. Tasks
  // waiting on GitHub access go only to whoever can fix the connection.
  const canFixGithubAccess = roleHasPermission(role, 'manage_workspace_settings');
  const githubAccessFixableWorkspaceIds = new Set(canFixGithubAccess
    ? failedTaskRows.filter((t) => readGithubAccessBlock(t.context) && t.workspaceId).map((t) => t.workspaceId as string)
    : []);
  waitingOnYou.push(...buildFailedTaskItems(failedTaskRows.map((t) => ({
    taskId: t.id,
    title: t.title,
    status: t.status,
    backend: (t.backend as 'claude' | 'codex' | null) ?? null,
    workerError: (t.workers as Array<{ error: string | null }> | undefined)?.[0]?.error ?? null,
    missionId: t.missionId,
    missionTitle: (t.mission as { title?: string } | null)?.title ?? null,
    workspaceId: t.workspaceId,
    context: t.context,
  })), { githubAccessFixableWorkspaceIds, linkedTaskIds: view.serviceStatus.linkedTaskIds }));

  // 2. Unanswered worker questions (waiting_input with an ask or hold disposition).
  for (const w of asking.filter(r => ['ask', 'hold'].includes(String((r.waitingFor as { disposition?: unknown } | null)?.disposition))).slice(0, 5)) {
    const wf = w.waitingFor as { type: string; prompt: string } | null;
    if (!wf?.prompt) continue;
    if (w.taskId && superseded.has(w.taskId)) continue;
    waitingOnYou.push({
      kind: 'answer',
      workerId: w.id,
      taskId: w.taskId ?? '',
      taskTitle: w.taskTitle ?? '',
      question: wf.prompt,
      missionId: w.missionId ?? null,
      missionTitle: null,
    });
  }

  // 3. Pending plan approvals.
  for (const t of r1.planningTasks ?? []) {
    if (t.approved || !(t.planSteps > 0)) continue;
    waitingOnYou.push({ kind: 'approve', taskId: t.id, taskTitle: t.title, missionId: t.missionId, missionTitle: (t.mission as { title?: string } | null)?.title ?? null });
  }

  // 4. Connector credentials that can no longer re-authorise themselves.
  // Deliberately NOT "expiring soon": the refresh sweep renews those.
  {
    const nameById = new Map((r2.connectorNames ?? []).map(c => [c.id, c.name]));
    for (const cred of staleCredentials) {
      const connectorName = nameById.get(cred.label as string);
      if (!connectorName) continue; // orphaned credential — connector deleted
      waitingOnYou.push({ kind: 'reconnect', connectorId: cred.label as string, connectorName });
    }
  }

  // 5. Missions whose goal-criteria gate escalated to the owner.
  if (escalatedMissions.length > 0) {
    const noteByMission = new Map<string, NonNullable<typeof r2.escalationNotes>[number]>();
    for (const n of r2.escalationNotes ?? []) {
      // An agent's question note reaches a person only with disposition `ask`.
      if (!admitsNoteToNeedsYou(n)) continue;
      if (n.missionId && !noteByMission.has(n.missionId)) noteByMission.set(n.missionId, n);
    }
    waitingOnYou.push(...buildDecideItems(escalatedMissions.map(m => {
      const note = noteByMission.get(m.id);
      const state = m.goalCriteriaState as import('@buildd/shared').GoalCriteriaState | null;
      return {
        missionId: m.id,
        missionTitle: m.title,
        criteriaEscalatedAt: m.criteriaEscalatedAt,
        criteriaRearmFingerprint: m.criteriaRearmFingerprint,
        openNote: note ? { id: note.id, title: note.title, body: note.body } : null,
        status: m.status,
        criteriaOverallVerdict: (state as { overall?: string } | null)?.overall ?? null,
        recommendation: describeCriteriaBlocker(state),
      };
    })));
  }

  // 6. Open spec discrepancy ledger rows (docs/design/spec-conformance.md §7/§12).
  if (discrepancyRows.length > 0) {
    const docFixStatusById = new Map((r2.docFixTasks ?? []).map((t) => [t.id, t.status]));
    const docFixWorkerByTask = new Map<string, { prLifecycleStatus: string | null; mergedAt: Date | null }>();
    for (const w of r2.docFixWorkers ?? []) {
      if (w.taskId && !docFixWorkerByTask.has(w.taskId)) {
        // A kernel-owned delivery's merged/open/closed reading replaces its worker's columns.
        const docFixViews = deliveryViewsAll;
        const life = prLifecycleFor(w, docFixViews.get(w.taskId), w.taskId);
        docFixWorkerByTask.set(w.taskId, { prLifecycleStatus: life.prLifecycleStatus, mergedAt: (life.mergedAt as Date | null) ?? null });
      }
    }
    const { items: discrepancyItems, overflowCount } = buildDiscrepancyItems(
      discrepancyRows.map((r) => {
        const docFixWorker = r.docFixTaskId ? docFixWorkerByTask.get(r.docFixTaskId) : undefined;
        return {
          id: r.id,
          workspaceId: r.workspaceId,
          workspaceName: wsById.get(r.workspaceId)?.name ?? null,
          specPath: r.specPath,
          assertionId: r.assertionId,
          direction: r.direction,
          status: r.status,
          firstSeenAt: r.firstSeenAt,
          lastCheckedAt: r.lastCheckedAt,
          promotedMissionId: r.promotedMissionId,
          docFixTaskId: r.docFixTaskId,
          docFixTaskStatus: r.docFixTaskId ? docFixStatusById.get(r.docFixTaskId) ?? null : null,
          docFixPrLifecycleStatus: docFixWorker?.prLifecycleStatus ?? null,
          docFixMergedAt: docFixWorker?.mergedAt ?? null,
          recheckRequestedAt: r.recheckRequestedAt,
          autoFollowUpTaskId: r.autoFollowUpTaskId,
          declaredStatus: typeof r.declaredStatus === 'string' ? r.declaredStatus : null,
        };
      }),
    );
    waitingOnYou.push(...discrepancyItems);
    view.discrepancyOverflowCount = overflowCount;
  }

  // 7. Agent access requests team policy leaves to a person.
  if (ACCESS && r1.access) waitingOnYou.push(...ACCESS.items(r1.access));
  // 8. Schedule move proposals, for whoever holds delegate_schedule_access.
  if (SCHEDULE_MOVES && r1.scheduleMoves) waitingOnYou.push(...SCHEDULE_MOVES.items(r1.scheduleMoves));

  // ── Round 3: the escalation gate's stored verdicts and the merge advice ledger ──
  const snoozedSubjectKeys = new Set((r1.snoozes ?? []).map((s) => s.subjectKey));
  const queueViewIds = new Set([...inbox.items.map(e => e.taskId), ...waitingOnYou.flatMap(w => (w.kind === 'failed' && w.taskId ? [w.taskId] : []))]);
  const deliveryViews = new Map([...deliveryViewsAll].filter(([id]) => queueViewIds.has(id)));
  const gated = await gateInbox(inbox, wsById, deliveryViewsAll, now);
  // Merge waitingOnYou + escalationInbox into one deduplicated action queue.
  // Kernel-owned deliveries project the kernel's owner of the next move
  // (workflow-state-kernel §17.5); every other task keeps today's chip.
  let actionQueue = buildActionQueue(waitingOnYou, gated, { snoozedSubjectKeys, deliveryViews });
  // After the fold: a ship card's refresh-first dependency is one of the facts.
  actionQueue = await attachMergeAdvice(actionQueue, inbox.mergeAdviceBaseByWorkerId);

  // Age telemetry: in steady state olderThan7d is 0; a non-zero value means
  // the sweep is not converging.
  {
    const age = summariseActionQueueAge(actionQueue);
    if (age.olderThan7dCount > 0 || age.p99AgeHours > 0) {
      console.log(
        `[home] action_queue.card_age_hours p99=${age.p99AgeHours} older_than_7d=${age.olderThan7dCount} `
        + `stale_unverified=${age.staleUnverified} stale_ancient=${age.staleAncient} measured=${age.measured}`,
      );
    }
  }
  // Discrepancy overflow telemetry (§12): a clean-looking top-10 must never hide a growing backlog.
  if (view.discrepancyOverflowCount > 0) {
    console.log(`[home] discrepancy_queue.overflow_count=${view.discrepancyOverflowCount}`);
  }

  // Tag each item with its mission's initiative and collect the distinct
  // initiatives present for the scoping chips (initiative priority order).
  const initiativeOf = new Map((r2.initiativeOfMission ?? []).map(r => [r.missionId, { id: r.id, title: r.title }] as const));
  actionQueue = actionQueue.map((item) => {
    const ini = item.missionId ? initiativeOf.get(item.missionId) : undefined;
    return ini ? { ...item, initiativeId: ini.id, initiativeTitle: ini.title } : item;
  });
  const present = new Set(actionQueue.map((i) => i.initiativeId).filter(Boolean) as string[]);
  view.actionQueueInitiatives = [...new Map((r2.initiativeOfMission ?? []).filter(r => present.has(r.id)).map(r => [r.id, { id: r.id, title: r.title }])).values()];
  view.actionQueue = actionQueue;
  return view;
}

function toReading(r: { id: string; title: string; status: string; completedAt: Date | null; home: MissionHomeReading; computedAt: Date }): MissionReading {
  return { id: r.id, title: r.title, status: r.status, completedAt: r.completedAt, home: r.home, computedAt: new Date(r.computedAt).getTime() };
}

/** The mission sections from the stored readings (plus any derived live), as Home built them. */
function applyMissions(view: HomeView, input: {
  counts: Array<{ cause: string | null; n: number }>;
  moving: MissionReading[];
  listed: MissionReading[];
  live: MissionReading[];
  now: number;
}): void {
  const { now } = input;
  const open = (m: MissionReading) => (OPEN_MISSION_STATUSES as readonly string[]).includes(m.status);
  const liveOpen = input.live.filter(open);
  view.openMissions = input.counts.reduce((n, r) => n + r.n, 0) + liveOpen.length;
  const causes = [
    ...input.counts.flatMap(r => (r.cause ? Array.from({ length: r.n }, () => r.cause) : [])),
    ...liveOpen.map(m => quietCauseOf(m.home.delivery)),
  ];
  view.quietCauses = groupQuietCauses(causes);
  view.quietMissions = view.quietCauses.reduce((n, c) => n + c.count, 0);
  view.milestones = selectHomeMilestones([
    ...input.moving.map(m => ({ ...deliveryAtRead(m.home.delivery, now), open: open(m) })),
    ...liveOpen.map(m => deliveryAtRead(m.home.delivery, now)),
  ]);

  const recentDone = (m: MissionReading) => m.status === 'completed' && isRecentlyDelivered({ completedAt: m.completedAt }, now, RECENT_DONE_MS);
  const listedLive = input.live.filter(m => m.home.card.kind === 'held' || (m.home.card.listed && m.home.card.strand) || recentDone(m));
  const listed = [...input.listed, ...listedLive];
  view.listed = listed.flatMap(m => (m.home.card.strand && (m.home.card.listed || recentDone(m)) ? [{
    view: { id: m.id, title: m.title, href: missionCardHref(m.id, 'home') },
    // Quiet time as of when the reading was computed, aged to now.
    model: { strand: { ...m.home.card.strand, quietMs: m.home.card.strand.quietMs + Math.max(0, now - m.computedAt) } },
  }] : []));
  view.held = listed.filter(m => m.home.card.kind === 'held' && m.home.card.held).map(m => ({
    id: m.id, title: m.title, href: missionCardHref(m.id, 'home'),
    ready: m.home.card.held!.ready, roles: m.home.card.held!.roles,
    done: m.home.card.done, total: m.home.card.total,
    heldFor: m.home.card.held!.since ? shortAgo(m.home.card.held!.since, now) : null,
    startState: (m.home.card.held!.startState as HomeHeldMission['startState']) ?? 'not_started',
  }));
  view.landedWeek = listed
    .filter(m => m.home.card.kind === 'done' && recentDone(m))
    .slice(0, 6)
    .map(m => ({ id: m.id, title: m.title, href: missionCardHref(m.id, 'home'), completedAt: new Date(m.completedAt!).toISOString(), prs: m.home.card.donePrs ?? 0 }));
}

/**
 * The strand cards' button order (lib/strand-choice-shadow.ts): their tasks,
 * read only when a mission is stranded, feed the decision's facts.
 */
async function orderStrandButtons(listed: HomeListedMission[], teamId: string, userId: string, now: number): Promise<void> {
  const stranded = listed.filter(r => r.model.strand);
  if (stranded.length === 0) return;
  const rows = await db.query.missions.findMany({
    where: sqlWhere(inArray(missionsTable.id, stranded.map(r => r.view.id))),
    columns: { id: true, title: true, status: true, workspaceId: true, executor: true, isHeld: true, teamId: true },
    with: { tasks: { columns: MISSION_CARD_TASK_COLUMNS, extras: MISSION_CARD_TASK_EXTRAS, with: { workers: MISSION_CARD_WORKERS_WITH } } },
  }).catch(() => []);
  const byId = new Map(rows.map(r => [r.id, r]));
  await applyStrandChoice(
    stranded.flatMap(r => {
      const row = byId.get(r.view.id);
      return row && r.model.strand ? [{ row: { ...row, teamId: row.teamId ?? teamId } as unknown as MissionCardRow & { teamId?: string | null }, strand: r.model.strand }] : [];
    }),
    { now, userId },
  );
}

/**
 * The open PRs of these workspaces, one row per worker row carrying one: the
 * escalation inbox's read. A merge seen by any row of a PR means it merged.
 */
function openPrWorkersQuery(wsIds: string[]) {
  return db.query.workers.findMany({
    where: sqlWhere(and(
      inArray(workers.workspaceId, wsIds),
      isNotNull(workers.prUrl),
      isNull(workers.mergedAt),
      noRowOfPrMerged(),
      // Renovate/Dependabot PRs are the bot's to land — not buildd work
      // in flight, and not a merge buildd is waiting on anyone for.
      workerNotDependencyBotPr(),
      sql`COALESCE(${workers.prLifecycleStatus}, 'pr_open') NOT IN ('closed', 'merged', 'unresolvable')`,
    )),
    columns: {
      id: true, taskId: true, workspaceId: true, prUrl: true, prNumber: true,
      prLifecycleStatus: true, completedAt: true,
      // Freshness inputs for the action-queue invariant: how old the PR
      // is (which tier it falls in) and when its state was last verified.
      createdAt: true, prLastVerifiedAt: true,
      // When the lifecycle was last written: a just-green auto-merge PR
      // is still merging (see resolveReviewerGate).
      updatedAt: true,
      // Where this PR points: a task PR into a mission integration branch
      // (no human gate — the gate is on the mission PR) or into trunk.
      prBaseRef: true,
      // The PR's current head, against the terminal verdict's headSha.
      lastCommitSha: true,
      prIsDraft: true,
      // Diff size for the merge-advice rule (an XL PR never "looks mergeable as-is").
      linesAdded: true, linesRemoved: true,
    },
    with: {
      task: {
        columns: { id: true, title: true, taskClass: true, missionId: true, status: true, requiresReview: true, pathManifest: true },
        // Never the whole context or result: the refresh marker (missionPrRoleOf),
        // landing's own record, and the fixing agent's handoff.
        extras: sqlExtras({
          context: sql<Record<string, unknown>>`jsonb_build_object('refreshTrunk', ${tasks.context}->'refreshTrunk')`,
          landing: sql<unknown>`${tasks.context}->'landing'`,
          landingHandoff: sql<unknown>`${tasks.context}->'landingHandoff'`,
          result: sql<{ nextSuggestion?: string } | null>`jsonb_build_object('nextSuggestion', ${tasks.result}->'nextSuggestion')`,
        }),
        with: { mission: { columns: { id: true, title: true, mergePolicy: true, requiresReview: true, workingBranch: true, integrationBranchEnabled: true } } },
      },
    },
  });
}

type OpenPrWorker = Awaited<ReturnType<typeof openPrWorkersQuery>>[number];
type InboxWorkspace = { id: string; name: string; repo: string | null; gitConfig: any; teamId: string | null; maxConcurrentTasks: number; dataClass?: string | null };

interface EscalationItem {
  humanReview?: HumanPrReview | null;
  reviewApproved?: boolean;
  workerId: string;
  taskId: string;
  taskTitle: string;
  workspaceId: string;
  workspaceName: string;
  prNumber: number | null;
  prUrl: string | null;
  policyTier: string;
  missionId: string | null;
  missionTitle: string | null;
  ciGate: CiGate | null;
  recommendation: string | null;
  leaseState: 'agent_approved' | 'agent_flagged' | 'pending_human';
  escalationReason: string | null;
  /** See EscalationRawItem.hasEscalationNote — an open reviewer_escalated note exists. */
  hasEscalationNote: boolean;
  verdictSummary: string | null;
  /** The SHA the latest reviewer verdict was made against, if any. */
  approvedSha: string | null;
  /** The PR's current head — compared against approvedSha on the card. */
  headSha: string | null;
  waitingMinutes: number | null;
  conflictRetryTaskId: string | null;
  conflictRetryIteration: number | null;
  conflictAutoResolve: boolean;
  conflictReason: string | null;
  prLifecycleStatus: string | null;
  prOpenedAt: Date | null;
  prLifecycleVerifiedAt: Date | null;
  prIsDraft: boolean | null;
  deadZoneExhausted?: boolean;
  /** The escalation gate's verdict (lib/escalation-gate-check.ts). */
  gate?: EscalationGateMark | null;
  [key: string]: unknown;
}

interface EscalationInbox {
  items: EscalationItem[];
  workers: OpenPrWorker[];
  /** Per original task: the reviewer gate's decision (the PR blockers consult it too). */
  reviewerGateMap: Map<string, ReviewerGateResult>;
  /** Per original task: a review round still in flight on the PR's current head. */
  reviewInFlightByTaskId: Map<string, 'queued' | 'reviewing'>;
  /** Per human-review PR worker: the review facts the "Ask Jev" advice reads. */
  mergeAdviceBaseByWorkerId: Map<string, import('@/lib/merge-advice-server').MergeAdviceBase>;
  landingStateByTaskId: Map<string, { landing: unknown; handoff: unknown }>;
}

/**
 * The open PRs that fell to a person (BT-15), and the reviewer gate per PR:
 * the same decisions Home always made, from rows already read. No GitHub call
 * (approval facts come from the cache), and the mission PR's merge gate reads
 * its stored work holder and visual review.
 */
async function buildEscalationInbox(input: {
  openPrWorkers: OpenPrWorker[];
  wsById: Map<string, InboxWorkspace>;
  github: Map<string, import('@/lib/reviewer-gate').GithubApprovalFacts | null>;
  r2: {
    reviewerTasks: Array<Record<string, any>> | null;
    reviewerNotes: Array<{ taskId: string | null; type: string; body: string | null; title: string; status: string; createdAt: Date }> | null;
    conflictTasks: Array<Record<string, any>> | null;
    attemptTasks: Array<Record<string, any>> | null;
  };
  deliveryViews: Map<string, import('@/lib/workflow/projections').DeliveryView>;
  missionPrSummaries: Map<string, { visualReview: MissionVisualReviewState | null; workHolder: string | null }>;
  liveMissionPrState: Map<string, { workHolder?: string | null }>;
  now: number;
  wsIds: string[];
}): Promise<EscalationInbox> {
  const { openPrWorkers, wsById, github, r2, deliveryViews: inboxDeliveryViews } = input;
  const reviewerGateMap = new Map<string, ReviewerGateResult>();
  const reviewInFlightByTaskId = new Map<string, 'queued' | 'reviewing'>();
  const mergeAdviceBaseByWorkerId = new Map<string, import('@/lib/merge-advice-server').MergeAdviceBase>();
  const landingStateByTaskId = new Map<string, { landing: unknown; handoff: unknown }>();
  if (openPrWorkers.length === 0) return { items: [], workers: [], reviewerGateMap, reviewInFlightByTaskId, mergeAdviceBaseByWorkerId, landingStateByTaskId };

  // ── Reviewer task lookup: orderBy desc → first row seen per parentTaskId is the latest.
  const latestReviewerTaskByOrigId = new Map<string, {
    id: string; status: string; hasLiveWorker: boolean; createdAt: Date; roleSlug: string | null;
    reviewerWorkerId: string | null; reviewerStartedAt: Date | null; context: Record<string, unknown> | null;
    // The reviewer task's own stored result — the SAME row `get_pr_review`
    // reads via `derivePrReviewStatus`: a mission-less PR never gets a
    // reviewer_approved/reviewer_escalated note.
    result: unknown; startAt: Date | null; mission: { status: string } | null;
  }>();
  for (const rt of r2.reviewerTasks ?? []) {
    if (!rt.parentTaskId || latestReviewerTaskByOrigId.has(rt.parentTaskId)) continue;
    const liveWorker = rt.workers?.[0];
    latestReviewerTaskByOrigId.set(rt.parentTaskId, {
      id: rt.id, status: rt.status, hasLiveWorker: !!liveWorker, createdAt: rt.createdAt, roleSlug: rt.roleSlug ?? null,
      reviewerWorkerId: liveWorker?.id ?? null, reviewerStartedAt: liveWorker?.startedAt ?? null,
      context: rt.context, result: rt.result, startAt: rt.startAt, mission: rt.mission,
    });
  }
  const { escalationMap: reviewerEscalationMap, approvalMap: reviewerApprovalMap, supersededTaskIds } = selectReviewerEvidence((r2.reviewerNotes ?? []) as never);
  const escalatedMap = new Map([...reviewerEscalationMap].map(([taskId, evidence]) => [taskId, evidence.reason]));
  // Distinguishes "an open reviewer_escalated note exists" (an agent handed
  // this PR back with a concrete statement) from the gate's other human-actor
  // reasons, which are pure task-status inference.
  const escalationNoteTaskIds = new Set(reviewerEscalationMap.keys());
  // The reviewer's own advice on what the human should do next.
  const reviewerRecommendationMap = new Map(
    [...reviewerEscalationMap].filter(([, evidence]) => evidence.recommendation).map(([taskId, evidence]) => [taskId, evidence.recommendation as string]),
  );
  const approvedMap = new Map([...reviewerApprovalMap].map(([taskId, evidence]) => [taskId, evidence.summary]));

  // Landing's own record per PR (marker + handoff), read with the PR's task.
  for (const w of openPrWorkers) {
    const t = w.task as { landing?: unknown; landingHandoff?: unknown } | null;
    if (w.taskId && t) landingStateByTaskId.set(w.taskId, { landing: t.landing ?? null, handoff: t.landingHandoff ?? null });
  }

  // ── Reviewer gate ─────────────────────────────────────────────────────────
  // Single predicate (resolveReviewerGate) deciding, per PR, whether the
  // agent still owns the next move or it has genuinely fallen to the human.
  const reviewApprovedTaskIds = new Set<string>();
  const approvedAutoMergeTaskIds = new Set<string>();
  const humanReviewByTaskId = new Map<string, HumanPrReview>();
  const gateNow = new Date(input.now);
  const stallFactsLoader = createReviewerStallFactsLoader(gateNow);
  // The mission-aware tier each gate was resolved with, so the card reports
  // the same tier its gate decided on.
  const policyTierByTaskId = new Map<string, string>();
  const policies = new Map(openPrWorkers.flatMap(w => {
    if (!w.taskId) return [];
    const ws = wsById.get(w.workspaceId);
    const mission = (w.task as any)?.mission ?? null;
    const policy = ws
      ? resolvePolicy(ws as never, mission, { requiresReview: (w.task as any)?.requiresReview }, { baseRef: w.prBaseRef })
      : { tier: 'auto-threshold' as const };
    return [[w.taskId, policy] as const];
  }));
  // Stall facts for the PRs whose review has sat past the policy's threshold, read together.
  const stallFacts = new Map(await Promise.all(openPrWorkers.flatMap(w => {
    if (!w.taskId) return [];
    const ws = wsById.get(w.workspaceId);
    const rt = latestReviewerTaskByOrigId.get(w.taskId);
    const policy = policies.get(w.taskId) as { stallNotifyMinutes?: number } | undefined;
    const stalled = ws && !rt?.hasLiveWorker
      && gateNow.getTime() - (rt?.createdAt ?? w.completedAt ?? gateNow).getTime() > (policy?.stallNotifyMinutes ?? 30) * 60_000;
    return stalled ? [stallFactsLoader.load(ws as never, rt ?? {}).then(f => [w.taskId!, f] as const)] : [];
  })));
  for (const w of openPrWorkers) {
    if (!w.taskId) continue;
    const ws = wsById.get(w.workspaceId);
    const mission = (w.task as any)?.mission ?? null;
    const policy = policies.get(w.taskId) as ReturnType<typeof resolvePolicy>;
    policyTierByTaskId.set(w.taskId, policy.tier);
    const rt = latestReviewerTaskByOrigId.get(w.taskId);
    const reviewerTask = rt ? { status: rt.status as ReviewerTaskStatus, result: rt.result, context: rt.context } : null;
    // Mission notes never exist for a mission-less PR: fall back to the
    // reviewer task's own stored verdict (deriveStoredVerdictFallback).
    const fallback = deriveStoredVerdictFallback({
      escalationReason: escalatedMap.get(w.taskId) ?? null,
      approvalSummary: approvedMap.get(w.taskId) ?? null,
      reviewerTask,
      currentHeadSha: w.lastCommitSha ?? null,
    });
    if (fallback.escalationReason != null) escalatedMap.set(w.taskId, fallback.escalationReason);
    if (fallback.approvalSummary != null) approvedMap.set(w.taskId, fallback.approvalSummary);
    const githubFacts = github.get(w.id) ?? null;
    const humanReview = resolveHumanPrReview({
      reviewerTask,
      currentHeadSha: w.lastCommitSha ?? null,
      escalationReason: escalatedMap.get(w.taskId) ?? null,
      hasEscalationNote: escalationNoteTaskIds.has(w.taskId),
      recommendation: reviewerRecommendationMap.get(w.taskId) ?? null,
      policyTier: policy.tier,
      github: githubFacts,
    });
    if (humanReview) humanReviewByTaskId.set(w.taskId, humanReview);
    if (!humanReview && isCurrentReviewApproved({ reviewerTask, currentHeadSha: w.lastCommitSha ?? null, github: githubFacts })) {
      reviewApprovedTaskIds.add(w.taskId);
      if (isCurrentReviewApproved({ reviewerTask, currentHeadSha: w.lastCommitSha ?? null })
        && (policy.tier === 'auto-threshold' || (policy.tier === 'agent-review' && policy.agentReview?.gateCondition !== 'approve-only'))) {
        approvedAutoMergeTaskIds.add(w.taskId);
      }
    }
    const reviewInFlight = resolveReviewInFlight({
      reviewerTask: rt
        ? { status: rt.status as ReviewerTaskStatus, hasLiveWorker: rt.hasLiveWorker, createdAt: rt.createdAt, result: rt.result, context: rt.context }
        : null,
      currentHeadSha: w.lastCommitSha ?? null,
      now: gateNow,
      queuedThresholdMinutes: policy.stallNotifyMinutes,
    });
    if (reviewInFlight) reviewInFlightByTaskId.set(w.taskId, reviewInFlight);
    if (humanReview) {
      const reviewFacts = reviewFactsForAdvice({ reviewerTask, inFlight: !!reviewInFlight, policyTier: policy.tier });
      mergeAdviceBaseByWorkerId.set(w.id, {
        prLifecycleStatus: w.prLifecycleStatus ?? null,
        review: reviewFacts.review,
        reviewConfidence: reviewFacts.confidence,
        reviewHeadSha: reviewFacts.reviewHeadSha,
        githubApprovalRequired: humanReview.label === 'Approve on GitHub',
        draft: !!w.prIsDraft,
        policyTier: policy.tier,
        escalationCause: reviewFacts.escalationCause,
        linesAdded: w.linesAdded ?? null,
        linesRemoved: w.linesRemoved ?? null,
      });
    }
    // Who owns the landing: one derivation, consumed by the gate. An actual
    // human review request is a different ask and is left alone.
    const landing = !humanReview && w.prNumber != null
      ? resolveLandingOwnership({
          policy,
          landingMode: landingModeOf(ws?.gitConfig),
          landing: landingStateByTaskId.get(w.taskId)?.landing ?? null,
          handoff: landingStateByTaskId.get(w.taskId)?.handoff ?? null,
          prNumber: w.prNumber,
        })
      : undefined;
    // A handed-over PR is no longer the platform's, whatever the approval snapshot says.
    if (landing?.owner === 'human') approvedAutoMergeTaskIds.delete(w.taskId);
    reviewerGateMap.set(w.taskId, resolveReviewerGate({
      policyTier: policy.tier,
      escalationReason: escalatedMap.get(w.taskId) ?? null,
      approvalSummary: approvedMap.get(w.taskId) ?? null,
      reviewerTask: rt
        ? { status: rt.status as any, hasLiveWorker: rt.hasLiveWorker, createdAt: rt.createdAt, context: rt.context, startAt: rt.startAt }
        : null,
      queuedThresholdMinutes: policy.stallNotifyMinutes,
      stallFacts: stallFacts.get(w.taskId),
      prOpenedAt: w.completedAt ?? null,
      now: gateNow,
      // Under auto-threshold this decides "auto-merge still pending" (in
      // flight) vs "auto-merge was held" (needs you).
      prLifecycleStatus: w.prLifecycleStatus ?? null,
      prLifecycleUpdatedAt: w.updatedAt ?? null,
      // Option A′: the gate needs the base-ref fact itself, not just its
      // shadow in the tier. The mission row is selected above.
      isMissionIntegrationTaskPr: isMissionIntegrationBase({ baseRef: w.prBaseRef, mission }),
      landing,
      reviewApproved: reviewApprovedTaskIds.has(w.taskId),
    }));
  }

  // ── Mission-PR merge gate ───────────────────────────────────────────────
  // A mission's own integration PR can look reviewer-approved and still be
  // refused at merge time (`guardMissionPrMerge`): ask the same decision here
  // so the card never advertises a merge the gate was always going to refuse.
  // It reads the mission's stored work holder and visual review: no GitHub,
  // and an owed review is filed after the response, never from the render.
  const missionPrGateMap = new Map<string, string | null>();
  for (const w of openPrWorkers) {
    if (!w.taskId || !w.task || !isMissionPrTask(w.task) || !w.task.missionId) continue;
    const missionId = w.task.missionId;
    const s = input.missionPrSummaries.get(missionId);
    const workHolder = s?.workHolder ?? input.liveMissionPrState.get(missionId)?.workHolder ?? null;
    // No stored summary yet: the review state reads as unreadable (the gate refuses), and it is written for the next load.
    const { gate, scheduleVisualReview } = missionPrMergeDecision(workHolder, s?.visualReview ?? null);
    if (!s) HOME_MISSION_SUMMARIES.refresh(missionId);
    if (scheduleVisualReview) {
      // Whoever opens Home with the branch ready also gets the review on its way; best-effort and idempotent.
      after(() => HOME_MISSION_SUMMARIES.scheduleVisualReview(missionId));
    }
    missionPrGateMap.set(w.taskId, gate.blocks ? gate.reason ?? null : null);
  }

  // ── Conflict retry lease detection ──────────────────────────────────────
  // While a conflict-retry task is live for a PR, the card renders as
  // RESOLVING rather than asking the human to merge.
  const conflictRetryMap = new Map<string, { taskId: string; iteration: number }>();
  // The newest conflict retry per PR, live or not: its failure context names the conflict.
  const conflictReasonMap = new Map<string, string>();
  // S37: live conflict fixes that stalled, with why.
  const conflictStalledMap = new Map<string, string>();
  const conflictTasks = r2.conflictTasks ?? [];
  for (const t of conflictTasks) {
    if (t.creationSource !== 'conflict' || t.conflictRetryPrNumber == null) continue;
    const key = `${t.workspaceId}:${t.conflictRetryPrNumber}`;
    const ctx = (t.context ?? {}) as Record<string, unknown>;
    if (!conflictReasonMap.has(key)) {
      const reason = describeConflictReason(ctx.failureContext);
      if (reason) conflictReasonMap.set(key, reason);
    }
    if (!(LIVE_TASK_STATUSES as readonly string[]).includes(t.status)) continue;
    if (conflictRetryMap.has(key)) continue;
    const iteration = typeof ctx.conflictIteration === 'number' ? ctx.conflictIteration : 1;
    conflictRetryMap.set(key, { taskId: t.id, iteration });
    // S37: a live fix that stalled is still the canonical remediation, but it must say so.
    const liveness = classifyConflictFix({ status: t.status, createdAt: t.createdAt, claimedAt: t.claimedAt, lastRecoveryAt: (ctx.conflictRecovery as { at?: string } | undefined)?.at ?? null });
    if (liveness.stalled && liveness.reason) conflictStalledMap.set(key, liveness.reason);
  }

  // ── CI / reviewer-retry fix-attempt detection ───────────────────────────
  // A red PR is only waiting on the human once no [CI Retry] agent is left
  // working on it, and a PR with an outstanding request-changes verdict only
  // once no reviewer-retry fix is queued or running for it.
  const ciAttemptMap = new Map<string, {
    liveTaskId: string | null; liveIteration: number | null; liveKind: 'ci' | 'review'; liveClaimed: boolean;
    liveTaskTitle: string | null; attemptsConsumed: number; recommendation: string | null;
  }>();
  for (const t of r2.attemptTasks ?? []) {
    const ctx = (t.context ?? {}) as Record<string, unknown>;
    const prNumber = Number(ctx.prNumber);
    if (!Number.isFinite(prNumber)) continue;
    const key = `${t.workspaceId}:${prNumber}`;
    const entry = ciAttemptMap.get(key) ?? {
      liveTaskId: null, liveIteration: null, liveKind: 'ci' as const, liveClaimed: false,
      liveTaskTitle: null, attemptsConsumed: 0, recommendation: null,
    };
    const iteration = typeof ctx.iteration === 'number' ? ctx.iteration : null;
    if ((LIVE_TASK_STATUSES as readonly string[]).includes(t.status)) {
      // Rows arrive newest-first, so the first live row is the current attempt.
      if (!entry.liveTaskId) {
        entry.liveTaskId = t.id;
        entry.liveIteration = iteration;
        entry.liveKind = t.reviewerRetryPrNumber != null ? 'review' : 'ci';
        entry.liveClaimed = (t.workers?.length ?? 0) > 0;
        entry.liveTaskTitle = t.title;
      }
    } else {
      // context.iteration is the retry budget counter: max() is the number
      // of attempts actually charged to the agent.
      entry.attemptsConsumed = Math.max(entry.attemptsConsumed, iteration ?? 0);
      const suggestion = (t.result as { nextSuggestion?: string } | null)?.nextSuggestion;
      if (!entry.recommendation && suggestion) entry.recommendation = suggestion;
    }
    ciAttemptMap.set(key, entry);
  }

  // ── Dead zone exhausted detection ───────────────────────────────────────
  // Terminal task + PR went dirty + no active conflict retry + every retry
  // spent → BLOCKED card.
  const deadZoneExhaustedMap = new Map<string, { lastRetryTaskId: string | null }>();
  for (const w of openPrWorkers) {
    if (w.prLifecycleStatus !== 'conflict' || w.prNumber == null) continue;
    if (conflictRetryMap.has(`${w.workspaceId}:${w.prNumber}`)) continue;
    const taskStatus = (w.task as any)?.status as string | undefined;
    if (taskStatus == null || !['completed', 'failed', 'cancelled'].includes(taskStatus)) continue;
    const completedRetries = conflictTasks.filter(t =>
      t.workspaceId === w.workspaceId && t.conflictRetryPrNumber === w.prNumber && ['completed', 'failed', 'cancelled'].includes(t.status),
    );
    if (completedRetries.length >= DEFAULT_MAX_CONFLICT_ITERATIONS) {
      deadZoneExhaustedMap.set(w.id, { lastRetryTaskId: completedRetries[0]?.id ?? null });
    }
  }

  const items: EscalationItem[] = openPrWorkers
    .filter(w => {
      const taskTitle = (w.task as any)?.title ?? '';
      if (taskTitle.startsWith('[smoke-test')) return false;
      if (w.taskId && supersededTaskIds.has(w.taskId)) return false;
      // Kernel-owned deliveries decide membership themselves (S36).
      const kernelView = w.taskId ? inboxDeliveryViews.get(w.taskId) : undefined;
      if (kernelView && kernelView.owner !== 'landing') return kernelInboxMembership(kernelView, false);
      // Include if a conflict retry is live (renders as RESOLVING)
      if (w.prNumber != null && conflictRetryMap.has(`${w.workspaceId}:${w.prNumber}`)) return true;
      // Dead zone exhausted — all retries failed, PR needs human action (BLOCKED)
      if (deadZoneExhaustedMap.has(w.id)) return true;
      // Otherwise the reviewer gate is the single source of truth. An
      // orphaned worker (taskId null) has no gate entry: fall back to the tier.
      if (!w.taskId) {
        const ws = wsById.get(w.workspaceId);
        return !!ws && resolvePolicy(ws as never).tier === 'human';
      }
      // Human-owned PRs, plus auto-merge PRs as in-flight cards.
      return humanReviewByTaskId.has(w.taskId) || gateReachesActionQueue(reviewerGateMap.get(w.taskId));
    })
    .map(w => {
      const ws = wsById.get(w.workspaceId);
      // The tier the gate resolved (mission-aware), not the workspace default.
      const policy = { tier: (w.taskId ? policyTierByTaskId.get(w.taskId) : undefined) ?? (ws ? resolvePolicy(ws as never).tier : 'auto-threshold') };
      const gate = w.taskId ? reviewerGateMap.get(w.taskId) : undefined;
      const verdictSummary = (w.taskId ? approvedMap.get(w.taskId) : undefined) ?? null;
      // The SHA the most recent reviewer task's verdict was made against: a
      // terminal verdict at the current head has nothing new to re-review.
      const rt = w.taskId ? latestReviewerTaskByOrigId.get(w.taskId) : undefined;
      const approvedShaRaw = rt?.context && typeof rt.context === 'object' ? (rt.context as Record<string, unknown>).headSha : undefined;
      const approvedSha = typeof approvedShaRaw === 'string' ? approvedShaRaw : null;
      const waitingMinutes = w.completedAt ? Math.round((input.now - new Date(w.completedAt).getTime()) / 60000) : null;
      const leaseState: 'agent_approved' | 'agent_flagged' | 'pending_human' =
        verdictSummary ? 'agent_approved'
        : gate?.reason && policy.tier !== 'human' ? 'agent_flagged'
        : 'pending_human';
      const conflictRetry = w.prNumber != null ? conflictRetryMap.get(`${w.workspaceId}:${w.prNumber}`) : undefined;
      const deadZoneInfo = deadZoneExhaustedMap.get(w.id);
      const ciAttempts = w.prNumber != null ? ciAttemptMap.get(`${w.workspaceId}:${w.prNumber}`) : undefined;
      const ciGate = resolveCiGate({
        prLifecycleStatus: w.prLifecycleStatus as PrLifecycle,
        liveFixTaskId: ciAttempts?.liveTaskId ?? null,
        liveFixIteration: ciAttempts?.liveIteration ?? null,
        maxCiRetries: ws?.gitConfig?.maxCiRetries ?? DEFAULT_MAX_CI_RETRIES,
        attemptsConsumed: ciAttempts?.attemptsConsumed ?? 0,
        recommendation: ciAttempts?.recommendation ?? ((w.task as any)?.result?.nextSuggestion ?? null),
        liveFixKind: ciAttempts?.liveKind,
        liveFixClaimed: ciAttempts?.liveClaimed ?? null,
        liveFixTaskTitle: ciAttempts?.liveTaskTitle ?? null,
      });
      return {
        workerId: w.id,
        taskId: w.taskId ?? '',
        taskTitle: (w.task as any)?.title ?? '',
        workspaceId: w.workspaceId,
        workspaceName: ws?.name ?? '',
        prNumber: w.prNumber,
        prUrl: w.prUrl,
        reviewApproved: !!w.taskId && reviewApprovedTaskIds.has(w.taskId),
        humanReview: w.taskId ? humanReviewByTaskId.get(w.taskId) ?? null : null,
        policyTier: policy.tier,
        autoMerge: gate?.platformState === 'auto_merge' || (!!w.taskId && approvedAutoMergeTaskIds.has(w.taskId)),
        missionId: (w.task as any)?.missionId ?? null,
        missionTitle: (w.task as any)?.mission?.title ?? null,
        ciGate,
        // CI block leads with the fixing agent's handoff; otherwise the
        // reviewer's recommendation is what the human needs to read.
        recommendation: ciGate?.kind === 'blocked'
          ? ciGate.recommendation
          : (w.taskId ? reviewerRecommendationMap.get(w.taskId) ?? null : null),
        leaseState,
        escalationReason: deadZoneInfo
          ? `Agents failed ${DEFAULT_MAX_CONFLICT_ITERATIONS} conflict-resolution attempts. Resolve the conflict yourself.`
          : (gate?.reason ?? (w.taskId ? inboxDeliveryViews.get(w.taskId)?.detail ?? inboxDeliveryViews.get(w.taskId)?.headline : null) ?? null),
        // Dead-zone has its own CTA set and is never sourced from a reviewer note.
        hasEscalationNote: !deadZoneInfo && !!w.taskId && escalationNoteTaskIds.has(w.taskId),
        verdictSummary,
        approvedSha,
        headSha: w.lastCommitSha ?? null,
        waitingMinutes,
        conflictRetryTaskId: conflictRetry?.taskId ?? null,
        conflictRetryIteration: conflictRetry?.iteration ?? null,
        deadZoneExhausted: !!deadZoneInfo,
        deadZoneLastRetryTaskId: deadZoneInfo?.lastRetryTaskId ?? null,
        conflictAutoResolve: isAutoResolveMergeConflictsEnabled(ws?.gitConfig),
        conflictReason: w.prNumber != null ? conflictReasonMap.get(`${w.workspaceId}:${w.prNumber}`) ?? null : null,
        remediationStalled: w.prNumber != null ? conflictStalledMap.get(`${w.workspaceId}:${w.prNumber}`) ?? null : null,
        // Read from persisted columns only (I-9): the sweep owns all GitHub
        // resolution, this layer only judges how old that resolution is.
        prLifecycleStatus: w.prLifecycleStatus ?? null,
        prOpenedAt: w.completedAt ?? w.createdAt ?? null,
        prLifecycleVerifiedAt: w.prLastVerifiedAt ?? null,
        prIsDraft: w.prIsDraft ?? null,
        missionMergeBlockedReason: w.taskId ? missionPrGateMap.get(w.taskId) ?? null : null,
        missionPrRole: w.task ? missionPrRoleOf(w.task) : null,
        reviewInFlight: w.taskId ? reviewInFlightByTaskId.get(w.taskId) ?? null : null,
        prLifecycleUpdatedAt: w.updatedAt ?? null,
      };
    })
    .sort((a, b) => {
      // Human review actions lead even while machine work continues.
      // Keep every action: an inbox cap silently hides requested reviews.
      const handled = (i: { humanReview?: HumanPrReview | null; ciGate?: { kind: string } | null; autoMerge?: boolean; reviewInFlight?: string | null }) =>
        (!i.humanReview && (i.ciGate?.kind === 'fixing' || i.ciGate?.kind === 'running' || i.reviewInFlight || (i.autoMerge && !i.ciGate)) ? 1 : 0);
      const handledDiff = handled(a) - handled(b);
      if (handledDiff !== 0) return handledDiff;
      const arcDiff = Number(!!b.missionId) - Number(!!a.missionId);
      if (arcDiff !== 0) return arcDiff;
      return (a.waitingMinutes ?? 0) - (b.waitingMinutes ?? 0);
    });
  return { items, workers: openPrWorkers, reviewerGateMap, reviewInFlightByTaskId, mergeAdviceBaseByWorkerId, landingStateByTaskId };
}

/**
 * Escalation gate: the same verdict the PR inbox, list_prs and the pushes
 * read (lib/escalation-gate-check.ts), stored verdicts and rules only; the
 * rest is looked at after the response. A PR whose next move is Buildd's is
 * never a Needs You card. A gate failure leaves every card as it was.
 */
async function gateInbox(
  inbox: EscalationInbox,
  wsById: Map<string, InboxWorkspace>,
  deliveryViews: Map<string, import('@/lib/workflow/projections').DeliveryView>,
  now: number,
): Promise<EscalationItem[]> {
  if (inbox.items.length === 0) return inbox.items;
  try {
    const workerById = new Map(inbox.workers.map(w => [w.id, w]));
    const stalls = await loadLandingStalls(inbox.items.map(e => e.taskId).filter(Boolean), now);
    const gateSubjects = inbox.items.flatMap(e => {
      const ws = wsById.get(e.workspaceId);
      const w = workerById.get(e.workerId);
      if (!ws?.teamId || !w) return [];
      const view = e.taskId ? deliveryViews.get(e.taskId) : undefined;
      const landingRow = e.taskId ? inbox.landingStateByTaskId.get(e.taskId) : undefined;
      const own = landingRow?.handoff && e.prNumber != null
        ? resolveLandingOwnership({ policy: { tier: 'agent-review', agentReview: undefined }, landingMode: 'enforce', landing: landingRow.landing, handoff: landingRow.handoff, prNumber: e.prNumber })
        : null;
      const cause = (landingRow?.handoff as { cause?: unknown } | null | undefined)?.cause;
      return [{
        workerId: e.workerId,
        subject: prSubjectFor({
          teamId: ws.teamId, sensitive: ws.dataClass === 'sensitive',
          workspaceId: e.workspaceId, prNumber: e.prNumber, taskId: e.taskId || null,
          task: (w.task as any) ?? null, missionPrRole: w.task ? missionPrRoleOf(w.task) : null, lifecycle: e.prLifecycleStatus, headSha: e.headSha,
          kernel: view ? { stateReason: view.stateReason, prState: view.prState, detail: view.detail, headline: view.headline } : null,
          escalated: e.hasEscalationNote ? { reason: e.escalationReason } : null,
          approved: !!e.reviewApproved || e.leaseState === 'agent_approved',
          handoff: own?.owner === 'human' ? { cause: typeof cause === 'string' ? cause : 'unknown', reason: own.reason } : null,
          conflictFixesSpent: !!e.deadZoneExhausted,
          machineActing: reviewMachineActing(e as never, new Date(now)),
          landingStall: e.taskId ? stalls.get(e.taskId) ?? null : null,
          pathManifest: ((w.task as any)?.pathManifest as string[] | null | undefined) ?? null,
          draft: e.prIsDraft,
          linesChanged: w.linesAdded != null || w.linesRemoved != null ? (w.linesAdded ?? 0) + (w.linesRemoved ?? 0) : null,
          reviewedHeadSha: e.approvedSha,
          agentReviewsDataMigrations: agentReviewsDataMigrations(ws.gitConfig?.mergePolicy),
        }),
      }];
    });
    const unique = [...new Map(gateSubjects.map(g => [g.subject.key, g.subject])).values()];
    const verdicts = await gateEscalations(unique, ESCALATION_GATE_READ_DEPS());
    const byWorker = new Map(gateSubjects.flatMap(g => {
      const v = verdicts.get(g.subject.key);
      return v ? [[g.workerId, { owner: v.owner, reason: v.reason, rail: v.owner === 'person' ? v.rail ?? null : null, teamId: g.subject.teamId ?? null }] as const] : [];
    }));
    return inbox.items.map(e => ({ ...e, gate: byWorker.get(e.workerId) ?? null }));
  } catch (err) {
    console.warn('[home] escalation gate failed (non-fatal, every card kept):', err instanceof Error ? err.message : 'unknown');
    return inbox.items;
  }
}

export default withPageBudget('home', HomePage);

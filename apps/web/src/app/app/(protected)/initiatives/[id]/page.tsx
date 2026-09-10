import { db } from '@buildd/core/db';
import { initiatives, missions, artifacts, workspaces, externalLinks } from '@buildd/core/db/schema';
import { eq, and, desc, inArray, ne, or, isNull } from 'drizzle-orm';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
import { computeMissionProgress, computeInitiativeProgress, computeInitiativeSegments, deriveCriteriaGatePresentation, CRITERIA_GATE_TONE_CLASS, type ChildMissionProgress } from '@buildd/core/mission-helpers';
import TrackerProgressPanel from '@/components/TrackerProgressPanel';
import { MissionBadges } from '@/components/MissionProgress';
import { MissionProgressBar } from '@/components/MissionProgressBar';
import { SegmentStrip } from '@/components/SegmentStrip';
import { SparklineBar } from '@/components/SparklineBar';
import { deriveTaskHealthSignal, formatNextRun } from '@/lib/mission-helpers';
import { buildMissionWithInitiativeUrl } from '@/lib/initiative-breadcrumb';
import { loadShippedMissionIds } from '@/lib/mission-ship-state';
import {
  loadInitiativeEffort,
  loadInitiativeVerdictInputs,
  deriveInitiativeVerdict,
  derivePendingCounts,
  countBlockedByPR,
  emptyVerdictRollup,
  zeroEffortWindow,
  noPendingCounts,
  type BlockingTask,
} from '@/lib/initiative-pulse';
import { verdictChip } from '@/lib/verdict-presentation';
import {
  missionContributions,
  buildPendingChips,
  formatVerdictEvidence,
  formatEffortTotal,
  latestWorkerPerTask,
  verdictEvidenceAnchor,
  DETAIL_SPARKLINE_WIDTH,
  DETAIL_SPARKLINE_HEIGHT,
  KPI_ANCHOR,
  MISSIONS_ANCHOR,
} from './verdict-blocks';
import AssignMissionModal, { type AssignableMission } from './AssignMissionModal';
import InitiativeKPIPanel from './InitiativeKPIPanel';

export const dynamic = 'force-dynamic';

const ROLLUP_ACCENT: Record<string, string> = {
  blocked: 'bg-status-warning',
  active: 'bg-status-info',
  completed: 'bg-status-success',
  paused: 'bg-text-muted',
  empty: 'bg-text-muted',
};

export default async function InitiativeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const teamIds = await getUserTeamIds(user.id);

  const initiative = await db.query.initiatives.findFirst({
    where: eq(initiatives.id, id),
    columns: { id: true, title: true, description: true, status: true, teamId: true, workspaceId: true, kpis: true, kpiState: true, autoVerify: true },
    with: {
      workspace: { columns: { id: true, name: true } },
      missions: {
        // isHeld + updatedAt feed the `held` and `shippedThisWeek` pending
        // counts (§6.1) from rows this page already loads — §6.2's "a surface
        // that renders missions pays nothing extra for its counts".
        columns: { id: true, title: true, status: true, priority: true, orchestrationMode: true, dependsOnMissionId: true, dependencyMetAt: true, isHeld: true, updatedAt: true },
        orderBy: [desc(missions.priority), desc(missions.createdAt)],
        with: {
          tasks: {
            // dependsOn is what `countBlockedByPR` walks.
            columns: { id: true, status: true, kind: true, title: true, mode: true, creationSource: true, category: true, parentTaskId: true, taskClass: true, dependsOn: true },
            // ALL workers, newest first. The latest one drives ghost (in-flight)
            // / half (PR-open) segment states — `latestWorkerPerTask` below
            // narrows to it, so widening this cannot move the progress bar. The
            // full list is what `derivePendingCounts` needs: the open PR that
            // makes a task await merge is not always on the newest worker.
            with: { workers: { columns: { status: true, prUrl: true, prNumber: true, mergedAt: true, prLifecycleStatus: true }, orderBy: (w: any, { desc }: any) => [desc(w.startedAt)] } },
          },
        },
      },
    },
  });

  if (!initiative) notFound();

  // Team-scoped access: team match OR open-access workspace.
  let hasAccess = teamIds.includes(initiative.teamId);
  if (!hasAccess && initiative.workspaceId) {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, initiative.workspaceId),
      columns: { accessMode: true },
    });
    hasAccess = ws?.accessMode === 'open';
  }
  if (!hasAccess) notFound();

  const noNextRun = formatNextRun(null, null);
  const children: ChildMissionProgress[] = [];
  const missionRows = (initiative.missions || []).map((m: any) => {
    const { totalTasks, completedTasks, progress, segments } = computeMissionProgress(
      latestWorkerPerTask(m.tasks || []),
    );
    const health = deriveTaskHealthSignal(
      { dependsOnMissionId: m.dependsOnMissionId, dependencyMetAt: m.dependencyMetAt },
      m.tasks || [],
    );
    children.push({ status: m.status as ChildMissionProgress['status'], totalTasks, completedTasks });
    return { id: m.id, title: m.title, status: m.status, orchestrationMode: m.orchestrationMode, progress, totalTasks, completedTasks, segments, health };
  });
  const rollup = computeInitiativeProgress(children);
  // Aggregate every child's task segments into one run for the rollup bar — the
  // same SegmentStrip primitive the mission surfaces use, never a parallel renderer.
  const aggregateSegments = computeInitiativeSegments(missionRows);

  // ── The initiative pulse (§5.1) ──
  //
  // §6.2: ONE loader, three callers. Everything below comes from
  // `lib/initiative-pulse.ts` — the same functions `/app/initiatives` calls —
  // so this page cannot disagree with the row that links to it (§5.2). No
  // verdict is re-derived and no count is recomputed here.
  const [effortByInitiative, rollupByInitiative] = await Promise.all([
    loadInitiativeEffort({ teamId: initiative.teamId }),
    loadInitiativeVerdictInputs({ teamId: initiative.teamId }),
  ]);
  const effortDays = effortByInitiative.get(id) ?? zeroEffortWindow();
  const rollupInputs = rollupByInitiative.get(id) ?? emptyVerdictRollup(initiative.status);

  // `dependsOn` crosses mission boundaries, so the blocking index spans every
  // mission loaded above rather than being rebuilt per mission.
  //
  // KNOWN DIVERGENCE — do not read the previous version of this comment, which
  // claimed the list shares this blind spot "which is why the two still agree".
  // It does not, and they do not. `countBlockedByPR`'s index is built by each
  // caller, and the three callers use three different scopes: the Initiatives
  // list indexes every mission of every initiative it loaded, this page indexes
  // only *this* initiative's missions, and Home narrows by the active workspace
  // filter. So a task here depending on a completed task in a *different*
  // initiative is invisible to this index but visible to the list's — and
  // `blocked` can therefore differ between the two surfaces, violating §5.2 /
  // AC-29. A dependency on a task in a mission with no initiative at all is
  // invisible to every caller, so that number is wrong on all of them.
  //
  // The fix is a loader-owned, team-scoped blocking index (see the follow-ups in
  // docs/design/mission-delivery-arc.md); it needs to change this file and
  // missions/page.tsx together, so it is recorded rather than half-applied.
  const taskIndex = new Map<string, BlockingTask>();
  for (const m of (initiative.missions || []) as any[]) {
    for (const t of m.tasks ?? []) taskIndex.set(t.id, t);
  }

  // Ship state, not the mission.status row transition (docs/design/mission-delivery-arc.md,
  // "The missing dimension: ship state") — matching how the list builds this.
  const missionIds = ((initiative.missions || []) as any[]).map((m) => m.id as string);
  const shippedMissionIds = await loadShippedMissionIds(missionIds);
  const pulseMissions = ((initiative.missions || []) as any[]).map((m) => ({
    id: m.id as string,
    initiativeId: id,
    isHeld: Boolean(m.isHeld),
    shipped: shippedMissionIds.has(m.id as string),
    lastActivityAt: m.updatedAt ? new Date(m.updatedAt).toISOString() : null,
    blockedPRCount: countBlockedByPR(m.tasks ?? [], taskIndex),
    tasks: m.tasks ?? [],
  }));

  const counts = derivePendingCounts(pulseMissions).get(id) ?? noPendingCounts();
  const { verdict, confidence, tokens7d } = deriveInitiativeVerdict({
    rollup: rollupInputs,
    effortDays,
    counts,
  });
  const chip = verdictChip(verdict);
  const kpiCount = ((initiative.kpis as any[]) ?? []).length;
  const evidenceAnchor = verdictEvidenceAnchor({ confidence, kpiCount });
  const pendingChips = buildPendingChips(missionContributions(pulseMissions, id), {
    initiativeId: id,
  });

  const initiativeArtifacts = await db.query.artifacts.findMany({
    where: eq(artifacts.initiativeId, id),
    orderBy: [desc(artifacts.updatedAt)],
    limit: 20,
    columns: { id: true, title: true, type: true, shareToken: true, updatedAt: true },
  });

  // Linear Phase 2: only mount the tracking panel if ≥1 child mission has a
  // linear link. Single indexed query over the child mission ids (cheap gate).
  const childMissionIds = missionRows.map((m) => m.id);
  const hasLinearLink =
    childMissionIds.length > 0 &&
    (
      await db
        .select({ id: externalLinks.id })
        .from(externalLinks)
        .where(
          and(
            eq(externalLinks.provider, 'linear'),
            eq(externalLinks.builddEntityType, 'mission'),
            inArray(externalLinks.builddEntityId, childMissionIds),
          ),
        )
        .limit(1)
    ).length > 0;

  // Assignable missions: same team, not already in THIS initiative.
  // Includes unassigned missions (initiativeId IS NULL) and missions in other initiatives.
  // Shown in the AssignMissionModal picker for the operator to link.
  const assignableMissionRows = await db.query.missions.findMany({
    where: and(
      eq(missions.teamId, initiative.teamId),
      or(isNull(missions.initiativeId), ne(missions.initiativeId, id)),
    ),
    columns: { id: true, title: true, workspaceId: true, initiativeId: true },
    with: {
      workspace: { columns: { id: true, name: true } },
      initiative: { columns: { id: true, title: true } },
    },
    orderBy: [desc(missions.createdAt)],
    limit: 100,
  });

  const assignableMissions: AssignableMission[] = assignableMissionRows.map((m) => ({
    id: m.id,
    title: m.title,
    workspaceName: (m.workspace as any)?.name || null,
    initiativeId: m.initiativeId || null,
    initiativeTitle: (m.initiative as any)?.title || null,
  }));

  return (
    <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8 max-w-5xl">
      {/* Breadcrumbs */}
      <div className="flex items-center gap-2 text-[12px] text-text-muted mb-5">
        <Link href="/app/initiatives" className="hover:text-text-secondary transition-colors">
          Initiatives
        </Link>
        <span>/</span>
        <span className="text-text-secondary truncate">{initiative.title}</span>
      </div>

      {/* Rollup header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1.5">
          <h1 className="text-xl font-semibold text-text-primary font-sans">{initiative.title}</h1>
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-[rgba(255,255,255,0.06)] text-text-secondary capitalize">
            {initiative.status}
          </span>
        </div>
        {/* Verdict and its evidence (§5.1, §6.5) — the page's first claim.
            The verdict answers "are we winning"; the percentage below is the
            scope meter and MUST NOT be read as the headline. The evidence line
            is mandatory: a verdict a reader cannot audit is a slogan. */}
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <span
            className={`shrink-0 text-[11px] font-semibold uppercase tracking-wide px-1.5 py-0.5 border ${chip.className}`}
          >
            {chip.label}
          </span>
          {/* Confidence is a qualifier and never changes the verdict (§6.5). It
              links to the KPI panel when there is one to fix. */}
          {confidence === 'unverified' && (
            evidenceAnchor ? (
              <a
                href={evidenceAnchor}
                className="shrink-0 text-[11px] text-text-muted underline decoration-dotted hover:text-text-secondary transition-colors"
                title="No goal criteria or KPI has checked this outcome — review the KPIs"
              >
                unverified
              </a>
            ) : (
              <span
                className="shrink-0 text-[11px] text-text-muted"
                title="No goal criteria or KPI has checked this outcome"
              >
                unverified
              </span>
            )
          )}
          <span className="text-[12px] text-text-muted tabular-nums">
            {formatVerdictEvidence({
              merges7d: rollupInputs.merges7d,
              attempts7d: rollupInputs.attempts7d,
              tokens7d,
            })}
          </span>
        </div>

        {initiative.description && (
          <p className="text-sm text-text-secondary mb-3 whitespace-pre-wrap">{initiative.description}</p>
        )}
        <div className="flex items-center gap-3 mb-1.5 flex-wrap">
          <span className="text-sm font-medium text-text-primary">{rollup.progress}%</span>
          <span className="text-[12px] text-text-muted">
            {rollup.completedMissions}/{rollup.totalMissions} missions · {rollup.completedTasks}/{rollup.totalTasks} tasks
          </span>
          {/* KPI gate: missions all done but KPIs not met — make this legible.
              Reads the same shared presentation as the mission detail banner and
              card pill, so "not yet verified" never gets the same treatment as
              an actual failure or a genuinely work-stopping state. */}
          {(() => {
            const kpis = (initiative.kpis as any[]) ?? [];
            const allMissionsDone = rollup.totalMissions > 0 && rollup.completedMissions === rollup.totalMissions;
            // The gate is only newsworthy once completion is actually on the
            // table — before that, unmet KPIs on an in-progress initiative are
            // expected, not a chip-worthy state.
            if (kpis.length === 0 || !allMissionsDone) return null;
            const kpiState = initiative.kpiState as { overall?: string; kpis?: any[] } | null;
            const gate = deriveCriteriaGatePresentation({
              criteriaCount: kpis.length,
              overall: (kpiState?.overall as any) ?? null,
              items: kpiState?.kpis as any,
              completionAttempted: true,
            });
            if (!gate || gate.state === 'clear') return null;
            return (
              <span
                className={`text-[11px] font-mono px-2 py-0.5 border rounded-sm ${CRITERIA_GATE_TONE_CLASS[gate.tone]}`}
                title="All child missions completed but KPIs not yet verified"
              >
                {gate.detail ? `${gate.label}: ${gate.detail}` : gate.label}
              </span>
            );
          })()}
        </div>
        {aggregateSegments.length > 0 ? (
          <div className="flex max-w-md">
            <SegmentStrip
              segments={aggregateSegments}
              continuous
              label={`${rollup.completedTasks} of ${rollup.totalTasks} tasks complete across ${rollup.totalMissions} missions`}
            />
          </div>
        ) : (
          // Task-less initiative (mission-weighted progress) — no segments to draw, so
          // fall back to a proportional status-colored bar.
          <div className="h-1.5 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden max-w-md">
            <div
              className={`h-full ${ROLLUP_ACCENT[rollup.status] ?? 'bg-text-muted'} transition-all`}
              style={{ width: `${rollup.progress}%` }}
            />
          </div>
        )}
      </div>

      {/* Pending-action strip (§5.1) — one chip per non-zero count, each a link
          to the surface that resolves it. A zero count renders no chip, and an
          all-zero initiative renders no strip: absence is the empty state. */}
      {pendingChips.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap mb-5">
          {pendingChips.map((pendingChip) => (
            <a
              key={pendingChip.key}
              href={pendingChip.href}
              className="text-[11px] font-mono px-2 py-0.5 border border-border-default text-text-secondary rounded-sm hover:border-border-hover hover:text-text-primary transition-colors"
            >
              {pendingChip.label}
            </a>
          ))}
        </div>
      )}

      {/* 14-day effort sparkline (§5.1, §6.4) at the ≥168×32 detail mount, plus
          the window total as text. Unconditional: an initiative with no activity
          renders 14 minimum-height bars and `0 tokens · 14d` (AC-21), never an
          absent element — "silent" is a finding, not a missing widget. */}
      <div className="flex items-center gap-2 mb-6">
        <SparklineBar
          days={effortDays}
          width={DETAIL_SPARKLINE_WIDTH}
          height={DETAIL_SPARKLINE_HEIGHT}
        />
        <span className="text-[11px] text-text-muted tabular-nums">
          {formatEffortTotal(effortDays)}
        </span>
      </div>

      {/* Linear Phase 2 — read-back tracking (only when a child mission is linked) */}
      {hasLinearLink && (
        <div className="mb-8">
          <TrackerProgressPanel entityType="initiative" entityId={id} />
        </div>
      )}

      {/* KPI panel — only renders when KPIs are set. The id is where an
          `unverified` verdict points (`verdictEvidenceAnchor`). */}
      {kpiCount > 0 && (
        <div id={KPI_ANCHOR.slice(1)}>
          <InitiativeKPIPanel
            initiativeId={id}
            kpis={(initiative.kpis as any) ?? []}
            kpiState={(initiative.kpiState as any) ?? null}
            autoVerify={(initiative.autoVerify as boolean | null) ?? null}
          />
        </div>
      )}

      {/* Missions — `MISSIONS_ANCHOR` is where a pending chip owned by more
          than one mission lands. */}
      <div id={MISSIONS_ANCHOR.slice(1)} className="mb-8">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
            Missions ({missionRows.length})
          </h2>
          <div className="flex items-center gap-2">
            <AssignMissionModal
              initiativeId={id}
              initiativeTitle={initiative.title}
              assignableMissions={assignableMissions}
            />
            <Link
              href={`/app/missions/new?initiative=${initiative.id}`}
              className="px-2.5 py-1 text-[11px] font-medium bg-primary text-white rounded-sm hover:bg-primary-hover transition-colors"
            >
              + New Mission
            </Link>
          </div>
        </div>
        {missionRows.length === 0 ? (
          <div className="card p-6 text-center">
            <p className="text-sm text-text-secondary mb-1">No missions under this initiative yet.</p>
            <p className="text-xs text-text-muted">
              Create a new mission or add an existing one.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {missionRows.map((m) => (
              // Card is a div (not a wrapping Link) so MissionProgress's in-flight task
              // link never nests inside another anchor. Title carries the mission link.
              <div key={m.id} className="card p-3 hover:border-border-hover transition-colors">
                <Link
                  href={buildMissionWithInitiativeUrl(m.id, id)}
                  className="text-sm text-text-primary truncate block hover:text-accent-text transition-colors mb-1"
                >
                  {m.title}
                </Link>
                <MissionBadges
                  mission={{ status: m.status, orchestrationMode: m.orchestrationMode, lastDeferralReason: null, lastDeferredAt: null }}
                  health={m.health}
                  nextRun={noNextRun}
                />
                {m.totalTasks > 0 && (
                  <div className="mt-1.5">
                    <MissionProgressBar
                      density="stacked"
                      segments={m.segments}
                      completedTasks={m.completedTasks}
                      totalTasks={m.totalTasks}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Initiative artifacts */}
      {initiativeArtifacts.length > 0 && (
        <div className="mb-8">
          <h2 className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">
            Artifacts ({initiativeArtifacts.length})
          </h2>
          <div className="flex flex-col gap-1.5">
            {initiativeArtifacts.map((a) => (
              <a
                key={a.id}
                href={a.shareToken ? `/share/${a.shareToken}` : '#'}
                className="card p-3 hover:border-border-hover transition-colors flex items-center gap-3"
              >
                <span className="text-sm text-text-primary truncate flex-1">{a.title || 'Untitled'}</span>
                <span className="text-[11px] text-text-muted shrink-0">{a.type}</span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

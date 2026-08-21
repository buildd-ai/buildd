import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
import { loadInitiativeList } from '@/lib/initiative-list';
import {
  loadInitiativeEffort,
  loadInitiativeVerdictInputs,
  deriveInitiativeVerdict,
  derivePendingCounts,
  countBlockedByPR,
  emptyVerdictRollup,
  zeroEffortWindow,
  noPendingCounts,
  type EffortDay,
  type VerdictRollup,
  type BlockingTask,
} from '@/lib/initiative-pulse';
import {
  partitionInitiativeZones,
  VERDICT_LABEL,
  NOT_WINNING_ORDER,
  type InitiativePulse,
} from '@/lib/verdict-presentation';
import { InitiativeTriage } from './InitiativeTriage';

export const dynamic = 'force-dynamic';

/**
 * The Initiatives list — the triage host (spec §4).
 *
 * One row per initiative, led by its verdict, partitioned into
 * Not-winning / Winning / Dormant. This replaced a grid of `InitiativeCard`s
 * whose only signal was a percentage and a lifecycle chip, which could not
 * distinguish an arc that ships from one that burns tokens without merging.
 */
export default async function InitiativesListPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const teamIds = await getUserTeamIds(user.id);
  const initiatives = await loadInitiativeList({ teamIds, pendingSignals: true });

  // Empty-collapse: with zero initiatives the page is pure absence — no zone
  // headers, no divider, no dormant control (AC-18).
  if (initiatives.length === 0) {
    return (
      <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8 max-w-5xl">
        <div className="card p-8 text-center max-w-md mx-auto mt-10">
          <p className="text-sm text-text-secondary mb-1">No initiatives yet.</p>
          <p className="text-xs text-text-muted mb-4">
            Group related missions under a durable arc to track cumulative progress.
          </p>
          <Link
            href="/app/initiatives/new"
            className="inline-block px-3 py-1.5 text-[12px] font-medium bg-primary text-white rounded-sm hover:bg-primary-hover transition-colors"
          >
            + New initiative
          </Link>
        </div>
      </div>
    );
  }

  // Effort and verdict evidence are both team-scoped (§6.5): one pair of loaders
  // per team, merged on initiative id. Initiative ids are globally unique, so the
  // merge cannot collide — and the `__unassigned__` bucket is dropped, since
  // missions without an initiative are a Missions-tab concern, not a row here.
  const effortByInitiative = new Map<string, EffortDay[]>();
  const rollupByInitiative = new Map<string, VerdictRollup>();
  await Promise.all(
    teamIds.map(async (teamId) => {
      const [effort, rollups] = await Promise.all([
        loadInitiativeEffort({ teamId }),
        loadInitiativeVerdictInputs({ teamId }),
      ]);
      for (const [id, days] of effort) effortByInitiative.set(id, days);
      for (const [id, rollup] of rollups) rollupByInitiative.set(id, rollup);
    }),
  );

  // `dependsOn` crosses mission boundaries, so the blocking index spans every
  // mission on the page rather than being rebuilt per initiative.
  const taskIndex = new Map<string, BlockingTask>();
  for (const initiative of initiatives) {
    for (const mission of initiative.missions) {
      for (const task of mission.tasks ?? []) taskIndex.set(task.id, task);
    }
  }

  const pulses: InitiativePulse[] = initiatives.map((initiative) => {
    const rollup = rollupByInitiative.get(initiative.id) ?? emptyVerdictRollup(initiative.status);
    const effortDays = effortByInitiative.get(initiative.id) ?? zeroEffortWindow();

    // A mission reads as shipped exactly when its status is 'completed' — the
    // first rule of `deriveMissionHealth` — so the counts agree with the Missions
    // tab without re-deriving full health here.
    const counts =
      derivePendingCounts(
        initiative.missions.map((mission) => ({
          initiativeId: initiative.id,
          isHeld: mission.isHeld,
          health: mission.status === 'completed' ? 'shipped' : mission.status,
          lastActivityAt: mission.updatedAt,
          blockedPRCount: countBlockedByPR(mission.tasks ?? [], taskIndex),
          tasks: mission.tasks ?? [],
        })),
      ).get(initiative.id) ?? noPendingCounts();

    const { verdict, confidence, tokens7d } = deriveInitiativeVerdict({ rollup, effortDays, counts });

    return {
      id: initiative.id,
      title: initiative.title,
      progress: initiative.progress.progress,
      effortDays,
      awaitingVerification: counts.awaitingVerification,
      blocked: counts.blocked,
      held: counts.held,
      shippedThisWeek: counts.shippedThisWeek,
      verdict,
      confidence,
      merges7d: rollup.merges7d,
      attempts7d: rollup.attempts7d,
      tokens7d,
      criteriaFail: rollup.criteriaFail,
      completedMissions: initiative.progress.completedMissions,
      totalMissions: initiative.progress.totalMissions,
      completedTasks: initiative.progress.completedTasks,
      totalTasks: initiative.progress.totalTasks,
    };
  });

  // Subheading counts arcs by verdict in ladder order, so the page states the
  // answer before any row is read. Silent when nothing is going wrong.
  const { notWinning } = partitionInitiativeZones(pulses);
  const notWinningSummary = NOT_WINNING_ORDER
    .map((verdict) => {
      const n = notWinning.filter((p) => p.verdict === verdict).length;
      return n > 0 ? `${n} ${VERDICT_LABEL[verdict].toLowerCase()}` : null;
    })
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-text-primary font-sans uppercase tracking-tight">Initiatives</h1>
          <p className="text-[12px] text-text-muted mt-1">
            {initiatives.length} {initiatives.length === 1 ? 'arc' : 'arcs'}
            {notWinningSummary ? ` · ${notWinningSummary}` : ''}
          </p>
        </div>
        <Link
          href="/app/initiatives/new"
          className="shrink-0 px-2.5 py-1 text-[11px] font-medium bg-primary text-white rounded-sm hover:bg-primary-hover transition-colors"
        >
          + New initiative
        </Link>
      </div>

      <InitiativeTriage items={pulses} teamId={teamIds[0] ?? 'none'} />
    </div>
  );
}

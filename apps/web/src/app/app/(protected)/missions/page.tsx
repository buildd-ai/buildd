import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { NewWorkLink } from '@/components/chat/ChatEntry';
import { taskEstimatesEnabled } from '@buildd/core/task-estimate-source';
import { taskEstimatesDefaultOn } from '@buildd/core/task-estimate-rollout';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveActiveTeamScope } from '@/lib/team-access';
import { loadMissionList } from '@/lib/mission-list-load';
import { decodeCompletedCursor } from '@/lib/missions-query';
import { MissionGrid } from './MissionGrid';
import NewMissionSheet from './NewMissionSheet';

export const dynamic = 'force-dynamic';

export default async function MissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string; completedCursor?: string; group?: string; new?: string }>;
}) {
  const { workspace: wsFilter, completedCursor: completedCursorParam, group: groupParam, new: newParam } = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  // Namespace this view to the active team (buildd-team cookie), from the
  // same resolver the protected layout already ran for this request.
  const cookieStore = await cookies();
  const scope = await resolveActiveTeamScope(user.id, cookieStore.get('buildd-team')?.value);
  const activeTeamId = scope.teamId;
  if (!activeTeamId) {
    return (
      <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8">
        <h1 className="sr-only md:not-sr-only md:mb-4 text-heading font-semibold text-text-primary">Missions</h1>
        <p className="text-body text-text-secondary">
          No team found. <Link href="/app/settings/team?new=1" className="text-text-primary underline underline-offset-4">Create a team</Link> to plan missions.
        </p>
      </div>
    );
  }

  // Every row reads the mission's stored summary (lib/mission-list-load.ts):
  // the same delivery card Home shows, its strip, last advance and next run.
  // With a workspace selected, team-level missions (no workspace) still show.
  // Rule P-4: the completed portion is one bounded keyset page.
  const now = Date.now();
  const [{ rows, nextCompletedCursor, slots }, planEnabled] = await Promise.all([
    loadMissionList({
      teamId: activeTeamId,
      workspaceId: wsFilter ?? null,
      completedCursor: decodeCompletedCursor(completedCursorParam),
      now,
    }),
    // Mission finish dates require a calibrated estimator as well as team availability.
    (async () => taskEstimatesDefaultOn() && await taskEstimatesEnabled(activeTeamId))(),
  ]);

  return (
    <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8 pb-10 max-w-[1180px]">
      {/* ?new=1: the New mission sheet (the form when chat is off, see NewWorkLink). */}
      {newParam === '1' && <NewMissionSheet userId={user.id} teamId={activeTeamId} />}
      <div className="mb-4 flex items-center justify-between gap-3">
        {/* The mobile header already reads "Missions · Team"; show the h1 from md up only. */}
        <h1 data-testid="missions-headline" className="sr-only md:not-sr-only text-heading font-semibold text-text-primary">
          Missions
        </h1>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {/* Releases and specs have no nav item; these are their doors. */}
          {planEnabled && (
            <Link href="/app/missions/plan" data-testid="missions-plan-link" className="btn btn-quiet h-11 md:h-8">
              Plan ›
            </Link>
          )}
          <Link href="/app/specs" data-testid="missions-specs-link" className="btn btn-quiet h-11 md:h-8">
            Specs
          </Link>
          <Link href="/app/releases" data-testid="missions-releases-link" className="btn btn-quiet h-11 md:h-8">
            Releases
          </Link>
          <NewWorkLink
            kind="mission"
            workspaceId={wsFilter ?? null}
            testId="new-mission-link"
            className="btn h-11 md:h-8"
          >
            + New
          </NewWorkLink>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-body text-text-secondary">No missions. A mission groups the tasks behind one goal.</p>
      ) : (
        <MissionGrid rows={rows} initialGroup={groupParam ?? null} slots={slots} now={now} />
      )}

      {/* Rule P-4: the completed portion is one bounded page; this is the
          escape hatch when a workspace has more than that. Replaces the
          visible completed page rather than appending — keeps the query
          layer a plain keyset page instead of client-side accumulation
          state, which nothing else on this list needs yet. */}
      {nextCompletedCursor && (
        <div className="mt-4 text-center">
          <Link
            href={`/app/missions?${new URLSearchParams({ ...(wsFilter ? { workspace: wsFilter } : {}), completedCursor: nextCompletedCursor }).toString()}`}
            className="text-meta text-text-muted hover:text-text-secondary"
          >
            Load older completed missions
          </Link>
        </div>
      )}
    </div>
  );
}

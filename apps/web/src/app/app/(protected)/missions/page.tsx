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
import MobileTopBarAction from '@/components/MobileTopBarAction';
import { MOBILE_TOP_BAR_ACTION_CLASS } from '@/components/MobileTopBar';
import { withPageBudget } from '@/lib/page-budget-watch';

export const dynamic = 'force-dynamic';

/** A door on the phone's stats line: quiet text, a 44px tap target. */
const DOOR_CLASS = 'inline-flex min-h-11 items-center px-2 text-text-secondary hover:text-text-primary';

async function MissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string; completedCursor?: string; group?: string; new?: string; q?: string }>;
}) {
  const { workspace: wsFilter, completedCursor: completedCursorParam, group: groupParam, new: newParam, q: qParam } = await searchParams;
  // `?q=`: the search run on the server, so it reaches every completed mission (Surface IA AC-65).
  const titleQuery = (qParam ?? '').trim().slice(0, 200);
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
      titleQuery: titleQuery || null,
      now,
    }),
    // Mission finish dates require a calibrated estimator as well as team availability.
    (async () => taskEstimatesDefaultOn() && await taskEstimatesEnabled(activeTeamId))(),
  ]);

  const listHref = (extra: Record<string, string>) =>
    `/app/missions?${new URLSearchParams({ ...(wsFilter ? { workspace: wsFilter } : {}), ...extra }).toString()}`;

  // The phone's doors to Plan, Specs and Releases (none has a nav item), on the stats line.
  const doors = (
    <nav aria-label="Mission tools" data-testid="missions-doors-mobile" className="flex items-center gap-1 text-meta">
      {planEnabled && <Link href="/app/missions/plan" className={DOOR_CLASS}>Plan ›</Link>}
      <Link href="/app/specs" className={DOOR_CLASS}>Specs</Link>
      <Link href="/app/releases" className={DOOR_CLASS}>Releases</Link>
    </nav>
  );

  return (
    <div className="px-4 sm:px-7 md:px-10 pt-[4.5rem] md:pt-8 pb-10 max-w-[1180px]">
      {/* ?new=1: the New mission sheet (the form when chat is off, see NewWorkLink). */}
      {newParam === '1' && <NewMissionSheet userId={user.id} teamId={activeTeamId} />}
      {/* Phones: the create action rides in the top bar and the doors sit on the
          stats line, so no row of buttons stands between the bar and the list. */}
      <MobileTopBarAction>
        <NewWorkLink
          kind="mission"
          workspaceId={wsFilter ?? null}
          testId="new-mission-link-mobile"
          className={MOBILE_TOP_BAR_ACTION_CLASS}
        >
          + New
        </NewWorkLink>
      </MobileTopBarAction>
      <div data-testid="missions-header" className="flex items-center justify-between gap-3 md:mb-4">
        {/* The mobile header already reads "Missions · Team"; show the h1 from md up only. */}
        <h1 data-testid="missions-headline" className="sr-only md:not-sr-only text-heading font-semibold text-text-primary">
          Missions
        </h1>
        {/* Phones: only the sr-only h1 is left, so this row takes no height. */}
        <div className="ml-auto hidden flex-wrap items-center gap-3 md:flex">
          {/* Releases and specs have no nav item; these are their doors. */}
          {planEnabled && (
            <Link href="/app/missions/plan" data-testid="missions-plan-link" className="btn btn-quiet h-8">
              Plan ›
            </Link>
          )}
          <Link href="/app/specs" data-testid="missions-specs-link" className="btn btn-quiet h-8">
            Specs
          </Link>
          <Link href="/app/releases" data-testid="missions-releases-link" className="btn btn-quiet h-8">
            Releases
          </Link>
          <NewWorkLink
            kind="mission"
            workspaceId={wsFilter ?? null}
            testId="new-mission-link"
            className="btn h-8"
          >
            + New
          </NewWorkLink>
        </div>
      </div>

      {rows.length === 0 && !titleQuery ? (
        <>
          <p className="text-body text-text-secondary">No missions. A mission groups the tasks behind one goal.</p>
          <div className="mt-2 md:hidden">{doors}</div>
        </>
      ) : (
        <MissionGrid
          rows={rows}
          initialGroup={groupParam ?? null}
          doors={doors}
          slots={slots}
          now={now}
          initialQuery={titleQuery}
          moreCompleted={nextCompletedCursor != null && !titleQuery}
          searchBase={listHref({})}
          loadOlderHref={nextCompletedCursor ? listHref({ ...(titleQuery ? { q: titleQuery } : {}), completedCursor: nextCompletedCursor }) : undefined}
        />
      )}
    </div>
  );
}

export default withPageBudget('missionsList', MissionsPage);

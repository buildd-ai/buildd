import { db } from '@buildd/core/db';
import { initiatives } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import * as missionHelpers from '@buildd/core/mission-helpers';
import { redirect, unstable_rethrow } from 'next/navigation';
import { cookies } from 'next/headers';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveActiveTeamId, getTeamWorkspaceIds } from '@/lib/team-access';
import ActivityView from './ActivityView';
import { loadActivity, type ActivityData, type ActivityMissionRow } from './activity-data';
import { listLocalSessions, type LocalSessionView } from '@/lib/local-session-view';
import { localHoldsByWorker } from '@/lib/local-session-display';
import { HOME_MISSION_SUMMARIES } from '@/modules';
import { withPageBudget } from '@/lib/page-budget-watch';

/** Header for open missions with no stored summary yet: derived live now, stored after the response. */
async function deriveHeads(ids: string[]): Promise<Map<string, ActivityMissionRow['head']>> {
  HOME_MISSION_SUMMARIES.refresh(...ids);
  const live = await HOME_MISSION_SUMMARIES.derive(ids, Date.now());
  return new Map(live.map(r => [r.id, { kind: r.home.delivery.kind, landed: r.home.delivery.landed, total: r.home.delivery.total, next: r.home.delivery.next }]));
}

async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ mission?: string; workspace?: string; initiative?: string; view?: string }>;
}) {
  const params = await searchParams;
  const { mission: missionId, workspace: wsFilter, initiative: initiativeId } = params;
  const mode = params.view === 'history' ? 'history' : 'now';

  const isDev = process.env.NODE_ENV === 'development' && (!process.env.DATABASE_URL || !process.env.DEV_USER_EMAIL); // placeholder unless dev has a DB + dev user
  const user = await getCurrentUser();

  if (!isDev && !user) {
    redirect('/app/auth/signin');
  }

  let initiativeTitle: string | null = null;
  let missionTitle: string | null = null;
  let localSessions: LocalSessionView[] = [];
  // Activity owns Now/History. Insights loads its band drill-down separately.
  let activity: ActivityData | null = null;
  // Set when the root cap, not the 30-day window, ended History.
  let historyReach: { oldestAt: string } | null = null;
  // A failed load says so; it never renders as an empty Now and History.
  let loadFailed = false;

  if (!isDev && user) {
    try {
      const cookieStore = await cookies();
      const activeTeamId = await resolveActiveTeamId(user.id, cookieStore.get('buildd-team')?.value);

      if (activeTeamId) {
        const [teamWsIds, init] = await Promise.all([
          getTeamWorkspaceIds(activeTeamId),
          initiativeId
            ? db.select({ title: initiatives.title }).from(initiatives).where(eq(initiatives.id, initiativeId)).limit(1).then(r => r[0] ?? null).catch(() => null)
            : Promise.resolve(null),
        ]);
        initiativeTitle = init?.title || null;

        // Narrow to selected workspace if filter is set (must belong to team)
        const wsIds = (wsFilter && teamWsIds.includes(wsFilter)) ? [wsFilter] : teamWsIds;

        if (wsIds.length > 0) {
          // Presence of local interactive sessions, which only Now shows.
          // Best-effort: the task list never fails because of it.
          const sessionsLoad = mode === 'now'
            ? listLocalSessions({ workspaceIds: wsIds }).catch((err) => {
                console.warn('[tasks] local sessions query failed:', err);
                return [] as LocalSessionView[];
              })
            : Promise.resolve([] as LocalSessionView[]);
          const [sessions, loaded] = await Promise.all([
            sessionsLoad,
            loadActivity({
              scope: { workspaceIds: wsIds, missionId, initiativeId },
              tab: mode,
              localHolds: sessionsLoad.then(localHoldsByWorker),
              now: Date.now(),
              rules: missionHelpers,
              deriveHeads,
              viewerUserId: user.id,
            }),
          ]);
          localSessions = sessions;
          activity = loaded;
          historyReach = loaded.historyReach;
          missionTitle = loaded.missionTitle;
        }
      }
    } catch (error) {
      unstable_rethrow(error);
      console.error('Activity query error:', error);
      loadFailed = true;
    }
  }

  const href = (view: 'now' | 'history') => {
    const q = new URLSearchParams();
    if (missionId) q.set('mission', missionId);
    if (wsFilter) q.set('workspace', wsFilter);
    if (initiativeId) q.set('initiative', initiativeId);
    if (view === 'history') q.set('view', 'history');
    const qs = q.toString();
    return `/app/tasks${qs ? `?${qs}` : ''}`;
  };
  return (
    <ActivityView
      mode={mode}
      now={activity?.now ?? { groups: [], inMotion: 0, liveAgents: 0 }}
      history={activity?.history ?? []}
      nowMs={Date.now()}
      hrefs={{ now: href('now'), history: href('history') }}
      missionFilter={missionId ? { id: missionId, title: missionTitle } : null}
      initiativeTitle={initiativeTitle}
      localSessions={localSessions}
      loadError={loadFailed}
      historyReach={historyReach}
      identityFilters={activity?.identityFilters ?? false}
    />
  );
}

export default withPageBudget('activity', TasksPage);

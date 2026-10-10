import { db } from '@buildd/core/db';
import { tasks, missions, initiatives } from '@buildd/core/db/schema';
import { desc, eq, inArray, and, gte, isNull } from 'drizzle-orm';
import * as missionHelpers from '@buildd/core/mission-helpers';
import { redirect, unstable_rethrow } from 'next/navigation';
import { cookies } from 'next/headers';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveActiveTeamId, getTeamWorkspaceIds } from '@/lib/team-access';
import ActivityView from './ActivityView';
import { loadActivity, type ActivityData } from './activity-data';
import { listLocalSessions, type LocalSessionView } from '@/lib/local-session-view';

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ mission?: string; workspace?: string; initiative?: string; view?: string }>;
}) {
  const params = await searchParams;
  const { mission: missionId, workspace: wsFilter, initiative: initiativeId } = params;

  const isDev = process.env.NODE_ENV === 'development' && (!process.env.DATABASE_URL || !process.env.DEV_USER_EMAIL); // placeholder unless dev has a DB + dev user
  const user = await getCurrentUser();

  if (!isDev && !user) {
    redirect('/app/auth/signin');
  }

  let initiativeTitle: string | null = null;
  let initiativeMissionIds: string[] = [];
  let localSessions: LocalSessionView[] = [];
  // Activity owns Now/History. Insights loads its band drill-down separately.
  let activity: ActivityData | null = null;

  if (!isDev && user) {
    try {
      const cookieStore = await cookies();
      const activeTeamId = await resolveActiveTeamId(user.id, cookieStore.get('buildd-team')?.value);

      if (activeTeamId) {
        // Resolve initiative title early (independent of workspace/task queries)
        if (initiativeId) {
          try {
            const init = await db.query.initiatives.findFirst({
              where: eq(initiatives.id, initiativeId),
              columns: { title: true },
            });
            initiativeTitle = init?.title || null;
          } catch {}
        }

        const teamWsIds = await getTeamWorkspaceIds(activeTeamId);

        // Narrow to selected workspace if filter is set (must belong to team)
        const wsIds = (wsFilter && teamWsIds.includes(wsFilter)) ? [wsFilter] : teamWsIds;

        if (wsIds.length > 0) {
          // Presence of local interactive sessions. Best-effort: the task list
          // never waits on or fails because of it.
          try {
            localSessions = await listLocalSessions({ workspaceIds: wsIds });
          } catch (err) {
            console.warn('[tasks] local sessions query failed:', err);
          }
          // A task a local session is working on names that client, not a runner.
          const localClientByTaskId = new Map(
            localSessions.flatMap(s => s.tasks.filter(t => t.live).map(t => [t.id, `${s.clientLabel} · local`] as const)),
          );
          // Fetch recent root tasks; retry children follow below.
          const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
          const recentTasks = await db.query.tasks.findMany({
            where: and(
              inArray(tasks.workspaceId, wsIds),
              gte(tasks.updatedAt, thirtyDaysAgo),
              isNull(tasks.parentTaskId),
            ),
            columns: {
              id: true,
              title: true,
              status: true,
              mode: true,
              category: true,
              createdAt: true,
              updatedAt: true,
              workspaceId: true,
              result: true,
              missionId: true,
              context: true,
              backend: true,
              dependsOn: true,
              startAt: true,
              loopConfig: true,
              loopIteration: true,
              loopState: true,
              parentTaskId: true,
              taskClass: true,
              // Subject-liveness gate inputs. subjectAnchor carries `source`,
              // which decides whether the anchor gates claims at all — an
              // unselected column reads as undefined and the row would render
              // as a healthy QUEUED task again.
              subjectKind: true,
              subjectPrNumber: true,
              subjectResolution: true,
              subjectAnchor: true,
            },
            orderBy: [desc(tasks.updatedAt)],
            limit: 200,
          });

          // Fetch child tasks (retry/reviewer) for the root tasks we loaded
          const rootIds = recentTasks.map(t => t.id);
          const childTasks = rootIds.length > 0
            ? await db.query.tasks.findMany({
                where: inArray(tasks.parentTaskId, rootIds),
                columns: {
                  id: true,
                  title: true,
                  status: true,
                  mode: true,
                  category: true,
                  createdAt: true,
                  updatedAt: true,
                  workspaceId: true,
                  result: true,
                  missionId: true,
                  context: true,
                  backend: true,
                  dependsOn: true,
                  startAt: true,
                  loopConfig: true,
                  loopIteration: true,
                  loopState: true,
                  parentTaskId: true,
                  taskClass: true,
                  subjectKind: true,
                  subjectPrNumber: true,
                  subjectResolution: true,
                  subjectAnchor: true,
                },
                limit: 500,
              })
            : [];
          const allTasks = [...new Map([...recentTasks, ...childTasks].map(t => [t.id, t])).values()];

          // Fetch mission titles for tasks that have missionId
          const missionIds = [...new Set(allTasks.map(t => t.missionId).filter(Boolean))] as string[];
          const missionTitleMap = new Map<string, string>();
          if (missionIds.length > 0) {
            const misns = await db.query.missions.findMany({
              where: inArray(missions.id, missionIds),
              columns: { id: true, title: true, initiativeId: true },
            });
            for (const m of misns) {
              missionTitleMap.set(m.id, m.title);
              if (initiativeId && m.initiativeId === initiativeId) {
                initiativeMissionIds.push(m.id);
              }
            }
          }

          const inView = allTasks.filter(t => {
            if (missionId) return t.missionId === missionId;
            if (initiativeId) return !!t.missionId && initiativeMissionIds.includes(t.missionId);
            return true;
          });
          activity = await loadActivity({ tasks: inView, missionTitles: missionTitleMap, localClientByTaskId, now: Date.now(), rules: missionHelpers });

        }
      }
    } catch (error) {
      unstable_rethrow(error);
      console.error('Activity query error:', error);
    }
  }

  // Look up mission title if filtered
  let missionTitle: string | null = null;
  if (missionId && user) {
    try {
      const mission = await db.query.missions.findFirst({
        where: eq(missions.id, missionId),
        columns: { title: true },
      });
      missionTitle = mission?.title || null;
    } catch {}
  }

  const mode = params.view === 'history' ? 'history' : 'now';
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
    />
  );
}

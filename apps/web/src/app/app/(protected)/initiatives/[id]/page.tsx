import { db } from '@buildd/core/db';
import { initiatives, missions, artifacts, workspaces, externalLinks } from '@buildd/core/db/schema';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
import { computeMissionProgress, computeInitiativeProgress, type ChildMissionProgress } from '@buildd/core/mission-helpers';
import TrackerProgressPanel from '@/components/TrackerProgressPanel';

export const dynamic = 'force-dynamic';

const ROLLUP_ACCENT: Record<string, string> = {
  blocked: 'bg-status-warning',
  active: 'bg-status-info',
  completed: 'bg-status-success',
  paused: 'bg-text-muted',
  empty: 'bg-text-muted',
};

const MISSION_STATUS_DOT: Record<string, string> = {
  active: 'bg-status-info',
  paused: 'bg-text-muted',
  completed: 'bg-status-success',
  archived: 'bg-text-muted',
  budget_exhausted: 'bg-status-warning',
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
    columns: { id: true, title: true, description: true, status: true, teamId: true, workspaceId: true },
    with: {
      workspace: { columns: { id: true, name: true } },
      missions: {
        columns: { id: true, title: true, status: true, priority: true },
        orderBy: [desc(missions.priority), desc(missions.createdAt)],
        with: { tasks: { columns: { id: true, status: true, kind: true, title: true, mode: true, creationSource: true, category: true } } },
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

  const children: ChildMissionProgress[] = [];
  const missionRows = (initiative.missions || []).map((m: any) => {
    const { totalTasks, completedTasks, progress } = computeMissionProgress(m.tasks || []);
    children.push({ status: m.status as ChildMissionProgress['status'], totalTasks, completedTasks });
    return { id: m.id, title: m.title, status: m.status, progress, totalTasks, completedTasks };
  });
  const rollup = computeInitiativeProgress(children);

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

  return (
    <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8 max-w-5xl">
      {/* Breadcrumbs */}
      <div className="flex items-center gap-2 text-[12px] text-text-muted mb-5">
        <Link href="/app/missions" className="hover:text-text-secondary transition-colors">
          Missions
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
        {initiative.description && (
          <p className="text-sm text-text-secondary mb-3 whitespace-pre-wrap">{initiative.description}</p>
        )}
        <div className="flex items-center gap-3 mb-1.5">
          <span className="text-sm font-medium text-text-primary">{rollup.progress}%</span>
          <span className="text-[12px] text-text-muted capitalize">{rollup.status}</span>
          <span className="text-[12px] text-text-muted">
            {rollup.completedMissions}/{rollup.totalMissions} missions · {rollup.completedTasks}/{rollup.totalTasks} tasks
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden max-w-md">
          <div
            className={`h-full ${ROLLUP_ACCENT[rollup.status] ?? 'bg-text-muted'} transition-all`}
            style={{ width: `${rollup.progress}%` }}
          />
        </div>
      </div>

      {/* Linear Phase 2 — read-back tracking (only when a child mission is linked) */}
      {hasLinearLink && (
        <div className="mb-8">
          <TrackerProgressPanel entityType="initiative" entityId={id} />
        </div>
      )}

      {/* Missions */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
            Missions ({missionRows.length})
          </h2>
          <Link
            href={`/app/missions/new?initiative=${initiative.id}`}
            className="px-2.5 py-1 text-[11px] font-medium bg-primary text-white rounded-sm hover:bg-primary-hover transition-colors"
          >
            + New Mission
          </Link>
        </div>
        {missionRows.length === 0 ? (
          <div className="card p-6 text-center">
            <p className="text-sm text-text-secondary mb-1">No missions under this initiative yet.</p>
            <p className="text-xs text-text-muted">
              Create one and assign it, or link an existing mission from its page.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {missionRows.map((m) => (
              <Link
                key={m.id}
                href={`/app/missions/${m.id}`}
                className="card p-3 hover:border-border-hover transition-colors flex items-center gap-3"
              >
                <span className={`h-2 w-2 rounded-full shrink-0 ${MISSION_STATUS_DOT[m.status] ?? 'bg-text-muted'}`} />
                <span className="text-sm text-text-primary truncate flex-1">{m.title}</span>
                <span className="text-[11px] text-text-muted shrink-0">
                  {m.completedTasks}/{m.totalTasks} · {m.progress}%
                </span>
              </Link>
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

import { db } from '@buildd/core/db';
import { watchedProjects, watcherEvents, workspaces } from '@buildd/core/db/schema';
import { eq, inArray, desc } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds } from '@/lib/team-access';
import { HealthClient } from './HealthClient';

export const dynamic = 'force-dynamic';

export interface WatchedProjectRow {
  id: string;
  workspaceId: string;
  workspaceName: string;
  repo: string;
  enabled: boolean;
  vercelProjectId: string | null;
  inFlightWindowMin: number;
  prodGraceMin: number;
  roleSlug: string;
  pushoverApp: 'tasks' | 'alerts';
  releasePrFilter: { base?: string; label?: string; titlePrefix?: string };
  notes: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  recentEvents: { kind: string; firedAt: string; taskId: string | null }[];
}

export interface WorkspaceOption {
  id: string;
  name: string;
}

export default async function HealthPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/api/auth/signin');

  const workspaceIds = await getUserWorkspaceIds(user.id);
  if (workspaceIds.length === 0) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <h1 className="text-2xl font-bold mb-2">Project Health</h1>
        <p className="text-sm text-text-tertiary">No workspaces yet.</p>
      </div>
    );
  }

  const ws = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(inArray(workspaces.id, workspaceIds));
  const wsById = new Map(ws.map((w) => [w.id, w.name] as const));

  const rows = await db
    .select()
    .from(watchedProjects)
    .where(inArray(watchedProjects.workspaceId, workspaceIds))
    .orderBy(desc(watchedProjects.createdAt));

  const projectIds = rows.map((r) => r.id);
  const events = projectIds.length
    ? await db
        .select()
        .from(watcherEvents)
        .where(inArray(watcherEvents.projectId, projectIds))
        .orderBy(desc(watcherEvents.firedAt))
        .limit(50)
    : [];
  const eventsByProject = new Map<string, { kind: string; firedAt: string; taskId: string | null }[]>();
  for (const e of events) {
    const list = eventsByProject.get(e.projectId) ?? [];
    if (list.length < 5) {
      list.push({ kind: e.kind, firedAt: e.firedAt.toISOString(), taskId: e.taskId });
      eventsByProject.set(e.projectId, list);
    }
  }

  const serialized: WatchedProjectRow[] = rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspaceId,
    workspaceName: wsById.get(r.workspaceId) ?? '(unknown)',
    repo: r.repo,
    enabled: r.enabled,
    vercelProjectId: r.vercelProjectId,
    inFlightWindowMin: r.inFlightWindowMin,
    prodGraceMin: r.prodGraceMin,
    roleSlug: r.roleSlug,
    pushoverApp: r.pushoverApp,
    releasePrFilter: r.releasePrFilter ?? {},
    notes: r.notes,
    lastCheckedAt: r.lastCheckedAt ? r.lastCheckedAt.toISOString() : null,
    lastError: r.lastError,
    recentEvents: eventsByProject.get(r.id) ?? [],
  }));

  const workspaceOptions: WorkspaceOption[] = ws.map((w) => ({ id: w.id, name: w.name }));

  return <HealthClient initialRows={serialized} workspaces={workspaceOptions} />;
}

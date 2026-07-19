import { db } from '@buildd/core/db';
import { workspaceSkills, workers, tasks, accountWorkspaces, workspaces } from '@buildd/core/db/schema';
import { eq, and, or, isNull, inArray, desc, sql } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds, getTeamWorkspaceIds, resolveActiveTeamId } from '@/lib/team-access';
import { LIVE_WORKER_STATUSES } from '@/lib/task-timestamps';
import { TeamGrid } from './TeamGrid';

export const dynamic = 'force-dynamic';

function timeAgo(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export interface RoleWithActivity {
  id: string;
  teamId: string;
  workspaceId: string | null;
  /** "All workspaces" for team-defaults, workspace name for workspace-scoped overrides */
  scopeLabel: string;
  /** Count of workspace-override rows for this slug (only on team-default entries) */
  overrideCount: number;
  /** Workspace overrides for this slug (only populated on team-default entries) */
  overrides: { id: string; workspaceId: string; scopeLabel: string }[];
  slug: string;
  name: string;
  description: string | null;
  color: string;
  model: string;
  allowedTools: string[];
  canDelegateTo: string[];
  enabled: boolean;
  isRole: boolean;
  // Usage stats (last 30 days)
  stats: { completed: number; failed: number; total: number } | null;
  // Current activity
  currentTask: {
    id: string;
    title: string;
    workspaceName: string;
    workerStatus: string;
    startedAt: string;
    prUrl?: string;
    missionTitle?: string;
  } | null;
  /** Count of workers currently active for this role (0 = idle) */
  activeWorkerCount: number;
}

export default async function TeamPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  // Namespace this view to the active team (buildd-team cookie), matching the
  // missions list. Without a resolvable team, fall back to all user workspaces.
  const cookieStore = await cookies();
  const activeTeamId = await resolveActiveTeamId(user.id, cookieStore.get('buildd-team')?.value);
  const teamIds = activeTeamId ? [activeTeamId] : [];
  const wsIds = activeTeamId
    ? await getTeamWorkspaceIds(activeTeamId)
    : await getUserWorkspaceIds(user.id);
  if (wsIds.length === 0) {
    return (
      <main className="min-h-screen p-8">
        <div className="max-w-5xl mx-auto">
          <h1 className="text-3xl font-bold mb-2">The Team</h1>
          <p className="text-text-secondary">No workspaces found. Create a workspace first.</p>
        </div>
      </main>
    );
  }

  // Get user's account IDs for account-level roles
  const userAccountWs = await db.query.accountWorkspaces.findMany({
    where: inArray(accountWorkspaces.workspaceId, wsIds),
    columns: { accountId: true },
  });
  const accountIds = [...new Set(userAccountWs.map(aw => aw.accountId))];

  // Get workspace name map for scope labels
  const workspaceList = await db.query.workspaces.findMany({
    where: inArray(workspaces.id, wsIds),
    columns: { id: true, name: true },
  });
  const wsNameMap = new Map(workspaceList.map(w => [w.id, w.name]));

  // Get ALL role rows (both team-defaults AND workspace overrides) — no dedup
  const allSkillsRaw = await db.query.workspaceSkills.findMany({
    where: and(
      eq(workspaceSkills.enabled, true),
      eq(workspaceSkills.isRole, true),
      or(
        wsIds.length > 0 ? inArray(workspaceSkills.workspaceId, wsIds) : undefined,
        teamIds.length > 0 ? and(isNull(workspaceSkills.workspaceId), inArray(workspaceSkills.teamId, teamIds)) : undefined,
        accountIds.length > 0 ? inArray(workspaceSkills.accountId, accountIds) : undefined,
      ),
    ),
    orderBy: [desc(workspaceSkills.createdAt)],
  });

  // Get historical task counts per role (last 30 days)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recentTasks = await db.query.tasks.findMany({
    where: and(
      inArray(tasks.workspaceId, wsIds),
      sql`${tasks.roleSlug} IS NOT NULL`,
      sql`${tasks.createdAt} >= ${thirtyDaysAgo}`,
    ),
    columns: { roleSlug: true, status: true },
  });
  const roleStats: Record<string, { completed: number; failed: number; total: number }> = {};
  for (const t of recentTasks) {
    const slug = t.roleSlug!;
    if (!roleStats[slug]) roleStats[slug] = { completed: 0, failed: 0, total: 0 };
    roleStats[slug].total++;
    if (t.status === 'completed') roleStats[slug].completed++;
    if (t.status === 'failed') roleStats[slug].failed++;
  }

  // Get active workers with their tasks
  const activeWorkers = await db.query.workers.findMany({
    where: and(
      inArray(workers.workspaceId, wsIds),
      inArray(workers.status, [...LIVE_WORKER_STATUSES]),
    ),
    with: {
      task: {
        columns: { id: true, title: true, workspaceId: true, roleSlug: true, context: true },
        with: {
          workspace: { columns: { name: true } },
          mission: { columns: { title: true } },
        },
      },
    },
  });

  // Map workers to roles by roleSlug or context.skillSlugs.
  // Track count per role so multiple concurrent workers are represented.
  // Workers whose tasks have neither roleSlug nor skillSlugs are unattributed
  // but still count toward totalActiveWorkerCount so the header stays honest.
  const roleActivity: Record<string, {
    count: number;
    task: {
      id: string;
      title: string;
      workspaceName: string;
      workerStatus: string;
      startedAt: string;
      prUrl?: string;
      missionTitle?: string;
    };
  }> = {};

  for (const w of activeWorkers) {
    const task = w.task as any;
    if (!task) continue;
    const roleSlug = task.roleSlug as string | null;
    const skillSlugs = (task.context as any)?.skillSlugs as string[] | undefined;
    const slugs = roleSlug ? [roleSlug] : (skillSlugs || []);
    for (const slug of slugs) {
      if (!roleActivity[slug]) {
        roleActivity[slug] = {
          count: 0,
          task: {
            id: task.id,
            title: task.title,
            workspaceName: task.workspace?.name || 'Unknown',
            workerStatus: w.status,
            startedAt: w.startedAt ? timeAgo(w.startedAt) : '',
            prUrl: (w as any).prUrl || undefined,
            missionTitle: task.mission?.title || undefined,
          },
        };
      }
      roleActivity[slug].count++;
    }
  }

  // Total active workers in scope — used by the header so it matches Activity
  // tab semantics (which counts workers regardless of role attribution).
  const totalActiveWorkerCount = activeWorkers.length;

  // Separate team defaults and workspace overrides
  const teamDefaults = allSkillsRaw.filter(s => s.workspaceId === null);
  const wsOverrides = allSkillsRaw.filter(s => s.workspaceId !== null);

  // Build override count map: slug → list of overrides
  const overridesBySlug = new Map<string, { id: string; workspaceId: string; scopeLabel: string }[]>();
  for (const o of wsOverrides) {
    const label = o.workspaceId ? (wsNameMap.get(o.workspaceId) || o.workspaceId) : o.workspaceId!;
    if (!overridesBySlug.has(o.slug)) overridesBySlug.set(o.slug, []);
    overridesBySlug.get(o.slug)!.push({ id: o.id, workspaceId: o.workspaceId!, scopeLabel: label });
  }

  // Build deduplicated role list for display:
  // - Team defaults shown first with override counts
  // - Workspace-specific roles that have no team default shown separately
  const seenSlugsWithDefault = new Set(teamDefaults.map(d => d.slug));

  const teamDefaultRoles: RoleWithActivity[] = teamDefaults.map(skill => {
    const overrides = overridesBySlug.get(skill.slug) || [];
    const activity = roleActivity[skill.slug];
    return {
      id: skill.id,
      teamId: skill.teamId,
      workspaceId: skill.workspaceId,
      scopeLabel: 'All workspaces',
      overrideCount: overrides.length,
      overrides,
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      color: skill.color,
      model: skill.model,
      allowedTools: skill.allowedTools as string[],
      canDelegateTo: skill.canDelegateTo as string[],
      enabled: skill.enabled,
      isRole: skill.isRole,
      stats: roleStats[skill.slug] || null,
      currentTask: activity?.task || null,
      activeWorkerCount: activity?.count || 0,
    };
  });

  // Workspace-scoped roles that have no team-level default (legacy or standalone overrides)
  const wsOnlyRoles: RoleWithActivity[] = wsOverrides
    .filter(s => !seenSlugsWithDefault.has(s.slug))
    .reduce((acc, skill) => {
      // Dedup by slug (workspace override wins, same as before)
      if (!acc.find(r => r.slug === skill.slug)) {
        const activity = roleActivity[skill.slug];
        acc.push({
          id: skill.id,
          teamId: skill.teamId,
          workspaceId: skill.workspaceId,
          scopeLabel: skill.workspaceId ? (wsNameMap.get(skill.workspaceId) || skill.workspaceId) : 'Unknown',
          overrideCount: 0,
          overrides: [],
          slug: skill.slug,
          name: skill.name,
          description: skill.description,
          color: skill.color,
          model: skill.model,
          allowedTools: skill.allowedTools as string[],
          canDelegateTo: skill.canDelegateTo as string[],
          enabled: skill.enabled,
          isRole: skill.isRole,
          stats: roleStats[skill.slug] || null,
          currentTask: activity?.task || null,
          activeWorkerCount: activity?.count || 0,
        });
      }
      return acc;
    }, [] as RoleWithActivity[]);

  const allRoles = [...teamDefaultRoles, ...wsOnlyRoles];
  const activeRoles = allRoles.filter(r => r.currentTask);
  const idleRoles = allRoles.filter(r => !r.currentTask);

  return (
    <main className="min-h-screen pt-14 px-4 pb-20 md:pt-8 md:px-8 md:pb-8">
      <div className="max-w-5xl mx-auto">
        <TeamGrid
          activeRoles={JSON.parse(JSON.stringify(activeRoles))}
          idleRoles={JSON.parse(JSON.stringify(idleRoles))}
          workspaceIds={wsIds}
          teamId={teamIds[0] || null}
          totalActiveWorkerCount={totalActiveWorkerCount}
        />
      </div>
    </main>
  );
}

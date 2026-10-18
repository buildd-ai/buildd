import { db } from '@buildd/core/db';
import { workspaceSkills, workers, tasks, accountWorkspaces, workspaces, users, missions } from '@buildd/core/db/schema';
import { eq, and, or, isNull, isNotNull, inArray, desc, sql } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import SettingsPage from '../_components/SettingsPage';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds, getTeamWorkspaceIds, resolveActiveTeamId } from '@/lib/team-access';
import { LIVE_WORKER_STATUSES } from '@/lib/task-presentation';
import { can } from '@/lib/permissions';
import { TeamGrid } from './TeamGrid';
import { TurnedOffRoles, type TurnedOffRole } from './TurnedOffRoles';
import { splitTeamLevelRows, type RoleVisibility } from '@/lib/personal-roles-shared';
import { readRound } from '@/lib/read-round';

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

/** A personal role the viewer can see: their own (any visibility) or a teammate's shared one. */
export interface PersonalRoleEntry {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  color: string;
  model: string;
  visibility: RoleVisibility;
  /** The viewer owns it. */
  isMine: boolean;
  /** Owner's display name; null when unset. Only shown for teammates' roles. */
  ownerName: string | null;
}

const ROLES_DESCRIPTION = 'The model, tools and instructions each agent uses.';

export default async function RolesPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  // Namespace this view to the active team (buildd-team cookie), matching the
  // missions list. Without a resolvable team, fall back to all user workspaces.
  const cookieStore = await cookies();
  const activeTeamId = await resolveActiveTeamId(user.id, cookieStore.get('buildd-team')?.value);
  const teamIds = activeTeamId ? [activeTeamId] : [];
  // What "New role" offers in the active team.
  const caller = { kind: 'user' as const, userId: user.id };
  const [canCreatePersonalRole, canCreateTeamRole] = activeTeamId
    ? await Promise.all([
        can(caller, 'create_personal_roles', activeTeamId).catch(() => false),
        can(caller, 'manage_agent_roles', activeTeamId).catch(() => false),
      ])
    : [false, false];
  const wsIds = activeTeamId
    ? await getTeamWorkspaceIds(activeTeamId)
    : await getUserWorkspaceIds(user.id);
  if (wsIds.length === 0) {
    return (
      <SettingsPage title="Agents" description={ROLES_DESCRIPTION}>
        <p className="text-sm text-text-muted">No workspaces.</p>
      </SettingsPage>
    );
  }

  // One round trip for every read that needs only the workspace ids
  // (readRound), then the role rows (which need the account ids) and the
  // owners of shared personal roles. Only the shown columns: never a role's
  // SKILL.md content or a task's whole context.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const round = await readRound({
    // Account ids linked here, for account-level roles.
    userAccountWs: db.select({ accountId: accountWorkspaces.accountId }).from(accountWorkspaces)
      .where(inArray(accountWorkspaces.workspaceId, wsIds)),
    // Workspace names for scope labels.
    workspaceList: db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(inArray(workspaces.id, wsIds)),
    // Turned-off roles in the same scope (plus the viewer's own personal ones):
    // listed quietly so they stay findable and can be turned back on.
    turnedOffRows: db.select({ id: workspaceSkills.id, slug: workspaceSkills.slug, name: workspaceSkills.name, workspaceId: workspaceSkills.workspaceId })
      .from(workspaceSkills)
      .where(and(
        eq(workspaceSkills.enabled, false),
        eq(workspaceSkills.isRole, true),
        or(
          inArray(workspaceSkills.workspaceId, wsIds),
          teamIds.length > 0 ? and(isNull(workspaceSkills.workspaceId), inArray(workspaceSkills.teamId, teamIds), or(isNull(workspaceSkills.ownerUserId), eq(workspaceSkills.ownerUserId, user.id))) : undefined,
        ),
      ))
      .orderBy(desc(workspaceSkills.createdAt)),
    // Personal roles in the active team: the viewer's own and teammates' shared ones.
    personalRows: teamIds.length === 0 ? null : db.select({
      id: workspaceSkills.id, slug: workspaceSkills.slug, name: workspaceSkills.name, description: workspaceSkills.description,
      color: workspaceSkills.color, model: workspaceSkills.model, ownerUserId: workspaceSkills.ownerUserId, visibility: workspaceSkills.visibility,
    }).from(workspaceSkills)
      .where(and(
        inArray(workspaceSkills.teamId, teamIds),
        isNull(workspaceSkills.workspaceId),
        isNotNull(workspaceSkills.ownerUserId),
        eq(workspaceSkills.isRole, true),
        eq(workspaceSkills.enabled, true),
        or(eq(workspaceSkills.ownerUserId, user.id), eq(workspaceSkills.visibility, 'team')),
      ))
      .orderBy(desc(workspaceSkills.createdAt)),
    // Task counts per role over the last 30 days, counted in SQL. Attempt
    // tasks (parentTaskId set) are left out so CI retries don't inflate them.
    roleStatRows: db.select({
      roleSlug: tasks.roleSlug,
      total: sql<number>`count(*)::int`,
      completed: sql<number>`count(*) filter (where ${tasks.status} = 'completed')::int`,
      failed: sql<number>`count(*) filter (where ${tasks.status} = 'failed')::int`,
    }).from(tasks)
      .where(and(
        inArray(tasks.workspaceId, wsIds),
        sql`${tasks.roleSlug} IS NOT NULL`,
        sql`${tasks.createdAt} >= ${thirtyDaysAgo}`,
        isNull(tasks.parentTaskId),
      ))
      .groupBy(tasks.roleSlug),
    // Live workers with their task: of the context, only its skill slugs.
    activeWorkers: db.select({
      id: workers.id, status: workers.status, startedAt: workers.startedAt, prUrl: workers.prUrl,
      taskId: tasks.id, taskTitle: tasks.title, roleSlug: tasks.roleSlug,
      skillSlugs: sql<string[] | null>`${tasks.context}->'skillSlugs'`,
      workspaceName: workspaces.name, missionTitle: missions.title,
    }).from(workers)
      .leftJoin(tasks, eq(tasks.id, workers.taskId))
      .leftJoin(workspaces, eq(workspaces.id, tasks.workspaceId))
      .leftJoin(missions, eq(missions.id, tasks.missionId))
      .where(and(
        inArray(workers.workspaceId, wsIds),
        inArray(workers.status, [...LIVE_WORKER_STATUSES]),
      )),
  });
  const accountIds = [...new Set(round.userAccountWs.map(aw => aw.accountId))];
  const wsNameMap = new Map(round.workspaceList.map(w => [w.id, w.name]));

  // ALL role rows (both team-defaults AND workspace overrides) — no dedup.
  const allSkillsRaw = await db.select({
    id: workspaceSkills.id, teamId: workspaceSkills.teamId, workspaceId: workspaceSkills.workspaceId, slug: workspaceSkills.slug,
    name: workspaceSkills.name, description: workspaceSkills.description, color: workspaceSkills.color, model: workspaceSkills.model,
    allowedTools: workspaceSkills.allowedTools, canDelegateTo: workspaceSkills.canDelegateTo, enabled: workspaceSkills.enabled, isRole: workspaceSkills.isRole,
  }).from(workspaceSkills)
    .where(and(
      eq(workspaceSkills.enabled, true),
      eq(workspaceSkills.isRole, true),
      or(
        wsIds.length > 0 ? inArray(workspaceSkills.workspaceId, wsIds) : undefined,
        // Team roles only: personal rows are team-level too, and are listed
        // separately below so another member's private role never shows.
        teamIds.length > 0 ? and(isNull(workspaceSkills.workspaceId), isNull(workspaceSkills.ownerUserId), inArray(workspaceSkills.teamId, teamIds)) : undefined,
        accountIds.length > 0 ? inArray(workspaceSkills.accountId, accountIds) : undefined,
      ),
    ))
    .orderBy(desc(workspaceSkills.createdAt));

  const turnedOff: TurnedOffRole[] = round.turnedOffRows.map(r => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    scopeLabel: r.workspaceId ? (wsNameMap.get(r.workspaceId) ?? 'Workspace') : 'Team',
  }));

  const personalRows = round.personalRows ?? [];
  const { mine, sharedByOthers } = splitTeamLevelRows(personalRows, user.id);
  const otherOwnerIds = [...new Set(sharedByOthers.map(r => r.ownerUserId!))];
  const owners = otherOwnerIds.length === 0 ? [] : await db.select({ id: users.id, name: users.name, email: users.email })
    .from(users).where(inArray(users.id, otherOwnerIds));
  const ownerNames = new Map(owners.map(o => [o.id, o.name || o.email?.split('@')[0] || null]));
  const personalRoles: PersonalRoleEntry[] = [...mine, ...sharedByOthers].map(r => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    color: r.color,
    model: r.model,
    visibility: r.visibility === 'team' ? 'team' : 'private',
    isMine: r.ownerUserId === user.id,
    ownerName: r.ownerUserId === user.id ? null : ownerNames.get(r.ownerUserId!) ?? null,
  }));

  const roleStats: Record<string, { completed: number; failed: number; total: number }> = {};
  for (const r of round.roleStatRows) {
    roleStats[r.roleSlug!] = { completed: Number(r.completed), failed: Number(r.failed), total: Number(r.total) };
  }

  // The worker rows in the shape the role activity below reads.
  const activeWorkers = round.activeWorkers.map(w => ({
    status: w.status, startedAt: w.startedAt, prUrl: w.prUrl,
    task: w.taskId ? {
      id: w.taskId, title: w.taskTitle, roleSlug: w.roleSlug, context: { skillSlugs: w.skillSlugs ?? undefined },
      workspace: w.workspaceName != null ? { name: w.workspaceName } : null,
      mission: w.missionTitle != null ? { title: w.missionTitle } : null,
    } : null,
  }));

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
    <SettingsPage title="Agents" description={ROLES_DESCRIPTION} readOnly={!canCreateTeamRole}>
      <TeamGrid
        activeRoles={JSON.parse(JSON.stringify(activeRoles))}
        idleRoles={JSON.parse(JSON.stringify(idleRoles))}
        workspaceIds={wsIds}
        teamId={teamIds[0] || null}
        totalActiveWorkerCount={totalActiveWorkerCount}
        personalRoles={personalRoles}
        canCreatePersonalRole={canCreatePersonalRole}
        canCreateTeamRole={canCreateTeamRole}
      />
      <TurnedOffRoles roles={turnedOff} />
    </SettingsPage>
  );
}

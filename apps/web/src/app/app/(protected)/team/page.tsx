import { db } from '@buildd/core/db';
import { workspaceSkills, workers, tasks, accountWorkspaces } from '@buildd/core/db/schema';
import { eq, and, or, inArray, desc } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds } from '@/lib/team-access';
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
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  color: string;
  model: string;
  allowedTools: string[];
  canDelegateTo: string[];
  enabled: boolean;
  isRole: boolean;
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
}

export default async function TeamPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const wsIds = await getUserWorkspaceIds(user.id);
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

  // Get all enabled roles: workspace-scoped OR account-level, dedupe by slug
  const allSkillsRaw = await db.query.workspaceSkills.findMany({
    where: and(
      eq(workspaceSkills.enabled, true),
      eq(workspaceSkills.isRole, true),
      or(
        inArray(workspaceSkills.workspaceId, wsIds),
        accountIds.length > 0 ? inArray(workspaceSkills.accountId, accountIds) : undefined,
      ),
    ),
    orderBy: [desc(workspaceSkills.createdAt)],
  });
  const seenSlugs = new Set<string>();
  const allSkills = allSkillsRaw.filter(s => {
    if (seenSlugs.has(s.slug)) return false;
    seenSlugs.add(s.slug);
    return true;
  });

  // Get active workers with their tasks
  const activeWorkers = await db.query.workers.findMany({
    where: and(
      inArray(workers.workspaceId, wsIds),
      inArray(workers.status, ['running', 'starting', 'waiting_input']),
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

  // Map workers to roles by roleSlug or context.skillSlugs
  const roleActivity: Record<string, {
    id: string;
    title: string;
    workspaceName: string;
    workerStatus: string;
    startedAt: string;
    prUrl?: string;
    missionTitle?: string;
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
          id: task.id,
          title: task.title,
          workspaceName: task.workspace?.name || 'Unknown',
          workerStatus: w.status,
          startedAt: w.startedAt ? timeAgo(w.startedAt) : '',
          prUrl: (w as any).prUrl || undefined,
          missionTitle: task.mission?.title || undefined,
        };
      }
    }
  }

  // Build role list with activity
  const roles: RoleWithActivity[] = allSkills.map(skill => ({
    id: skill.id,
    workspaceId: skill.workspaceId,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    color: skill.color,
    model: skill.model,
    allowedTools: skill.allowedTools as string[],
    canDelegateTo: skill.canDelegateTo as string[],
    enabled: skill.enabled,
    isRole: skill.isRole,
    currentTask: roleActivity[skill.slug] || null,
  }));

  const activeRoles = roles.filter(r => r.currentTask);
  const idleRoles = roles.filter(r => !r.currentTask);

  return (
    <main className="min-h-screen pt-4 px-4 pb-20 md:pt-8 md:px-8 md:pb-8">
      <div className="max-w-5xl mx-auto">
        <TeamGrid
          activeRoles={JSON.parse(JSON.stringify(activeRoles))}
          idleRoles={JSON.parse(JSON.stringify(idleRoles))}
          workspaceIds={wsIds}
        />
      </div>
    </main>
  );
}

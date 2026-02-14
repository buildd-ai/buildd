import { db } from '@buildd/core/db';
import { workspaces, tasks, workers, githubInstallations, accounts, workerHeartbeats } from '@buildd/core/db/schema';
import { desc, inArray, eq, and, sql, gt } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { isGitHubAppConfigured } from '@/lib/github';
import { getCurrentUser } from '@/lib/auth-helpers';
import StatusBadge from '@/components/StatusBadge';
import MobileWorkerCard from '@/components/MobileWorkerCard';
import { getUserWorkspaceIds, getUserTeamIds } from '@/lib/team-access';

const HEARTBEAT_STALE_MS = 10 * 60 * 1000; // 10 minutes

export default async function DashboardPage() {
  const user = await getCurrentUser();

  // In dev mode, show empty state
  const isDev = process.env.NODE_ENV === 'development';

  let userWorkspaces: (typeof workspaces.$inferSelect & { team?: { name: string } | null })[] = [];
  let recentTasks: (typeof tasks.$inferSelect & { workspace: typeof workspaces.$inferSelect & { team?: { name: string } | null } })[] = [];
  let activeWorkers: (typeof workers.$inferSelect & { task: typeof tasks.$inferSelect })[] = [];
  let githubOrgs: { accountLogin: string; repoCount: number }[] = [];
  let githubConfigured = false;
  let totalTaskCount = 0;
  let connectedAgents: { localUiUrl: string; accountName: string; activeWorkers: number; maxConcurrent: number; lastHeartbeat: Date }[] = [];

  if (!isDev) {
    if (!user) {
      redirect('/app/auth/signin');
    }

    try {
      githubConfigured = isGitHubAppConfigured();

      // Get user's workspaces (via team membership)
      const wsIds = await getUserWorkspaceIds(user.id);
      userWorkspaces = wsIds.length > 0
        ? await db.query.workspaces.findMany({
            where: inArray(workspaces.id, wsIds),
            orderBy: desc(workspaces.createdAt),
            limit: 10,
            with: {
              team: { columns: { name: true } },
            },
          })
        : [];

      const workspaceIds = userWorkspaces.map(w => w.id);

      if (workspaceIds.length > 0) {
        // Get total task count for stat card
        const countResult = await db.select({ count: sql<number>`count(*)::int` }).from(tasks).where(inArray(tasks.workspaceId, workspaceIds));
        totalTaskCount = countResult[0]?.count || 0;

        // Get active tasks first (running, assigned, pending, failed) - sorted by status priority
        const activeTasks = await db.query.tasks.findMany({
          where: and(
            inArray(tasks.workspaceId, workspaceIds),
            inArray(tasks.status, ['running', 'assigned', 'pending', 'failed'])
          ),
          orderBy: desc(tasks.updatedAt),
          limit: 10,
          with: { workspace: { with: { team: { columns: { name: true } } } } },
        }) as any;

        // Sort by status priority: running/assigned first, then pending, then failed
        const getStatusPriority = (status: string) => {
          switch (status) {
            case 'running':
            case 'assigned':
              return 0;
            case 'pending':
              return 1;
            case 'failed':
              return 2;
            default:
              return 3;
          }
        };
        activeTasks.sort((a: any, b: any) => {
          const priorityDiff = getStatusPriority(a.status) - getStatusPriority(b.status);
          if (priorityDiff !== 0) return priorityDiff;
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        });

        // Backfill with completed if room (max 3 total shown on dashboard)
        const maxDisplay = 3;
        const remaining = Math.max(0, maxDisplay - activeTasks.length);
        const completedTasks = remaining > 0 ? await db.query.tasks.findMany({
          where: and(
            inArray(tasks.workspaceId, workspaceIds),
            eq(tasks.status, 'completed')
          ),
          orderBy: desc(tasks.updatedAt),
          limit: remaining,
          with: { workspace: { with: { team: { columns: { name: true } } } } },
        }) as any : [];

        recentTasks = [...activeTasks.slice(0, maxDisplay), ...completedTasks];

        // Get active workers (from user's workspaces)
        activeWorkers = await db.query.workers.findMany({
          where: and(
            inArray(workers.workspaceId, workspaceIds),
            inArray(workers.status, ['running', 'starting', 'waiting_input'])
          ),
          orderBy: desc(workers.createdAt),
          limit: 10,
          with: { task: true },
        }) as any;
      }

      // Get connected agents via heartbeats
      const teamIds = await getUserTeamIds(user.id);
      const userAccounts = teamIds.length > 0
        ? await db.query.accounts.findMany({
            where: inArray(accounts.teamId, teamIds),
            columns: { id: true, name: true },
          })
        : [];
      if (userAccounts.length > 0) {
        const cutoff = new Date(Date.now() - HEARTBEAT_STALE_MS);
        const heartbeats = await db.query.workerHeartbeats.findMany({
          where: and(
            inArray(workerHeartbeats.accountId, userAccounts.map(a => a.id)),
            gt(workerHeartbeats.lastHeartbeatAt, cutoff),
          ),
          limit: 20,
        });
        const accountNameMap = new Map(userAccounts.map(a => [a.id, a.name]));
        connectedAgents = heartbeats.map(hb => ({
          localUiUrl: hb.localUiUrl,
          accountName: accountNameMap.get(hb.accountId) || 'Unknown',
          activeWorkers: hb.activeWorkerCount,
          maxConcurrent: hb.maxConcurrentWorkers,
          lastHeartbeat: hb.lastHeartbeatAt,
        }));
      }

      // Get GitHub installations
      if (githubConfigured) {
        const installations = await db.query.githubInstallations.findMany({
          with: { repos: true },
        });
        githubOrgs = installations.map(i => ({
          accountLogin: i.accountLogin,
          repoCount: i.repos?.length || 0,
        }));
      }
    } catch (error) {
      console.error('Dashboard query error:', error);
    }
  }

  // --- Helpers ---

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

  const TASK_ICONS: Record<string, { icon: string; bg: string; text: string }> = {
    completed:              { icon: '\u2713', bg: 'bg-status-success/12', text: 'text-status-success' },
    running:                { icon: '\u27F3', bg: 'bg-status-running/12', text: 'text-status-running' },
    assigned:               { icon: '\u27F3', bg: 'bg-status-info/12',    text: 'text-status-info' },
    starting:               { icon: '\u27F3', bg: 'bg-status-running/12', text: 'text-status-running' },
    pending:                { icon: '\u25CB', bg: 'bg-status-warning/12', text: 'text-status-warning' },
    failed:                 { icon: '\u2715', bg: 'bg-status-error/12',   text: 'text-status-error' },
    waiting_input:          { icon: '!',      bg: 'bg-status-warning/12', text: 'text-status-warning' },
    awaiting_plan_approval: { icon: '!',      bg: 'bg-status-warning/12', text: 'text-status-warning' },
  };
  const DEFAULT_ICON = TASK_ICONS.pending;

  return (
    <main className="min-h-screen p-4 md:p-8">
      <div className="max-w-6xl mx-auto">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-8">
          <div>
            <h1 className="text-[28px] font-semibold tracking-tight text-text-primary">buildd</h1>
            <p className="text-[14px] text-text-secondary">
              {user?.email || 'Development Mode'}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {githubConfigured && (
              githubOrgs.length > 0 ? (
                <Link
                  href="/app/settings"
                  className="flex items-center gap-2 px-3 py-[5px] text-xs bg-status-success/10 border border-status-success/20 rounded-[6px] hover:bg-status-success/15"
                >
                  <svg className="w-4 h-4 text-status-success" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                  </svg>
                  <span className="text-status-success">
                    {githubOrgs.length === 1 ? githubOrgs[0].accountLogin : `${githubOrgs.length} orgs`}
                  </span>
                </Link>
              ) : (
                <a
                  href="/api/github/install"
                  className="flex items-center gap-2 px-3 py-[5px] text-xs border border-dashed border-border-default rounded-[6px] hover:border-primary hover:bg-primary/5"
                >
                  <svg className="w-4 h-4 text-text-secondary" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                  </svg>
                  <span className="text-primary">Connect GitHub</span>
                </a>
              )
            )}
            <Link
              href="/app/settings"
              className="p-1.5 rounded-[6px] hover:bg-surface-3 text-text-secondary hover:text-text-primary"
              title="Settings"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </Link>
            <Link
              href="/api/auth/signout"
              className="px-3 py-[5px] text-xs text-text-secondary hover:text-text-primary"
            >
              Sign Out
            </Link>
          </div>
        </div>

        {/* Setup Banner */}
        {githubConfigured && githubOrgs.length === 0 && (
          <div className="mb-6 p-4 bg-status-info/10 border border-status-info/20 rounded-[10px]">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-status-info/15 rounded-lg">
                  <svg className="w-5 h-5 text-status-info" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                  </svg>
                </div>
                <div>
                  <h3 className="font-medium text-text-primary">Connect GitHub to get started</h3>
                  <p className="text-sm text-text-secondary">Link your GitHub org to auto-discover repos for workspaces</p>
                </div>
              </div>
              <a
                href="/api/github/install"
                className="px-[18px] py-[9px] bg-primary hover:bg-primary-hover text-white rounded-[6px] text-[13px] font-medium whitespace-nowrap"
              >
                Connect GitHub
              </a>
            </div>
          </div>
        )}

        {/* Stat Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
          <Link
            href="/app/workspaces"
            className="bg-surface-2 border border-border-default rounded-[10px] p-4 hover:border-text-muted transition-colors"
          >
            <div className="font-mono text-[10px] uppercase tracking-[1.5px] text-text-muted mb-1.5">Workspaces</div>
            <div className="text-2xl font-semibold">{userWorkspaces.length}</div>
          </Link>
          <Link
            href="/app/tasks"
            className="bg-surface-2 border border-border-default rounded-[10px] p-4 hover:border-text-muted transition-colors"
          >
            <div className="font-mono text-[10px] uppercase tracking-[1.5px] text-text-muted mb-1.5">Tasks</div>
            <div className="text-2xl font-semibold">{totalTaskCount}</div>
          </Link>
          <Link
            href="/app/workers"
            className="bg-surface-2 border border-border-default rounded-[10px] p-4 hover:border-text-muted transition-colors"
          >
            <div className="font-mono text-[10px] uppercase tracking-[1.5px] text-text-muted mb-1.5">Active</div>
            <div className="text-2xl font-semibold">{activeWorkers.length}</div>
          </Link>
          <div className="bg-surface-2 border border-border-default rounded-[10px] p-4">
            <div className="font-mono text-[10px] uppercase tracking-[1.5px] text-text-muted mb-1.5">Connected</div>
            <div className={`text-2xl font-semibold ${connectedAgents.length > 0 ? 'text-status-success' : ''}`}>
              {connectedAgents.length}
            </div>
          </div>
        </div>

        {/* Active Workers */}
        {activeWorkers.length > 0 && (
          <div className="mb-8">
            <div className="font-mono text-[10px] uppercase tracking-[2.5px] text-text-muted pb-2 border-b border-border-default mb-6">
              Active Workers
            </div>

            {/* Mobile: MobileWorkerCard */}
            <div className="md:hidden space-y-3">
              {activeWorkers.map((worker) => (
                <MobileWorkerCard
                  key={worker.id}
                  workerId={worker.id}
                  name={worker.name}
                  status={worker.status}
                  taskTitle={worker.task?.title || null}
                  workspaceName={null}
                  milestones={(worker.milestones as any[]) || []}
                  turns={worker.turns}
                  costUsd={worker.costUsd?.toString() || null}
                  startedAt={worker.startedAt?.toISOString() || null}
                  taskId={worker.task?.id || ''}
                />
              ))}
            </div>

            {/* Desktop: task-item rows */}
            <div className="hidden md:block border border-border-default rounded-[10px] overflow-hidden">
              {activeWorkers.map((worker) => {
                const iconStyle = TASK_ICONS[worker.status] || DEFAULT_ICON;
                return (
                  <div
                    key={worker.id}
                    className="flex items-center gap-4 px-4 py-3.5 border-b border-border-default/40 last:border-b-0 hover:bg-surface-3"
                  >
                    <div className={`w-7 h-7 rounded-[6px] flex items-center justify-center text-[13px] flex-shrink-0 ${iconStyle.bg} ${iconStyle.text}`}>
                      {iconStyle.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-text-primary truncate">{worker.name}</div>
                      <div className="font-mono text-[11px] text-text-muted truncate">{worker.task?.title}</div>
                    </div>
                    <StatusBadge status={worker.status} />
                    {/* Milestone progress */}
                    {worker.milestones && (worker.milestones as any[]).length > 0 && (
                      <div className="hidden lg:flex items-center gap-0.5">
                        {Array.from({ length: Math.min((worker.milestones as any[]).length, 10) }).map((_, i) => (
                          <div key={i} className="w-5 h-1.5 bg-primary-400 rounded-sm" />
                        ))}
                        {Array.from({ length: Math.max(0, 10 - (worker.milestones as any[]).length) }).map((_, i) => (
                          <div key={i} className="w-5 h-1.5 bg-surface-3 rounded-sm" />
                        ))}
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      {worker.prUrl && (
                        <a
                          href={worker.prUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-3 py-[5px] text-xs bg-status-success/10 text-status-success rounded-[6px] hover:bg-status-success/20"
                        >
                          PR #{worker.prNumber}
                        </a>
                      )}
                      {worker.localUiUrl && (
                        <a
                          href={`${worker.localUiUrl}/worker/${worker.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`px-3 py-[5px] text-xs bg-status-info/10 text-status-info rounded-[6px] hover:bg-status-info/20${/^https?:\/\/(localhost|127\.0\.0\.1)/.test(worker.localUiUrl) ? ' hidden sm:inline-block' : ''}`}
                        >
                          Open Terminal
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Tasks */}
        <div className="mb-8">
          <div className="flex items-center justify-between pb-2 border-b border-border-default mb-6">
            <span className="font-mono text-[10px] uppercase tracking-[2.5px] text-text-muted">Tasks</span>
            <div className="flex items-center gap-2">
              <Link
                href="/app/tasks"
                className="px-3 py-[5px] text-xs rounded-[6px] bg-surface-3 border border-border-default hover:bg-surface-4"
              >
                View All
              </Link>
              <Link
                href="/app/tasks/new"
                className="w-full sm:w-auto px-[18px] py-[9px] rounded-[6px] text-[13px] font-medium bg-primary text-white hover:bg-primary-hover"
              >
                + New
              </Link>
            </div>
          </div>

          {recentTasks.length === 0 ? (
            <div className="border border-dashed border-border-default rounded-[10px] p-6 text-center">
              <p className="text-text-secondary mb-2">No active tasks</p>
              <Link href="/app/tasks/new" className="text-sm text-primary-400 hover:underline">
                Create your first task
              </Link>
            </div>
          ) : (
            <div className="border border-border-default rounded-[10px] overflow-hidden">
              {recentTasks.slice(0, 3).map((task) => {
                const iconStyle = TASK_ICONS[task.status] || DEFAULT_ICON;
                return (
                  <Link
                    key={task.id}
                    href={`/app/tasks/${task.id}`}
                    className="flex items-center gap-4 px-3 py-3 md:px-4 md:py-3.5 border-b border-border-default/40 last:border-b-0 hover:bg-surface-3"
                  >
                    <div className={`w-7 h-7 rounded-[6px] flex items-center justify-center text-[13px] flex-shrink-0 ${iconStyle.bg} ${iconStyle.text}`}>
                      {iconStyle.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-text-primary truncate">{task.title}</div>
                      <div className="font-mono text-[11px] text-text-muted truncate">
                        {task.workspace?.name}
                        {task.workspace?.team?.name && ` \u00B7 ${task.workspace.team.name}`}
                      </div>
                    </div>
                    <StatusBadge status={task.status} />
                    <span className="hidden sm:block font-mono text-[11px] text-text-muted whitespace-nowrap">
                      {timeAgo(task.updatedAt)}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        {/* Connected Agents */}
        {connectedAgents.length > 0 && (
          <div className="mb-8">
            <div className="font-mono text-[10px] uppercase tracking-[2.5px] text-text-muted pb-2 border-b border-border-default mb-6">
              Connected Agents
            </div>
            <div className="border border-border-default rounded-[10px] overflow-hidden">
              {connectedAgents.map((agent) => (
                <div
                  key={agent.localUiUrl}
                  className="flex items-center gap-4 px-3 py-3 md:px-4 md:py-3.5 border-b border-border-default/40 last:border-b-0"
                >
                  <div className="w-2 h-2 rounded-full bg-status-success animate-pulse flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="text-[13px] font-medium text-text-primary">{agent.accountName}</span>
                    <span className="font-mono text-[11px] text-text-muted ml-2">
                      {agent.activeWorkers}/{agent.maxConcurrent} workers
                    </span>
                  </div>
                  <span className="hidden sm:block font-mono text-[11px] text-text-muted">
                    {agent.maxConcurrent - agent.activeWorkers > 0
                      ? `${agent.maxConcurrent - agent.activeWorkers} slots available`
                      : 'At capacity'}
                  </span>
                  {/^https?:\/\/(localhost|127\.0\.0\.1)/.test(agent.localUiUrl) ? (
                    <a
                      href={agent.localUiUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hidden sm:inline-block px-3 py-[5px] text-xs rounded-[6px] bg-surface-3 border border-border-default hover:bg-surface-4"
                    >
                      Open
                    </a>
                  ) : (
                    <a
                      href={agent.localUiUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-3 py-[5px] text-xs rounded-[6px] bg-surface-3 border border-border-default hover:bg-surface-4"
                    >
                      Open
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty Workers State */}
        {activeWorkers.length === 0 && (
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[2.5px] text-text-muted pb-2 border-b border-border-default mb-6">
              Active Workers
            </div>
            <div className="border border-dashed border-border-default rounded-[10px] p-8 text-center">
              <p className="text-text-secondary">No active workers</p>
              <p className="text-sm text-text-muted mt-2">
                {connectedAgents.length > 0
                  ? 'Agents are connected and ready \u2014 create a task to get started'
                  : 'Start a local-ui instance to connect agents'}
              </p>
            </div>
          </div>
        )}

      </div>
    </main>
  );
}

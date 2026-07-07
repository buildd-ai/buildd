'use client';

import Link from 'next/link';
import type { RoleWithActivity } from './page';

interface Props {
  activeRoles: RoleWithActivity[];
  idleRoles: RoleWithActivity[];
  workspaceIds: string[];
  teamId: string | null;
  /** Total active workers in scope — includes workers whose tasks have no role attribution */
  totalActiveWorkerCount: number;
}

function RoleAvatar({ name, color, size = 40 }: { name: string; color: string; size?: number }) {
  const initial = name[0]?.toUpperCase() || '?';
  return (
    <div
      className="flex items-center justify-center flex-shrink-0 border border-border-strong"
      style={{ width: size, height: size }}
    >
      <span
        className="text-text-primary font-bold"
        style={{ fontSize: size * 0.4 }}
      >
        {initial}
      </span>
    </div>
  );
}

function StatusBadge({ status, count }: { status: string; count?: number }) {
  const countLabel = count && count > 1 ? ` · ${count}` : '';
  if (status === 'waiting_input') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-status-warning/10 text-status-warning">
        <span className="w-1.5 h-1.5 rounded-full bg-status-warning" />
        Needs input{countLabel}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-status-success/10 text-status-success">
      <span className="w-1.5 h-1.5 rounded-full bg-status-success animate-pulse" />
      Running{countLabel}
    </span>
  );
}

/** Scope pill — "All workspaces" (team-default) or workspace name (override) */
function ScopeBadge({ scopeLabel, workspaceId }: { scopeLabel: string; workspaceId: string | null }) {
  const isTeamDefault = workspaceId === null;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded ${
      isTeamDefault
        ? 'bg-accent-text/10 text-accent-text'
        : 'bg-surface-3 text-text-muted'
    }`}>
      {isTeamDefault ? (
        <>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="flex-shrink-0">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
          {scopeLabel}
        </>
      ) : (
        <>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="flex-shrink-0">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9,22 9,12 15,12 15,22" />
          </svg>
          {scopeLabel}
        </>
      )}
    </span>
  );
}

/** Returns the edit URL for a role — team-level roles use /app/team/[slug]/settings */
function editUrl(role: RoleWithActivity, firstWsId?: string): string {
  if (role.workspaceId) {
    return `/app/workspaces/${role.workspaceId}/skills/${role.id}`;
  }
  // Team-level role editor
  return `/app/team/${role.slug}/settings`;
}

function ActiveRoleCard({ role, firstWsId }: { role: RoleWithActivity; firstWsId?: string }) {
  const borderColor = role.currentTask?.workerStatus === 'waiting_input'
    ? 'var(--status-warning)'
    : 'var(--status-success)';

  return (
    <Link
      href={`/app/team/${role.slug}`}
      className="block bg-[var(--card)] p-5 shadow-[var(--card-shadow)] transition-transform hover:-translate-y-px"
      style={{ border: `2px solid ${borderColor}` }}
    >
      <div className="flex items-center gap-3 mb-3">
        <RoleAvatar name={role.name} color={role.color} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold text-text-primary truncate">{role.name}</span>
            {role.model && (
              <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono rounded bg-surface-3 text-text-muted shrink-0">
                {role.model}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-[12px] text-text-muted truncate">{role.description || role.slug}</span>
          </div>
        </div>
        {role.currentTask && <StatusBadge status={role.currentTask.workerStatus} count={role.activeWorkerCount} />}
      </div>

      {/* Scope + overrides */}
      <div className="flex items-center gap-2 mb-3">
        <ScopeBadge scopeLabel={role.scopeLabel} workspaceId={role.workspaceId} />
        {role.overrideCount > 0 && (
          <span className="text-[10px] text-text-muted">
            +{role.overrideCount} override{role.overrideCount !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {role.currentTask && (
        <div className="rounded-md bg-surface-2 p-3">
          <div className="text-[13px] font-medium text-text-primary truncate mb-1">
            {role.currentTask.title}
          </div>
          <div className="flex items-center gap-2 text-[11px] text-text-muted">
            <span>{role.currentTask.workspaceName}</span>
            {role.currentTask.missionTitle && (
              <>
                <span>&middot;</span>
                <span className="text-accent-text truncate max-w-[120px]">{role.currentTask.missionTitle}</span>
              </>
            )}
            {role.currentTask.startedAt && (
              <>
                <span>&middot;</span>
                <span>{role.currentTask.startedAt}</span>
              </>
            )}
          </div>
        </div>
      )}

      {role.stats && role.stats.total > 0 && (
        <div className="flex items-center gap-3 mt-3 text-[11px] text-text-muted">
          <span>{role.stats.total} tasks (30d)</span>
          <span className="text-status-success">{role.stats.completed} done</span>
          {role.stats.failed > 0 && <span className="text-status-error">{role.stats.failed} failed</span>}
        </div>
      )}
    </Link>
  );
}

function IdleRoleChip({ role }: { role: RoleWithActivity }) {
  return (
    <Link
      href={`/app/team/${role.slug}`}
      className="flex items-center gap-2.5 bg-[var(--card)] border border-border-strong px-4 py-3 hover:bg-surface-3 transition-colors"
    >
      <RoleAvatar name={role.name} color={role.color} size={28} />
      <div className="flex-1 min-w-0">
        <span className="text-[13px] font-medium text-text-primary truncate block">{role.name}</span>
      </div>
      {/* Scope badge */}
      <ScopeBadge scopeLabel={role.scopeLabel} workspaceId={role.workspaceId} />
      {role.overrideCount > 0 && (
        <span className="text-[10px] text-text-muted shrink-0">
          +{role.overrideCount}
        </span>
      )}
      {role.model && (
        <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono rounded bg-surface-3 text-text-muted shrink-0">
          {role.model}
        </span>
      )}
      {role.stats && role.stats.total > 0 ? (
        <span className="text-[11px] text-text-muted">{role.stats.total} tasks</span>
      ) : (
        <span className="text-[11px] text-text-muted font-mono">{role.slug}</span>
      )}
    </Link>
  );
}

export function TeamGrid({ activeRoles, idleRoles, workspaceIds, teamId, totalActiveWorkerCount }: Props) {
  const totalRoles = activeRoles.length + idleRoles.length;
  const firstWsId = workspaceIds[0];
  // Workers active in scope but not attributed to any configured role
  const unattributedWorkerCount = totalActiveWorkerCount - activeRoles.reduce((sum, r) => sum + r.activeWorkerCount, 0);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold text-text-primary">The Team</h1>
          {totalActiveWorkerCount > 0 ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium bg-status-success/10 text-status-success">
              <span className="w-1.5 h-1.5 rounded-full bg-status-success animate-pulse" />
              {totalActiveWorkerCount} running
              {idleRoles.length > 0 && activeRoles.length > 0 && (
                <span className="text-text-muted ml-0.5">&middot; {idleRoles.length} idle</span>
              )}
            </span>
          ) : (
            totalRoles > 0 && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium bg-surface-3 text-text-muted">
                Idle
              </span>
            )
          )}
        </div>
        {/* New Role — creates a team-level role by default */}
        {(teamId || firstWsId) && (
          <div className="flex items-center gap-2">
            <Link
              href={`/app/team/new`}
              className="px-4 py-2 bg-primary text-white hover:bg-primary-hover rounded-md text-sm font-medium transition-colors"
            >
              + New Role
            </Link>
          </div>
        )}
      </div>

      {totalRoles === 0 ? (
        <div className="border border-dashed border-border-default rounded-[10px] p-8 text-center">
          <p className="text-[15px] text-text-secondary mb-3">
            No roles configured yet. Create a role to define agent personas with specific models, tools, and delegation rules.
          </p>
          {(teamId || firstWsId) && (
            <Link
              href={`/app/team/new`}
              className="inline-flex px-4 py-2 bg-primary text-white hover:bg-primary-hover rounded-md text-sm font-medium"
            >
              + New Role
            </Link>
          )}
        </div>
      ) : (
        <>
          {/* Active roles grid */}
          {activeRoles.length > 0 && (
            <div className="mb-8">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {activeRoles.map((role) => (
                  <ActiveRoleCard key={role.id} role={role} firstWsId={firstWsId} />
                ))}
              </div>
            </div>
          )}

          {/* Idle roles */}
          {idleRoles.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-[13px] font-semibold text-text-muted">Idle</span>
                {unattributedWorkerCount > 0 ? (
                  <span className="text-[12px] text-text-muted">
                    {unattributedWorkerCount} worker{unattributedWorkerCount !== 1 ? 's' : ''} running without role attribution
                  </span>
                ) : totalActiveWorkerCount === 0 ? (
                  <span className="text-[12px] text-text-muted">No active tasks</span>
                ) : null}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {idleRoles.map((role) => (
                  <IdleRoleChip key={role.id} role={role} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

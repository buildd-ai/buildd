'use client';

import Link from 'next/link';
import type { RoleWithActivity } from './page';

interface Props {
  activeRoles: RoleWithActivity[];
  idleRoles: RoleWithActivity[];
  workspaceIds: string[];
}

function RoleAvatar({ name, color, size = 40 }: { name: string; color: string; size?: number }) {
  const initial = name[0]?.toUpperCase() || '?';
  return (
    <div
      className="rounded-full flex items-center justify-center flex-shrink-0"
      style={{ width: size, height: size, backgroundColor: color }}
    >
      <span
        className="text-white font-bold"
        style={{ fontSize: size * 0.4 }}
      >
        {initial}
      </span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'waiting_input') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-status-warning/10 text-status-warning">
        <span className="w-1.5 h-1.5 rounded-full bg-status-warning" />
        Needs input
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-status-success/10 text-status-success">
      <span className="w-1.5 h-1.5 rounded-full bg-status-success animate-pulse" />
      Running
    </span>
  );
}

function ActiveRoleCard({ role }: { role: RoleWithActivity }) {
  const borderColor = role.currentTask?.workerStatus === 'waiting_input'
    ? 'var(--status-warning)'
    : 'var(--status-success)';

  return (
    <Link
      href={`/app/workspaces/${role.workspaceId}/skills/${role.id}`}
      className="block rounded-[10px] bg-[var(--card)] p-5 transition-all hover:shadow-md"
      style={{ border: `2px solid ${borderColor}` }}
    >
      <div className="flex items-center gap-3 mb-3">
        <RoleAvatar name={role.name} color={role.color} />
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-semibold text-text-primary truncate">{role.name}</div>
          <div className="text-[12px] text-text-muted truncate">{role.description || role.slug}</div>
        </div>
        {role.currentTask && <StatusBadge status={role.currentTask.workerStatus} />}
      </div>

      {role.currentTask && (
        <div className="rounded-md bg-surface-2 p-3">
          <div className="text-[13px] font-medium text-text-primary truncate mb-1">
            {role.currentTask.title}
          </div>
          <div className="flex items-center gap-2 text-[11px] text-text-muted">
            <span>{role.currentTask.workspaceName}</span>
            {role.currentTask.startedAt && (
              <>
                <span>&middot;</span>
                <span>{role.currentTask.startedAt}</span>
              </>
            )}
          </div>
        </div>
      )}
    </Link>
  );
}

function IdleRoleChip({ role }: { role: RoleWithActivity }) {
  return (
    <Link
      href={`/app/workspaces/${role.workspaceId}/skills/${role.id}`}
      className="flex items-center gap-2.5 rounded-lg bg-[var(--card)] border border-border-default px-4 py-3 hover:bg-surface-3 transition-colors"
    >
      <RoleAvatar name={role.name} color={role.color} size={28} />
      <div className="flex-1 min-w-0">
        <span className="text-[13px] font-medium text-text-primary truncate block">{role.name}</span>
      </div>
      <span className="text-[11px] text-text-muted font-mono">{role.slug}</span>
    </Link>
  );
}

export function TeamGrid({ activeRoles, idleRoles, workspaceIds }: Props) {
  const totalRoles = activeRoles.length + idleRoles.length;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold text-text-primary">The Team</h1>
          {activeRoles.length > 0 && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium bg-status-success/10 text-status-success">
              {activeRoles.length} active
              {idleRoles.length > 0 && (
                <span className="text-text-muted ml-0.5">&middot; {idleRoles.length} idle</span>
              )}
            </span>
          )}
        </div>
        {workspaceIds.length > 0 && (
          <Link
            href={`/app/workspaces/${workspaceIds[0]}/skills?new=1`}
            className="px-4 py-2 bg-primary text-white hover:bg-primary-hover rounded-md text-sm font-medium transition-colors"
          >
            + New Role
          </Link>
        )}
      </div>

      {totalRoles === 0 ? (
        <div className="border border-dashed border-border-default rounded-[10px] p-8 text-center">
          <p className="text-[15px] text-text-secondary mb-3">
            No roles configured yet. Create a role to define agent personas with specific models, tools, and delegation rules.
          </p>
          {workspaceIds.length > 0 && (
            <Link
              href={`/app/workspaces/${workspaceIds[0]}/skills?new=1`}
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
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {activeRoles.map((role) => (
                  <ActiveRoleCard key={role.id} role={role} />
                ))}
              </div>
            </div>
          )}

          {/* Idle roles */}
          {idleRoles.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-[13px] font-semibold text-text-muted">Idle</span>
                <span className="text-[12px] text-text-muted">No active tasks</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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

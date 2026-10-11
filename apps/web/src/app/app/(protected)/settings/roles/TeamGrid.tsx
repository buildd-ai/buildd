'use client';

import Link from 'next/link';
import type { RoleWithActivity, PersonalRoleEntry } from './page';
import { countOf } from '@/lib/plural';
import Card from '@/components/ui/Card';
import Section from '@/components/ui/Section';
import PrimaryAction from '@/components/ui/PrimaryAction';
import StatePill, { TonePill } from '@/components/ui/StatePill';
import { personalRoleEditorPath } from '@/lib/personal-roles-shared';
import { displayTaskTitle } from '@/lib/task-title';

interface Props {
  activeRoles: RoleWithActivity[];
  idleRoles: RoleWithActivity[];
  workspaceIds: string[];
  teamId: string | null;
  /** Total active workers in scope — includes workers whose tasks have no role attribution */
  totalActiveWorkerCount: number;
  /** The viewer's own personal roles, then teammates' shared ones. */
  personalRoles?: PersonalRoleEntry[];
  /** Holds create_personal_roles in the active team. */
  canCreatePersonalRole?: boolean;
  /** Holds manage_agent_roles in the active team. Undefined: not known, offer New role as before. */
  canCreateTeamRole?: boolean;
}

const NEW_ROLE = '/app/settings/roles/new';
const NEW_PERSONAL_ROLE = '/app/settings/roles/new?kind=personal';

function RoleAvatar({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center border border-border-strong text-sm font-semibold text-text-primary"
      style={{ width: size, height: size }}
    >
      {name[0]?.toUpperCase() || '?'}
    </span>
  );
}

/** A live worker's state: waiting on a person, or building. */
function WorkerStatePill({ status, count }: { status: string; count: number }) {
  const trailing = count > 1 ? <span className="font-mono">{count}</span> : undefined;
  return status === 'waiting_input'
    ? <StatePill state="waiting" label="Needs input" trailing={trailing} />
    : <StatePill state="running" label="Running" trailing={trailing} />;
}

/** "All workspaces" for a team default, the workspace name for a workspace-only role. */
function ScopeLine({ role }: { role: RoleWithActivity }) {
  return (
    <>
      {role.scopeLabel}
      {role.overrideCount > 0 && <> · <span className="font-mono">{role.overrideCount}</span> override{role.overrideCount !== 1 ? 's' : ''}</>}
    </>
  );
}

/** A role at work: a standalone card with what it is doing now. */
function ActiveRoleCard({ role }: { role: RoleWithActivity }) {
  return (
    <Card as={Link} href={`/app/settings/roles/${role.slug}`} interactive className="block">
      <div className="flex items-start gap-3">
        <RoleAvatar name={role.name} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-semibold text-text-primary">{role.name}</span>
            {role.currentTask && <WorkerStatePill status={role.currentTask.workerStatus} count={role.activeWorkerCount} />}
          </div>
          <p className="mt-0.5 truncate text-sm text-text-muted"><ScopeLine role={role} /></p>
        </div>
      </div>

      {role.currentTask && (
        <div className="mt-3 border-t border-border-default pt-3">
          <p className="truncate text-sm font-medium text-text-primary">{displayTaskTitle(role.currentTask.title)}</p>
          <p className="mt-0.5 truncate text-sm text-text-muted">
            {role.currentTask.workspaceName}
            {role.currentTask.missionTitle && <> · {role.currentTask.missionTitle}</>}
            {role.currentTask.startedAt && <> · {role.currentTask.startedAt}</>}
          </p>
        </div>
      )}

      {role.stats && role.stats.total > 0 && (
        <p className="mt-2 text-meta text-text-muted">
          <span className="font-mono">{countOf(role.stats.total, 'task')}</span> in 30 days
          · <span className="font-mono">{role.stats.completed}</span> done
          {role.stats.failed > 0 && <> · <span className="font-mono text-status-error">{role.stats.failed}</span> failed</>}
        </p>
      )}
    </Card>
  );
}

/** An idle role: one hairline row. */
function IdleRoleRow({ role }: { role: RoleWithActivity }) {
  return (
    <Link
      href={`/app/settings/roles/${role.slug}`}
      className="flex min-h-14 items-center gap-3 py-2.5 hover:bg-surface-3 transition-colors"
    >
      <RoleAvatar name={role.name} size={28} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text-primary">{role.name}</span>
        <span className="block truncate text-sm text-text-muted"><ScopeLine role={role} /></span>
      </span>
      {role.model && <span className="hidden sm:inline shrink-0 font-mono text-meta text-text-muted">{role.model}</span>}
      {role.stats && role.stats.total > 0 && (
        <span className="shrink-0 font-mono text-meta text-text-muted">{countOf(role.stats.total, 'task')}</span>
      )}
    </Link>
  );
}

/** One personal role: own (private / shared) or a teammate's shared one with its owner. */
function PersonalRoleRow({ role }: { role: PersonalRoleEntry }) {
  return (
    <Link
      href={personalRoleEditorPath(role)}
      data-testid="personal-role-chip"
      className="flex min-h-14 items-center gap-3 py-2.5 hover:bg-surface-3 transition-colors"
    >
      <RoleAvatar name={role.name} size={28} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text-primary">{role.name}</span>
        {!role.isMine && (
          <span className="block truncate text-sm text-text-muted">
            {role.ownerName ? `by ${role.ownerName}` : 'by a teammate'}
          </span>
        )}
      </span>
      {role.isMine && (
        <span data-testid="personal-role-visibility">
          {role.visibility === 'team' ? <TonePill tone="run">Shared</TonePill> : <TonePill tone="q">Private</TonePill>}
        </span>
      )}
      <span className="hidden sm:inline shrink-0 font-mono text-meta text-text-muted">{role.slug}</span>
    </Link>
  );
}

const ROWS = 'divide-y divide-border-default border-y border-border-default';

function PersonalRolesSections({ roles, canCreate }: { roles: PersonalRoleEntry[]; canCreate: boolean }) {
  const mine = roles.filter(r => r.isMine);
  const shared = roles.filter(r => !r.isMine);
  return (
    <>
      {(mine.length > 0 || canCreate) && (
        <Section
          title="Mine"
          count={mine.length > 0 ? mine.length : undefined}
          action={canCreate && mine.length > 0
            ? <Link href={NEW_PERSONAL_ROLE} className="btn btn-sm h-11 md:h-6">Just for me</Link>
            : undefined}
        >
          <div data-testid="team-mine-section">
            {mine.length === 0 ? (
              <p className="text-sm text-text-muted">
                Roles only you run, shared with the team when ready.{' '}
                <Link href={NEW_PERSONAL_ROLE} className="font-medium text-text-primary underline underline-offset-2">Just for me</Link>
              </p>
            ) : (
              <div className={ROWS}>
                {mine.map(role => <PersonalRoleRow key={role.id} role={role} />)}
              </div>
            )}
          </div>
        </Section>
      )}
      {shared.length > 0 && (
        <Section title="Shared by teammates" count={shared.length}>
          <div data-testid="team-shared-section" className={ROWS}>
            {shared.map(role => <PersonalRoleRow key={role.id} role={role} />)}
          </div>
        </Section>
      )}
    </>
  );
}

export function TeamGrid({
  activeRoles, idleRoles, workspaceIds, teamId, totalActiveWorkerCount,
  personalRoles = [], canCreatePersonalRole = false, canCreateTeamRole,
}: Props) {
  const totalRoles = activeRoles.length + idleRoles.length;
  // Undefined = permissions not passed: keep the old "anyone with a team" offer.
  const hasScope = !!(teamId || workspaceIds[0]);
  const offersTeam = canCreateTeamRole ?? hasScope;
  const canCreateAny = hasScope && (offersTeam || canCreatePersonalRole);
  const newRoleHref = !offersTeam && canCreatePersonalRole ? NEW_PERSONAL_ROLE : NEW_ROLE;
  // Workers active in scope but not attributed to any configured role
  const unattributedWorkerCount = totalActiveWorkerCount - activeRoles.reduce((sum, r) => sum + r.activeWorkerCount, 0);

  return (
    <div className="space-y-8">
      {(canCreateAny || totalActiveWorkerCount > 0) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {totalActiveWorkerCount > 0 ? (
            <StatePill
              state="running"
              label={`${totalActiveWorkerCount} running`}
              trailing={idleRoles.length > 0 && activeRoles.length > 0 ? `· ${idleRoles.length} idle` : undefined}
            />
          ) : <span />}
          {canCreateAny && <PrimaryAction href={newRoleHref}>New role</PrimaryAction>}
        </div>
      )}

      {totalRoles === 0 ? (
        <p className="text-sm text-text-muted">
          No roles.
          {canCreateAny && <> <Link href={newRoleHref} className="font-medium text-text-primary underline underline-offset-2">Create one</Link></>}
        </p>
      ) : (
        <>
          <Section title="Working" count={activeRoles.length}>
            {activeRoles.length > 0 && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {activeRoles.map(role => <ActiveRoleCard key={role.id} role={role} />)}
              </div>
            )}
          </Section>

          <Section title="Idle" count={idleRoles.length}>
            {idleRoles.length > 0 && (
              <>
                {unattributedWorkerCount > 0 && (
                  <p className="mb-2 text-sm text-text-muted">
                    <span className="font-mono">{unattributedWorkerCount}</span> worker{unattributedWorkerCount !== 1 ? 's' : ''} running without a role
                  </p>
                )}
                <div className={ROWS}>
                  {idleRoles.map(role => <IdleRoleRow key={role.id} role={role} />)}
                </div>
              </>
            )}
          </Section>
        </>
      )}

      <PersonalRolesSections roles={personalRoles} canCreate={hasScope && canCreatePersonalRole} />
    </div>
  );
}

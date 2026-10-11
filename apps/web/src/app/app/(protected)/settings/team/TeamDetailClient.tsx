'use client';

import { clampedKeysNotice } from './clamped-keys-notice';
import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Select } from '@/components/ui/Select';
import { useConfirm } from '@/components/useConfirm';
import { roleHas, type PermissionOverrides } from '@/lib/permission-registry';
import { isQaFixtureMemberId } from './qa-state';
import Section from '@/components/ui/Section';
import Notice from '@/components/ui/Notice';
import PrimaryAction from '@/components/ui/PrimaryAction';
import { TonePill } from '@/components/ui/StatePill';
import type { StateTone } from '@/components/ui/states';

interface TeamMember {
  userId: string;
  role: 'owner' | 'admin' | 'member';
  joinedAt: string;
  name: string | null;
  email: string;
  image: string | null;
}

interface TeamDetailClientProps {
  team: {
    id: string;
    name: string;
    slug: string;
    createdAt: string;
  };
  members: TeamMember[];
  currentUserRole: 'owner' | 'admin' | 'member';
  currentUserId: string;
  isPersonal: boolean;
  /** `manage_team_members`: add, invite and remove members. */
  canManage: boolean;
  /** The team's permission overrides, so role checks here match the server. */
  permissionOverrides: PermissionOverrides | null;
  /**
   * Sections the page shows between the members and the danger zone
   * (timezone, permissions), so Leave and Delete stay at the bottom.
   */
  children?: ReactNode;
}

/** A fixed role reads as a quiet tag; owner and admin share the info tone. */
const ROLE_TONE: Record<TeamMember['role'], StateTone> = {
  owner: 'run',
  admin: 'run',
  member: 'q',
};

export default function TeamDetailClient({
  team,
  members,
  currentUserRole,
  currentUserId,
  isPersonal,
  canManage,
  permissionOverrides,
  children,
}: TeamDetailClientProps) {
  const { confirm, confirmDialog } = useConfirm();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(team.name);
  const [editSlug, setEditSlug] = useState(team.slug);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Set when a role change, removal or transfer lowered someone's API keys.
  const [notice, setNotice] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member');
  const [inviting, setInviting] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const canEditTeam = roleHas(currentUserRole, 'manage_team_settings', permissionOverrides);
  const canDeleteTeam = roleHas(currentUserRole, 'delete_team', null /* locked */) && !isPersonal;
  const canAssignOwner = roleHas(currentUserRole, 'assign_team_owner', null /* locked */);
  const canAssignRoles = roleHas(currentUserRole, 'assign_team_roles', permissionOverrides);
  const isLastOwner = currentUserRole === 'owner' && members.filter((m) => m.role === 'owner').length <= 1;

  /** The roles this caller may pick for `member`, or null when its role is fixed for them. */
  function roleOptionsFor(member: TeamMember): Array<'owner' | 'admin' | 'member'> | null {
    if (member.userId === currentUserId) return null;
    if (canAssignOwner) return ['owner', 'admin', 'member'];
    if (canAssignRoles && member.role !== 'owner') return ['admin', 'member'];
    return null;
  }

  async function handleInvite() {
    if (!inviteEmail) return;
    setInviting(true);
    setError('');
    setInviteUrl(null);

    try {
      const res = await fetch(`/api/teams/${team.id}/invitations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to send invitation');
      }

      const data = await res.json();
      setInviteUrl(data.inviteUrl);
      setInviteEmail('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to invite');
    } finally {
      setInviting(false);
    }
  }

  async function handleSaveEdit() {
    setSaving(true);
    setError('');

    try {
      const res = await fetch(`/api/teams/${team.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName, slug: editSlug }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to update team');
      }

      setEditing(false);
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!(await confirm({ title: 'Delete team?', message: 'Deletes the team with its workspaces and accounts. You can’t undo this.', confirmLabel: 'Delete team', variant: 'danger' }))) {
      return;
    }

    setDeleting(true);
    try {
      const res = await fetch(`/api/teams/${team.id}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to delete team');
      }

      router.push('/app/settings');
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setDeleting(false);
    }
  }

  async function handleRoleChange(userId: string, newRole: string) {
    // Fixture rows (?state=multi-member, dev fixtures) aren't real members: never write for them.
    if (isQaFixtureMemberId(userId)) return;
    try {
      const res = await fetch(`/api/teams/${team.id}/members/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to update role');
      }

      setNotice(clampedKeysNotice((await res.json().catch(() => ({}))).clampedKeys, 'they'));
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  }

  async function handleRemoveMember(userId: string, memberName: string | null) {
    if (!(await confirm({ title: 'Remove member?', message: `Remove ${memberName || 'this member'} from the team?`, confirmLabel: 'Remove', variant: 'danger' }))) {
      return;
    }
    if (isQaFixtureMemberId(userId)) return;

    try {
      const res = await fetch(`/api/teams/${team.id}/members/${userId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to remove member');
      }

      setNotice(clampedKeysNotice((await res.json().catch(() => ({}))).clampedKeys, 'they'));
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  }

  async function handleTransferOwnership(userId: string, memberName: string | null) {
    const who = memberName || 'this member';
    if (!(await confirm({
      title: 'Transfer ownership?',
      message: `${who} becomes an owner and you become an admin. Only an owner can make you an owner again.`,
      confirmLabel: 'Transfer ownership',
      variant: 'warning',
    }))) {
      return;
    }
    if (isQaFixtureMemberId(userId)) return;

    try {
      const res = await fetch(`/api/teams/${team.id}/ownership`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to transfer ownership');
      }

      setNotice(clampedKeysNotice((await res.json().catch(() => ({}))).clampedKeys, 'you'));
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  }

  async function handleLeave() {
    if (!(await confirm({ title: 'Leave team?', message: `You lose access to ${team.name} and its workspaces. Someone with member access has to add you back.`, confirmLabel: 'Leave team', variant: 'danger' }))) {
      return;
    }
    if (isQaFixtureMemberId(currentUserId)) return;

    setLeaving(true);
    try {
      const res = await fetch(`/api/teams/${team.id}/members/${currentUserId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to leave team');
      }

      router.push('/app/settings/account');
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setLeaving(false);
    }
  }

  const input = 'w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 text-text-primary text-base md:text-sm';

  return (
    <>
      {error && (
        <Notice tone="err" action={{ label: 'Dismiss', onClick: () => setError('') }}>{error}</Notice>
      )}
      {notice && (
        <Notice tone="info" action={{ label: 'Dismiss', onClick: () => setNotice('') }}>{notice}</Notice>
      )}

      {/* The team itself: one row, renamed in place. */}
      {editing ? (
        <div className="space-y-3 border-y border-border-default py-3">
          <div>
            <label htmlFor="team-name" className="mb-1.5 block text-sm font-medium text-text-primary">Team name</label>
            <input id="team-name" type="text" value={editName} onChange={(e) => setEditName(e.target.value)} className={input} />
          </div>
          <div>
            <label htmlFor="team-slug" className="mb-1.5 block text-sm font-medium text-text-primary">Slug</label>
            <input id="team-slug" type="text" value={editSlug} onChange={(e) => setEditSlug(e.target.value)} className={`${input} font-mono`} />
          </div>
          <div className="flex gap-2">
            <button onClick={handleSaveEdit} disabled={saving} className="btn">
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setEditName(team.name);
                setEditSlug(team.slug);
              }}
              className="btn-quiet"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex min-h-14 items-center justify-between gap-3 border-y border-border-default py-2.5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-text-primary [overflow-wrap:anywhere]">{team.name}</span>
              {isPersonal && <TonePill tone="q">Personal</TonePill>}
            </div>
            <p className="text-sm text-text-muted">
              <span className="font-mono text-meta">{team.slug}</span> · Created {new Date(team.createdAt).toLocaleDateString()}
            </p>
          </div>
          {canEditTeam && (
            <button onClick={() => setEditing(true)} className="btn h-11 md:h-8 shrink-0">Rename</button>
          )}
        </div>
      )}

      <Section title="Members" count={members.length}>
        <p className="mb-3 text-sm text-text-muted">
          A lower role also lowers the API keys that person created. Older keys with no recorded creator stay as they are.
        </p>
        <div className="divide-y divide-border-default border-y border-border-default">
          {members.map((member) => (
            <div key={member.userId} className="py-3 flex flex-col gap-2 md:flex-row md:flex-wrap md:justify-between md:items-center md:gap-x-3">
              <div className="flex items-center gap-3 min-w-0 md:flex-1 md:basis-48">
                {member.image ? (
                  <img
                    src={member.image}
                    alt=""
                    className="w-8 h-8 rounded-full flex-shrink-0"
                  />
                ) : (
                  <div className="w-8 h-8 flex-shrink-0 rounded-full bg-surface-4 flex items-center justify-center text-sm font-medium text-text-secondary">
                    {(member.name || member.email)[0]?.toUpperCase()}
                  </div>
                )}
                <div className="min-w-0">
                  <div className="text-sm font-medium text-text-primary [overflow-wrap:anywhere]">
                    {member.name || member.email}
                    {member.userId === currentUserId && (
                      <span className="ml-1 font-normal text-text-muted">(you)</span>
                    )}
                  </div>
                  <div className="text-sm text-text-secondary [overflow-wrap:anywhere]">{member.email}</div>
                </div>
              </div>
              <div data-testid="member-controls" className="flex flex-wrap items-center gap-x-3 gap-y-1 md:justify-end md:flex-shrink-0 md:ml-auto">
                {(() => {
                  const options = roleOptionsFor(member);
                  return options ? (
                    <Select
                      value={member.role}
                      onChange={(v) => handleRoleChange(member.userId, v)}
                      options={options.map((r) => ({ value: r, label: r }))}
                      size="sm"
                      aria-label={`Role for ${member.name || member.email}`}
                    />
                  ) : (
                    <TonePill tone={ROLE_TONE[member.role]}>{member.role}</TonePill>
                  );
                })()}
                {(() => {
                  const canTransfer = canAssignOwner && !isPersonal && member.role !== 'owner' && member.userId !== currentUserId;
                  const canRemove = canManage && member.userId !== currentUserId && (member.role !== 'owner' || canAssignOwner);
                  if (!canTransfer && !canRemove) return null;
                  // The text actions wrap as one unit; -ml-3 lines their text up with the select above on phones.
                  return (
                    <div className="flex items-center -ml-3 md:ml-0 md:gap-3">
                      {canTransfer && (
                        <button
                          onClick={() => handleTransferOwnership(member.userId, member.name)}
                          className="btn-quiet min-h-11 md:min-h-0 px-3 md:px-1 whitespace-nowrap"
                        >
                          Transfer ownership
                        </button>
                      )}
                      {canRemove && (
                        <button
                          onClick={() => handleRemoveMember(member.userId, member.name)}
                          className="btn-quiet min-h-11 md:min-h-0 px-3 md:px-1 text-status-error"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
          ))}
        </div>

        {/* Invite: the one primary on this page. */}
        {canManage && (
          <div className="mt-4">
            {!showInvite ? (
              <PrimaryAction onClick={() => setShowInvite(true)}>+ Invite someone</PrimaryAction>
            ) : (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-text-primary">Invite a team member</h3>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="Email address"
                    aria-label="Email address"
                    className="w-full sm:w-auto sm:flex-1 min-w-0 px-3 py-2 bg-surface-1 border border-border-default rounded-md text-base md:text-sm"
                    autoFocus
                  />
                  <Select
                    value={inviteRole}
                    onChange={(v) => setInviteRole(v as 'admin' | 'member')}
                    options={canAssignRoles
                      ? [{ value: 'member', label: 'member' }, { value: 'admin', label: 'admin' }]
                      : [{ value: 'member', label: 'member' }]}
                    size="sm"
                  />
                  <PrimaryAction onClick={handleInvite} disabled={!inviteEmail} pending={inviting} fullWidthOnMobile>
                    {inviting ? 'Sending…' : 'Invite'}
                  </PrimaryAction>
                </div>
                {inviteUrl && (
                  <Notice tone="ok" title="Invite link, expires in 7 days">
                    <code className="font-mono text-meta text-text-primary break-all select-all">{inviteUrl}</code>
                  </Notice>
                )}
                <button
                  onClick={() => { setShowInvite(false); setInviteUrl(null); }}
                  className="btn-quiet"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}
      </Section>

      {children}

      {(!isPersonal || canDeleteTeam) && (
        <Section title="Danger zone">
          <div className="divide-y divide-border-default border-y border-border-default">
            {!isPersonal && (
              <div className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text-primary">Leave team</p>
                  <p className="text-sm text-text-muted">
                    {isLastOwner
                      ? 'You are the only owner. Make someone else an owner before you leave.'
                      : `You lose access to ${team.name} and its workspaces.`}
                  </p>
                </div>
                <button
                  onClick={handleLeave}
                  disabled={leaving || isLastOwner}
                  className="btn btn-danger h-11 md:h-8"
                >
                  {leaving ? 'Leaving…' : 'Leave team'}
                </button>
              </div>
            )}
            {canDeleteTeam && (
              <div className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text-primary">Delete team</p>
                  <p className="text-sm text-text-muted">Deletes the team with its workspaces and accounts.</p>
                </div>
                <button onClick={handleDelete} disabled={deleting} className="btn btn-danger h-11 md:h-8">
                  {deleting ? 'Deleting…' : 'Delete team'}
                </button>
              </div>
            )}
          </div>
        </Section>
      )}
      {confirmDialog}
    </>
  );
}

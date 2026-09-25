'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Select } from '@/components/ui/Select';
import { useConfirm } from '@/components/useConfirm';

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
  canManage: boolean;
}

const roleColors: Record<string, string> = {
  owner: 'bg-primary/10 text-primary',
  admin: 'bg-status-info/10 text-status-info',
  member: 'bg-surface-3 text-text-primary',
};

export default function TeamDetailClient({
  team,
  members,
  currentUserRole,
  currentUserId,
  isPersonal,
  canManage,
}: TeamDetailClientProps) {
  const { confirm, confirmDialog } = useConfirm();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(team.name);
  const [editSlug, setEditSlug] = useState(team.slug);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member');
  const [inviting, setInviting] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);

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
    if (!(await confirm({ title: 'Delete team?', message: 'This will also delete all associated workspaces and accounts. This cannot be undone.', confirmLabel: 'Delete team', variant: 'danger' }))) {
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

      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  }

  async function handleRemoveMember(userId: string, memberName: string | null) {
    if (!(await confirm({ title: 'Remove member?', message: `Remove ${memberName || 'this member'} from the team?`, confirmLabel: 'Remove', variant: 'danger' }))) {
      return;
    }

    try {
      const res = await fetch(`/api/teams/${team.id}/members/${userId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to remove member');
      }

      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  }

  return (
    <div>
      {error && (
        <div className="mb-4 p-4 bg-status-error/10 border border-status-error/30 rounded-lg text-status-error">
          {error}
          <button onClick={() => setError('')} className="ml-2 text-sm underline">dismiss</button>
        </div>
      )}

      {/* Team Header */}
      <div className="flex flex-wrap justify-between items-start gap-3 mb-8">
        <div className="min-w-0">
          {editing ? (
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1">Team Name</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="px-3 py-2 border border-border-default rounded-md bg-surface-1 text-base md:text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Slug</label>
                <input
                  type="text"
                  value={editSlug}
                  onChange={(e) => setEditSlug(e.target.value)}
                  className="px-3 py-2 border border-border-default rounded-md bg-surface-1 font-mono text-base md:text-sm"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleSaveEdit}
                  disabled={saving}
                  className="px-3 py-1.5 bg-primary text-white rounded-md hover:bg-primary-hover text-sm disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  onClick={() => {
                    setEditing(false);
                    setEditName(team.name);
                    setEditSlug(team.slug);
                  }}
                  className="px-3 py-1.5 border border-border-default rounded-md hover:bg-surface-3 text-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl md:text-3xl font-bold [overflow-wrap:anywhere]">{team.name}</h1>
                {isPersonal && (
                  <span className="px-1.5 py-0.5 text-xs bg-surface-3 text-text-secondary rounded">
                    Personal
                  </span>
                )}
              </div>
              <p className="text-text-secondary font-mono text-sm">{team.slug}</p>
              <p className="text-xs text-text-muted mt-1">
                Created {new Date(team.createdAt).toLocaleDateString()}
              </p>
            </>
          )}
        </div>
        {canManage && !editing && (
          <div className="flex gap-2 shrink-0">
            <button
              onClick={() => setEditing(true)}
              className="min-h-11 md:min-h-0 px-3 py-1.5 border border-border-default rounded-md hover:bg-surface-3 text-sm"
            >
              Edit
            </button>
            {currentUserRole === 'owner' && !isPersonal && (
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="min-h-11 md:min-h-0 whitespace-nowrap px-3 py-1.5 border border-status-error/30 text-status-error rounded-md hover:bg-status-error/10 text-sm disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Delete Team'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Members */}
      <div>
        <h2 className="text-xl font-semibold mb-4">
          Members ({members.length})
        </h2>
        <div className="border border-border-default rounded-lg divide-y divide-border-default">
          {members.map((member) => (
            <div key={member.userId} className="p-4 flex flex-wrap justify-between items-center gap-x-3 gap-y-2">
              <div className="flex items-center gap-3 min-w-0 flex-1">
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
                  <div className="font-medium [overflow-wrap:anywhere]">
                    {member.name || member.email}
                    {member.userId === currentUserId && (
                      <span className="text-xs text-text-muted ml-1">(you)</span>
                    )}
                  </div>
                  <div className="text-sm text-text-secondary [overflow-wrap:anywhere]">{member.email}</div>
                </div>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0 ml-auto">
                {canManage && currentUserRole === 'owner' && member.userId !== currentUserId ? (
                  <Select
                    value={member.role}
                    onChange={(v) => handleRoleChange(member.userId, v)}
                    options={[
                      { value: 'owner', label: 'owner' },
                      { value: 'admin', label: 'admin' },
                      { value: 'member', label: 'member' },
                    ]}
                    size="sm"
                  />
                ) : (
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-full ${roleColors[member.role]}`}>
                    {member.role}
                  </span>
                )}
                {canManage && member.userId !== currentUserId && (
                  <button
                    onClick={() => handleRemoveMember(member.userId, member.name)}
                    className="min-h-11 md:min-h-0 px-1 text-xs text-status-error hover:text-status-error/80"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Invite */}
        {canManage && (
          <div className="mt-4">
            {!showInvite ? (
              <button
                onClick={() => setShowInvite(true)}
                className="min-h-11 md:min-h-0 text-sm text-primary hover:underline"
              >
                + Invite someone
              </button>
            ) : (
              <div className="card p-4 space-y-3">
                <h3 className="text-sm font-medium">Invite a team member</h3>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="Email address"
                    className="w-full sm:w-auto sm:flex-1 min-w-0 px-3 py-2 bg-surface-1 border border-border-default rounded-md text-base md:text-sm"
                    autoFocus
                  />
                  <Select
                    value={inviteRole}
                    onChange={(v) => setInviteRole(v as 'admin' | 'member')}
                    options={[
                      { value: 'member', label: 'member' },
                      { value: 'admin', label: 'admin' },
                    ]}
                    size="sm"
                  />
                  <button
                    onClick={handleInvite}
                    disabled={inviting || !inviteEmail}
                    className="w-full sm:w-auto min-h-11 md:min-h-0 px-4 py-2 text-sm bg-primary text-white rounded-md hover:bg-primary-hover disabled:opacity-50"
                  >
                    {inviting ? 'Sending…' : 'Invite'}
                  </button>
                </div>
                {inviteUrl && (
                  <div className="p-3 bg-surface-3 rounded-md">
                    <p className="text-xs text-text-secondary mb-1">Share this invite link (expires in 7 days):</p>
                    <code className="text-xs text-text-primary break-all select-all">{inviteUrl}</code>
                  </div>
                )}
                <button
                  onClick={() => { setShowInvite(false); setInviteUrl(null); }}
                  className="text-xs text-text-muted hover:text-text-secondary"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      {confirmDialog}
    </div>
  );
}

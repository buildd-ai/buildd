'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Select } from '@/components/ui/Select';

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
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(team.name);
  const [editSlug, setEditSlug] = useState(team.slug);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);

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
    if (!confirm('Are you sure you want to delete this team? This will also delete all associated workspaces and accounts.')) {
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
    if (!confirm(`Remove ${memberName || 'this member'} from the team?`)) {
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
      <div className="flex justify-between items-start mb-8">
        <div>
          {editing ? (
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1">Team Name</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="px-3 py-2 border border-border-default rounded-md bg-surface-1"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Slug</label>
                <input
                  type="text"
                  value={editSlug}
                  onChange={(e) => setEditSlug(e.target.value)}
                  className="px-3 py-2 border border-border-default rounded-md bg-surface-1 font-mono text-sm"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleSaveEdit}
                  disabled={saving}
                  className="px-3 py-1.5 bg-primary text-white rounded-md hover:bg-primary-hover text-sm disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save'}
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
                <h1 className="text-3xl font-bold">{team.name}</h1>
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
          <div className="flex gap-2">
            <button
              onClick={() => setEditing(true)}
              className="px-3 py-1.5 border border-border-default rounded-md hover:bg-surface-3 text-sm"
            >
              Edit
            </button>
            {currentUserRole === 'owner' && !isPersonal && (
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-3 py-1.5 border border-status-error/30 text-status-error rounded-md hover:bg-status-error/10 text-sm disabled:opacity-50"
              >
                {deleting ? 'Deleting...' : 'Delete Team'}
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
            <div key={member.userId} className="p-4 flex justify-between items-center">
              <div className="flex items-center gap-3">
                {member.image ? (
                  <img
                    src={member.image}
                    alt=""
                    className="w-8 h-8 rounded-full"
                  />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-surface-4 flex items-center justify-center text-sm font-medium text-text-secondary">
                    {(member.name || member.email)[0]?.toUpperCase()}
                  </div>
                )}
                <div>
                  <div className="font-medium">
                    {member.name || member.email}
                    {member.userId === currentUserId && (
                      <span className="text-xs text-text-muted ml-1">(you)</span>
                    )}
                  </div>
                  <div className="text-sm text-text-secondary">{member.email}</div>
                </div>
              </div>
              <div className="flex items-center gap-3">
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
                    className="text-xs text-status-error hover:text-status-error/80"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

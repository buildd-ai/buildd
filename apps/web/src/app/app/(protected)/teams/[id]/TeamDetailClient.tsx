'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

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
  owner: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  admin: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  member: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
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

      router.push('/app/teams');
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
        <div className="mb-4 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-400">
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
                  className="px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Slug</label>
                <input
                  type="text"
                  value={editSlug}
                  onChange={(e) => setEditSlug(e.target.value)}
                  className="px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 font-mono text-sm"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleSaveEdit}
                  disabled={saving}
                  className="px-3 py-1.5 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80 text-sm disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={() => {
                    setEditing(false);
                    setEditName(team.name);
                    setEditSlug(team.slug);
                  }}
                  className="px-3 py-1.5 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-sm"
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
                  <span className="px-1.5 py-0.5 text-xs bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 rounded">
                    Personal
                  </span>
                )}
              </div>
              <p className="text-gray-500 font-mono text-sm">{team.slug}</p>
              <p className="text-xs text-gray-400 mt-1">
                Created {new Date(team.createdAt).toLocaleDateString()}
              </p>
            </>
          )}
        </div>
        {canManage && !editing && (
          <div className="flex gap-2">
            <button
              onClick={() => setEditing(true)}
              className="px-3 py-1.5 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-sm"
            >
              Edit
            </button>
            {currentUserRole === 'owner' && !isPersonal && (
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-3 py-1.5 border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 text-sm disabled:opacity-50"
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
        <div className="border border-gray-200 dark:border-gray-800 rounded-lg divide-y divide-gray-200 dark:divide-gray-800">
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
                  <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center text-sm font-medium text-gray-600 dark:text-gray-400">
                    {(member.name || member.email)[0]?.toUpperCase()}
                  </div>
                )}
                <div>
                  <div className="font-medium">
                    {member.name || member.email}
                    {member.userId === currentUserId && (
                      <span className="text-xs text-gray-400 ml-1">(you)</span>
                    )}
                  </div>
                  <div className="text-sm text-gray-500">{member.email}</div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {canManage && currentUserRole === 'owner' && member.userId !== currentUserId ? (
                  <select
                    value={member.role}
                    onChange={(e) => handleRoleChange(member.userId, e.target.value)}
                    className="text-xs px-2 py-1 border border-gray-300 dark:border-gray-700 rounded bg-white dark:bg-gray-900"
                  >
                    <option value="owner">owner</option>
                    <option value="admin">admin</option>
                    <option value="member">member</option>
                  </select>
                ) : (
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-full ${roleColors[member.role]}`}>
                    {member.role}
                  </span>
                )}
                {canManage && member.userId !== currentUserId && (
                  <button
                    onClick={() => handleRemoveMember(member.userId, member.name)}
                    className="text-xs text-red-500 hover:text-red-700 dark:hover:text-red-400"
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

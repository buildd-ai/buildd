'use client';

import { useState } from 'react';

export default function InviteForm({ teamId }: { teamId: string }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setInviteUrl(null);

    try {
      const res = await fetch(`/api/teams/${teamId}/invitations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Failed to send invitation');
        return;
      }

      setInviteUrl(data.inviteUrl);
      setEmail('');
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    if (!inviteUrl) return;
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div>
      <form onSubmit={handleSubmit} className="flex gap-2 items-end">
        <div className="flex-1">
          <label htmlFor="invite-email" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Email address
          </label>
          <input
            id="invite-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="colleague@example.com"
            required
            className="w-full px-3 py-2 border border-gray-300 dark:border-zinc-600 rounded-lg bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:ring-2 focus:ring-violet-500 focus:border-transparent"
          />
        </div>
        <div>
          <label htmlFor="invite-role" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Role
          </label>
          <select
            id="invite-role"
            value={role}
            onChange={(e) => setRole(e.target.value as 'member' | 'admin')}
            className="px-3 py-2 border border-gray-300 dark:border-zinc-600 rounded-lg bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-violet-500 focus:border-transparent"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={loading || !email}
          className="px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed font-medium whitespace-nowrap"
        >
          {loading ? 'Sending...' : 'Send Invite'}
        </button>
      </form>

      {error && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      {inviteUrl && (
        <div className="mt-3 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
          <p className="text-sm text-green-800 dark:text-green-200 mb-2">Invitation created! Share this link:</p>
          <div className="flex gap-2 items-center">
            <code className="flex-1 text-xs bg-white dark:bg-zinc-800 px-2 py-1 rounded border border-gray-200 dark:border-zinc-700 overflow-hidden text-ellipsis">
              {inviteUrl}
            </code>
            <button
              onClick={handleCopy}
              className="px-3 py-1 text-sm bg-gray-100 dark:bg-zinc-700 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-200 dark:hover:bg-zinc-600"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

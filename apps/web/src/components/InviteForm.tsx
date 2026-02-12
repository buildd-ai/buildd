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
          <label htmlFor="invite-email" className="block text-sm font-medium text-text-secondary mb-1">
            Email address
          </label>
          <input
            id="invite-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="colleague@example.com"
            required
            className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 text-text-primary placeholder-text-muted focus:ring-2 focus:ring-primary-ring focus:border-primary"
          />
        </div>
        <div>
          <label htmlFor="invite-role" className="block text-sm font-medium text-text-secondary mb-1">
            Role
          </label>
          <select
            id="invite-role"
            value={role}
            onChange={(e) => setRole(e.target.value as 'member' | 'admin')}
            className="px-3 py-2 border border-border-default rounded-md bg-surface-1 text-text-primary focus:ring-2 focus:ring-primary-ring focus:border-primary"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={loading || !email}
          className="px-4 py-2 bg-primary text-white rounded-md hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed font-medium whitespace-nowrap"
        >
          {loading ? 'Sending...' : 'Send Invite'}
        </button>
      </form>

      {error && (
        <p className="mt-2 text-sm text-status-error">{error}</p>
      )}

      {inviteUrl && (
        <div className="mt-3 p-3 bg-status-success/10 border border-status-success/20 rounded-md">
          <p className="text-sm text-status-success mb-2">Invitation created! Share this link:</p>
          <div className="flex gap-2 items-center">
            <code className="flex-1 text-xs bg-surface-1 px-2 py-1 rounded border border-border-default overflow-hidden text-ellipsis">
              {inviteUrl}
            </code>
            <button
              onClick={handleCopy}
              className="px-3 py-1 text-sm bg-surface-3 text-text-secondary rounded hover:bg-surface-4"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

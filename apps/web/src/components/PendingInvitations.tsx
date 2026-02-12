'use client';

import { useState, useEffect, useCallback } from 'react';

interface Invitation {
  id: string;
  email: string;
  role: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  inviter?: {
    id: string;
    name: string | null;
    email: string;
  } | null;
}

export default function PendingInvitations({ teamId }: { teamId: string }) {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);

  const fetchInvitations = useCallback(async () => {
    try {
      const res = await fetch(`/api/teams/${teamId}/invitations`);
      if (res.ok) {
        const data = await res.json();
        setInvitations(data.invitations || []);
      }
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    fetchInvitations();
  }, [fetchInvitations]);

  async function handleRevoke(invitationId: string) {
    setRevoking(invitationId);
    try {
      const res = await fetch(`/api/teams/${teamId}/invitations/${invitationId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setInvitations((prev) => prev.filter((i) => i.id !== invitationId));
      }
    } catch {
      // Silently fail
    } finally {
      setRevoking(null);
    }
  }

  if (loading) {
    return <p className="text-sm text-text-secondary">Loading invitations...</p>;
  }

  if (invitations.length === 0) {
    return <p className="text-sm text-text-secondary">No pending invitations.</p>;
  }

  return (
    <div className="space-y-2">
      {invitations.map((inv) => {
        const expiresAt = new Date(inv.expiresAt);
        const daysLeft = Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));

        return (
          <div
            key={inv.id}
            className="flex items-center justify-between p-3 bg-surface-3 rounded-md"
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-text-primary truncate">
                {inv.email}
              </p>
              <p className="text-xs text-text-muted">
                <span className="capitalize">{inv.role}</span>
                {' '}&middot;{' '}
                {inv.inviter?.name || inv.inviter?.email ? `Invited by ${inv.inviter.name || inv.inviter.email}` : 'Invited'}
                {' '}&middot;{' '}
                Expires in {daysLeft} day{daysLeft !== 1 ? 's' : ''}
              </p>
            </div>
            <button
              onClick={() => handleRevoke(inv.id)}
              disabled={revoking === inv.id}
              className="ml-3 px-3 py-1 text-sm text-status-error hover:bg-status-error/10 rounded disabled:opacity-50"
            >
              {revoking === inv.id ? 'Revoking...' : 'Revoke'}
            </button>
          </div>
        );
      })}
    </div>
  );
}

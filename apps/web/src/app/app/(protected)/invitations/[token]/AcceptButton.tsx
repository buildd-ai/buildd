'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function AcceptInvitationButton({ token }: { token: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleAccept() {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/invitations/${token}/accept`, {
        method: 'POST',
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to accept invitation');
        return;
      }

      router.push('/app/workspaces');
      router.refresh();
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        onClick={handleAccept}
        disabled={loading}
        className="w-full px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
      >
        {loading ? 'Accepting...' : 'Accept Invitation'}
      </button>
      {error && (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}

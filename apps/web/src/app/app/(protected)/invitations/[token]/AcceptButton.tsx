'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Notice from '@/components/ui/Notice';
import PrimaryAction from '@/components/ui/PrimaryAction';

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
        const data = await res.json().catch(() => ({} as { error?: string }));
        setError(data.error || 'Failed to accept invitation');
        return;
      }

      router.push('/app/home');
      router.refresh();
    } catch {
      setError('Could not reach buildd. The invitation is unchanged.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <PrimaryAction onClick={handleAccept} pending={loading} fullWidthOnMobile>
        {loading ? 'Accepting…' : 'Accept invitation'}
      </PrimaryAction>
      {error && <Notice tone="err">{error}</Notice>}
    </div>
  );
}

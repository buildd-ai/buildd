'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

export function InterruptReviewButton({ workerId }: { workerId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function interrupt() {
    setError(null);
    startTransition(async () => {
      const response = await fetch(`/api/workers/${workerId}/interrupt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        setError(result?.error ?? 'Could not interrupt agent review');
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="shrink-0 text-right">
      <button
        type="button"
        onClick={interrupt}
        disabled={pending}
        className="text-[11px] text-text-muted border border-border-default rounded-[6px] px-2.5 py-1.5 hover:border-status-error hover:text-status-error transition-colors bg-transparent whitespace-nowrap disabled:opacity-50"
      >
        {pending ? 'Interrupting…' : 'Interrupt & take over'}
      </button>
      {error && <p className="mt-1 max-w-44 text-[10px] text-status-error">{error}</p>}
    </div>
  );
}

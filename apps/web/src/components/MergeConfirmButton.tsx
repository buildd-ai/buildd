'use client';

import { useState } from 'react';

interface MergeConfirmButtonProps {
  prNumber: number;
  prUrl: string;
  /** Optional count of tasks that will unblock after merge */
  queuedTaskCount?: number;
  onMerged?: () => void;
  /** Extra CSS classes for the trigger button */
  className?: string;
  /** Label for the trigger button (default: "Merge") */
  label?: string;
  disabled?: boolean;
  disabledReason?: string;
}

type State = 'idle' | 'confirming' | 'merging' | 'merged' | 'error';

/**
 * BT-17: One-tap inline merge confirmation.
 * No modal. Shows [Merge] → [Cancel] [Confirm Merge] → [✓ Merged] inline.
 * Mobile-first: reachable in ≤2 taps, same tap-target footprint.
 */
export default function MergeConfirmButton({
  prNumber,
  prUrl: _prUrl,
  queuedTaskCount,
  onMerged,
  className = '',
  label = 'Merge',
  disabled = false,
  disabledReason,
}: MergeConfirmButtonProps) {
  const [state, setState] = useState<State>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const handleMerge = async () => {
    setState('merging');
    try {
      const res = await fetch(`/api/prs/${prNumber}/merge`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorMsg(data.error || 'Merge failed');
        setState('error');
        return;
      }
      setState('merged');
      onMerged?.();
      // Auto-reset after brief celebration
      setTimeout(() => setState('idle'), 3000);
    } catch {
      setErrorMsg('Network error');
      setState('error');
    }
  };

  if (state === 'merged') {
    return (
      <span className="inline-flex items-center gap-1 text-[12px] font-medium text-status-success">
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M20 6L9 17l-5-5" />
        </svg>
        Merged
      </span>
    );
  }

  if (state === 'confirming') {
    const confirmMsg = queuedTaskCount
      ? `Merging will unblock ${queuedTaskCount} queued task${queuedTaskCount === 1 ? '' : 's'}.`
      : 'Confirm merge?';
    return (
      <span className="inline-flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-text-secondary">{confirmMsg}</span>
        <button
          onClick={() => setState('idle')}
          className="text-[12px] font-medium text-text-muted hover:text-text-secondary transition-colors px-2 py-0.5 border border-border-default rounded"
        >
          Cancel
        </button>
        <button
          onClick={handleMerge}
          className="text-[12px] font-medium text-white bg-status-success hover:bg-status-success/90 transition-colors px-2.5 py-0.5 rounded"
        >
          Confirm Merge
        </button>
      </span>
    );
  }

  if (state === 'merging') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-text-muted">
        <span className="w-2.5 h-2.5 rounded-full border-2 border-status-success border-t-transparent animate-spin" />
        Merging…
      </span>
    );
  }

  if (state === 'error') {
    return (
      <span className="inline-flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-status-error">{errorMsg}</span>
        <button
          onClick={() => setState('idle')}
          className="text-[11px] text-text-muted hover:text-text-secondary underline"
        >
          Retry
        </button>
      </span>
    );
  }

  if (disabled) {
    return (
      <span
        title={disabledReason}
        className="inline-flex items-center gap-1 text-[12px] font-medium text-text-muted cursor-not-allowed opacity-60 px-2.5 py-0.5 border border-border-default rounded"
      >
        {label}
      </span>
    );
  }

  return (
    <button
      onClick={() => setState('confirming')}
      className={`inline-flex items-center gap-1 text-[12px] font-medium text-white bg-accent hover:bg-accent/90 transition-colors px-2.5 py-0.5 rounded ${className}`}
    >
      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 5v14m-7-7l7 7 7-7" />
      </svg>
      {label}
    </button>
  );
}

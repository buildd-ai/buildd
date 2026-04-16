'use client';

import { useState, useCallback } from 'react';

type EntityType = 'note' | 'artifact' | 'summary' | 'orchestration' | 'heartbeat';
type Signal = 'up' | 'down' | 'dismiss';

interface AiFeedbackProps {
  entityType: EntityType;
  entityId: string;
  onDismiss?: () => void;
  compact?: boolean;
  showDismiss?: boolean;
  initialSignal?: Signal | null;
}

export default function AiFeedback({
  entityType,
  entityId,
  onDismiss,
  compact = false,
  showDismiss = false,
  initialSignal = null,
}: AiFeedbackProps) {
  const [signal, setSignal] = useState<Signal | null>(initialSignal);
  const [sending, setSending] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [showUndo, setShowUndo] = useState(false);

  const sendFeedback = useCallback(async (newSignal: Signal) => {
    if (sending) return;
    setSending(true);
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityType, entityId, signal: newSignal }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.removed) {
          setSignal(null);
        } else {
          setSignal(data.signal);
        }

        if (newSignal === 'dismiss' && !data.removed) {
          setDismissed(true);
          setShowUndo(true);
          setTimeout(() => setShowUndo(false), 5000);
          onDismiss?.();
        }
      }
    } catch {
      // Silently fail — non-critical
    } finally {
      setSending(false);
    }
  }, [entityType, entityId, sending, onDismiss]);

  const undoDismiss = useCallback(async () => {
    setSending(true);
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityType, entityId, signal: 'dismiss' }),
      });
      if (res.ok) {
        setDismissed(false);
        setShowUndo(false);
        setSignal(null);
      }
    } catch {
      // Silently fail
    } finally {
      setSending(false);
    }
  }, [entityType, entityId]);

  if (dismissed && showUndo) {
    return (
      <div className={`flex items-center gap-2 ${compact ? 'text-[10px]' : 'text-[11px]'} text-text-muted`}>
        <span>Dismissed</span>
        <button
          onClick={undoDismiss}
          disabled={sending}
          className="text-accent-text hover:underline disabled:opacity-50"
        >
          Undo
        </button>
      </div>
    );
  }

  if (dismissed && !showUndo) {
    return null;
  }

  const btnBase = compact
    ? 'p-0.5 rounded transition-colors disabled:opacity-40'
    : 'p-1 rounded transition-colors disabled:opacity-40';

  const iconSize = compact ? 'w-3 h-3' : 'w-3.5 h-3.5';

  return (
    <div className={`inline-flex items-center ${compact ? 'gap-0.5' : 'gap-1'}`}>
      {/* Thumbs up */}
      <button
        onClick={() => sendFeedback('up')}
        disabled={sending}
        className={`${btnBase} ${
          signal === 'up'
            ? 'text-status-success bg-status-success/10'
            : 'text-text-muted hover:text-status-success hover:bg-status-success/5'
        }`}
        title="Helpful"
      >
        <svg className={iconSize} fill={signal === 'up' ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6.633 10.25c.806 0 1.533-.446 2.031-1.08a9.041 9.041 0 012.861-2.4c.723-.384 1.35-.956 1.653-1.715a4.498 4.498 0 00.322-1.672V3a.75.75 0 01.75-.75 2.25 2.25 0 012.25 2.25c0 1.152-.26 2.243-.723 3.218-.266.558.107 1.282.725 1.282h3.126c1.026 0 1.945.694 2.054 1.715.045.422.068.85.068 1.285a11.95 11.95 0 01-2.649 7.521c-.388.482-.987.729-1.605.729H14.23c-.483 0-.964-.078-1.423-.23l-3.114-1.04a4.501 4.501 0 00-1.423-.23H5.904m.729-14.456C5.726 10.896 5.25 12.637 5.25 14.457v.001c0 .85.069 1.683.2 2.496" />
        </svg>
      </button>

      {/* Thumbs down */}
      <button
        onClick={() => sendFeedback('down')}
        disabled={sending}
        className={`${btnBase} ${
          signal === 'down'
            ? 'text-status-error bg-status-error/10'
            : 'text-text-muted hover:text-status-error hover:bg-status-error/5'
        }`}
        title="Not helpful"
      >
        <svg className={iconSize} fill={signal === 'down' ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7.498 15.25H4.372c-1.026 0-1.945-.694-2.054-1.715A12.137 12.137 0 012.25 12.25c0-2.573.812-4.962 2.197-6.92.388-.482.987-.73 1.605-.73h2.138c.483 0 .964.078 1.423.23l3.114 1.04c.459.153.94.23 1.423.23h1.504c.618 0 1.217.247 1.605.729A11.95 11.95 0 0119.25 12.25c0 .436-.023.863-.068 1.285-.109 1.021-1.028 1.715-2.054 1.715h-3.126c-.618 0-.991.724-.725 1.282A7.471 7.471 0 0114 19.768a2.25 2.25 0 01-2.25 2.25.75.75 0 01-.75-.75v-.384c0-.568-.114-1.13-.322-1.672-.303-.759-.93-1.331-1.653-1.715a9.04 9.04 0 01-2.861-2.4c-.498-.634-1.226-1.08-2.032-1.08h-.634" />
        </svg>
      </button>

      {/* Dismiss */}
      {showDismiss && (
        <button
          onClick={() => sendFeedback('dismiss')}
          disabled={sending}
          className={`${btnBase} text-text-muted hover:text-text-secondary hover:bg-surface-3`}
          title="Dismiss"
        >
          <svg className={iconSize} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}

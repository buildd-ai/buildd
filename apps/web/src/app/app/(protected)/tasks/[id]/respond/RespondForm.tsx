'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Option = string | { label: string; description?: string; recommended?: boolean };

interface Props {
  workerId: string;
  options: Option[];
}

export default function RespondForm({ workerId, options }: Props) {
  const router = useRouter();
  const [sending, setSending] = useState<string | null>(null);
  const [showFreeText, setShowFreeText] = useState(false);
  const [freeText, setFreeText] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(message: string) {
    if (!message.trim()) return;
    setSending(message);
    setError(null);
    try {
      const res = await fetch(`/api/workers/${workerId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send answer');
      router.push(`/app/tasks/${data.taskId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send answer');
      setSending(null);
    }
  }

  return (
    <div className="mt-5 flex flex-col gap-2">
      {options.map((opt, i) => {
        const label = typeof opt === 'string' ? opt : opt.label;
        const description = typeof opt === 'string' ? undefined : opt.description;
        const recommended = typeof opt === 'string' ? false : opt.recommended;
        const isSending = sending === label;
        return (
          <button
            key={i}
            onClick={() => submit(label)}
            disabled={sending !== null}
            className="text-left px-4 py-3 text-sm bg-surface-3 text-text-primary rounded-md border border-border-default hover:bg-surface-4 hover:border-text-muted transition-colors disabled:opacity-50 cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <span className="font-medium">{isSending ? 'Sending…' : label}</span>
              {recommended && (
                <span className="text-[10px] font-mono uppercase tracking-wider text-status-success bg-status-success/10 px-1.5 py-0.5 rounded">
                  Recommended
                </span>
              )}
            </span>
            {description && (
              <span className="block mt-0.5 text-xs text-text-muted">{description}</span>
            )}
          </button>
        );
      })}

      {!showFreeText ? (
        <button
          onClick={() => setShowFreeText(true)}
          disabled={sending !== null}
          className="text-left px-4 py-3 text-sm bg-surface-2 text-text-muted rounded-md border border-border-default border-dashed hover:bg-surface-3 hover:text-text-primary hover:border-text-muted transition-colors disabled:opacity-50 cursor-pointer"
        >
          Type your own response ↓
        </button>
      ) : (
        <div className="flex flex-col gap-2">
          <textarea
            autoFocus
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="Your response…"
            rows={3}
            className="px-3 py-2 text-sm bg-surface-2 text-text-primary rounded-md border border-border-default focus:border-text-muted focus:outline-none resize-y"
          />
          <button
            onClick={() => submit(freeText)}
            disabled={sending !== null || !freeText.trim()}
            className="px-4 py-2 text-sm bg-text-primary text-surface-1 rounded-md font-medium hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer"
          >
            {sending ? 'Sending…' : 'Send response'}
          </button>
        </div>
      )}

      {error && (
        <p className="mt-1 text-xs text-status-error">{error}</p>
      )}
    </div>
  );
}

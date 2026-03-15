'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface WorkerRespondInputProps {
  workerId: string;
  question: string;
  options?: string[];
}

export default function WorkerRespondInput({
  workerId,
  question,
  options,
}: WorkerRespondInputProps) {
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleSubmit(value?: string) {
    const text = value ?? message;
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/workers/${workerId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text.trim() }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to respond');
      }

      setMessage('');
      router.refresh();
    } catch (err: any) {
      setError(err.message || 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-2 ml-5 space-y-2">
      {/* Question */}
      <div className="flex items-start gap-2">
        <span className="glow-dot glow-dot-warning mt-1 shrink-0" />
        <p className="text-[13px] text-status-warning leading-relaxed">
          {question}
        </p>
      </div>

      {/* Quick option buttons */}
      {options && options.length > 0 && (
        <div className="flex flex-wrap gap-1.5 ml-[18px]">
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              disabled={submitting}
              onClick={() => handleSubmit(opt)}
              className="px-2.5 py-1 rounded-sm bg-surface-3 border border-border-default text-[12px] text-text-secondary hover:text-accent-text hover:border-accent/40 transition-colors disabled:opacity-40"
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      {/* Text input + Send */}
      <div className="flex gap-2 ml-[18px]">
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder="Type your response..."
          disabled={submitting}
          className="flex-1 px-3 py-2 rounded-sm bg-surface-1 border border-border-default text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none transition-colors disabled:opacity-50"
        />
        <button
          type="button"
          disabled={submitting || !message.trim()}
          onClick={() => handleSubmit()}
          className="px-4 py-2 rounded-sm bg-accent/20 text-accent-text text-[13px] font-medium hover:bg-accent/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting ? 'Sending...' : 'Send'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <p className="text-[12px] text-status-error ml-[18px]">{error}</p>
      )}
    </div>
  );
}

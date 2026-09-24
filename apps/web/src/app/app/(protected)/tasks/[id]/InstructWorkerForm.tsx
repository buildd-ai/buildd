'use client';

import { useState } from 'react';

interface InstructWorkerFormProps {
  workerId: string;
  pendingInstructions?: string | null;
}

interface InstructResult {
  message: string;
  // 'delivered' here means "sent over Pusher, optimistically recorded" — the
  // runner never confirmed it, unlike 'pending' which is a real ack-backed
  // queue entry. See apps/web/src/app/api/workers/[id]/instruct/route.ts.
  deliveryState?: string;
}

// Exported for testing: renders the server-composed outcome message,
// styled as a warning for the unconfirmed Pusher-only delivery case.
export function InstructResultBanner({ result }: { result: InstructResult | null }) {
  if (!result) return null;
  const isUnconfirmed = result.deliveryState === 'delivered';
  return (
    <p
      data-testid="worker-instruct-result"
      className={`mt-2 text-sm ${isUnconfirmed ? 'text-status-warning' : 'text-status-success'}`}
    >
      {result.message}
    </p>
  );
}

export default function InstructWorkerForm({ workerId, pendingInstructions }: InstructWorkerFormProps) {
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<InstructResult | null>(null);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim()) return;

    setLoading(true);
    setError('');
    setResult(null);

    try {
      const res = await fetch(`/api/workers/${workerId}/instruct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message.trim(), priority: 'urgent' }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(data?.error || 'Failed to send instruction');
      }

      setMessage('');
      setResult({
        message: typeof data?.message === 'string' ? data.message : 'Instruction sent.',
        deliveryState: typeof data?.deliveryState === 'string' ? data.deliveryState : undefined,
      });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div data-testid="worker-instruct-form" className="mt-4 pt-4 border-t border-border-default">
      <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-2 mt-3">
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="e.g., Focus on edge cases, add more tests..."
          className="flex-1 px-3 py-2 text-sm border border-border-default rounded-md bg-surface-1 focus:ring-2 focus:ring-primary-ring focus:border-primary"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || !message.trim()}
          className="w-full sm:w-auto px-4 py-2 text-sm bg-primary text-white rounded-md hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Sending…' : 'Send'}
        </button>
      </form>

      <InstructResultBanner result={result} />
      {error && (
        <p className="mt-2 text-sm text-status-error">
          {error}
        </p>
      )}
    </div>
  );
}

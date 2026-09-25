'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import NeedsInputAnswerBox from '../NeedsInputAnswerBox';
import { respondRedirectHref } from './respond-links';

type Option = string | { label: string; description?: string; recommended?: boolean };

interface Props {
  workerId: string;
  /** The task's mission: an answered mission task returns to its row there. */
  missionId?: string | null;
  options: Option[];
}

export default function RespondForm({ workerId, missionId, options }: Props) {
  const router = useRouter();
  const [sending, setSending] = useState<string | null>(null);
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
      // On a resume this is the SAME task (the resumed worker continues under
      // it); on a cold continuation it is the new one. Either way it is where
      // the work now is. A task-less worker returns null — stay put rather than
      // navigating to a page that cannot exist. A mission task lands back on
      // its row in the mission (`#t-<task>`).
      const next = respondRedirectHref({ missionId, taskId: data.taskId });
      if (next) router.push(next);
      else router.refresh();
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
                <span className="text-[11px] md:text-[10px] font-mono uppercase tracking-wider text-status-success bg-status-success/10 px-1.5 py-0.5 rounded">
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

      <NeedsInputAnswerBox onSubmit={submit} sending={sending !== null} />

      {error && (
        <p className="mt-1 text-xs text-status-error">{error}</p>
      )}
    </div>
  );
}

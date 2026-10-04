'use client';

/**
 * Settings -> Profile -> "Show keyboard hints". Off by default. Turning it on
 * reveals the keycap chips (1/2/3 on a question, Esc, the chat shortcut)
 * everywhere; the shortcuts work either way. Stored per person
 * (PATCH /api/me/preferences) and read by the protected layout.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Switch from '@/components/ui/Switch';

export default function KeyboardHintsSetting({ initial }: { initial: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (next: boolean) => {
    const before = on;
    setOn(next);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/me/preferences', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showKeyboardHints: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      // The layout reads the flag on the server: re-render so the hints follow.
      router.refresh();
    } catch {
      setOn(before);
      setError("Couldn't save that. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="prefs-h">
      <h2 id="prefs-h" className="section-label mb-3">Preferences</h2>
      <div className="card flex items-start gap-4 p-4">
        <div className="min-w-0 flex-1">
          <p id="keyboard-hints-label" className="text-[14px] font-medium text-text-primary">Show keyboard hints</p>
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">
            For example 1 and 2 on a question, Esc to close.
          </p>
          {error && <p role="alert" className="mt-2 text-xs text-status-error">{error}</p>}
        </div>
        <Switch
          labelledBy="keyboard-hints-label"
          checked={on}
          onChange={(next) => { void save(next); }}
          disabled={busy}
          className="mt-0.5"
        />
      </div>
    </section>
  );
}

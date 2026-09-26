'use client';

/**
 * Rename, inside the mission Settings panel (F5).
 *
 * The masthead already shows the title, so Settings does not render it a
 * second time: it offers "Rename mission", which opens an input prefilled with
 * the current title. The description is not here — it has one place on the
 * page, under the masthead (`MissionDescription`).
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';

interface MissionInlineEditProps {
  missionId: string;
  initialTitle: string;
}

export default function MissionInlineEdit({ missionId, initialTitle }: MissionInlineEditProps) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  const [draft, setDraft] = useState(initialTitle);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Re-sync after a server refresh when the title changed elsewhere (not mid-edit).
  const [syncedFrom, setSyncedFrom] = useState(initialTitle);
  if (!editing && initialTitle !== syncedFrom) {
    setSyncedFrom(initialTitle);
    setTitle(initialTitle);
  }

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const save = useCallback(async () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === title) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: next }),
      });
      if (!res.ok) {
        setError('Rename failed');
        return;
      }
      setTitle(next);
      // The masthead (a server render) owns the visible title.
      router.refresh();
    } catch {
      setError('Rename failed');
    } finally {
      setSaving(false);
    }
  }, [draft, title, missionId, router]);

  if (editing) {
    return (
      <div className="flex items-center gap-3">
        <input
          ref={inputRef}
          value={draft}
          aria-label="Mission title"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
            if (e.key === 'Escape') {
              setDraft(title);
              setEditing(false);
            }
          }}
          className="min-h-11 w-full border border-border-default bg-surface-2 px-2 text-[14px] text-text-primary outline-none focus:border-accent-text"
        />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        data-testid="mission-rename"
        disabled={saving}
        onClick={() => {
          setDraft(title);
          setEditing(true);
        }}
        className="inline-flex min-h-11 items-center font-mono text-[12px] text-accent-text hover:underline disabled:opacity-60"
      >
        {saving ? 'Renaming…' : 'Rename mission'}
      </button>
      {error && <span className="font-mono text-[11px] text-status-error">{error}</span>}
    </div>
  );
}

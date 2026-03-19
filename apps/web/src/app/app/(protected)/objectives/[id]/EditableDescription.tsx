'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import MarkdownContent from '@/components/MarkdownContent';

export default function EditableDescription({
  missionId,
  initialDescription,
}: {
  missionId: string;
  initialDescription: string | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(initialDescription || '');
  const [saving, setSaving] = useState(false);

  async function save() {
    const trimmed = description.trim();
    if (trimmed === (initialDescription || '')) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: trimmed || null }),
      });
      setEditing(false);
      startTransition(() => router.refresh());
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">Description</h2>
        </div>
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          rows={6}
          className="w-full px-3 py-2 bg-surface-1 border border-border-default rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary resize-y font-mono"
          placeholder="Add a description (supports markdown)..."
          autoFocus
        />
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={save}
            disabled={saving}
            className="px-3 py-1.5 text-xs font-medium bg-primary text-white rounded-md hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={() => {
              setDescription(initialDescription || '');
              setEditing(false);
            }}
            className="px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">Description</h2>
        <button
          onClick={() => setEditing(true)}
          className="text-xs text-text-muted hover:text-text-primary transition-colors flex items-center gap-1"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          </svg>
          Edit
        </button>
      </div>
      {initialDescription ? (
        <MarkdownContent content={initialDescription} />
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="text-sm text-text-muted hover:text-text-secondary transition-colors"
        >
          Add a description...
        </button>
      )}
    </div>
  );
}

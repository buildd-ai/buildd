'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import MarkdownContent from '@/components/MarkdownContent';

interface HeartbeatChecklistEditorProps {
  objectiveId: string;
  checklist: string | null;
}

export default function HeartbeatChecklistEditor({ objectiveId, checklist }: HeartbeatChecklistEditorProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(checklist || '');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await fetch(`/api/missions/${objectiveId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ heartbeatChecklist: value.trim() || null }),
      });
      setEditing(false);
      startTransition(() => router.refresh());
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setValue(checklist || '');
    setEditing(false);
  }

  const disabled = saving || isPending;

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
          Heartbeat Checklist
        </h2>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="text-xs text-text-secondary hover:text-primary transition-colors"
          >
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          <textarea
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="Add a checklist for the heartbeat agent to follow...&#10;&#10;Example:&#10;- Check if CI is green&#10;- Verify no critical alerts&#10;- Review dependency updates"
            rows={8}
            className="w-full px-3 py-2 bg-surface-1 border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary resize-y font-mono"
            autoFocus
            disabled={disabled}
          />
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={disabled}
              className="px-3 py-1.5 text-xs font-medium bg-primary text-white rounded-md hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              onClick={handleCancel}
              disabled={disabled}
              className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : checklist ? (
        <div className="p-3 bg-surface-2 border border-border-default rounded-lg">
          <MarkdownContent content={checklist} />
        </div>
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="w-full p-3 border border-dashed border-border-default rounded-lg text-sm text-text-muted hover:border-primary/40 hover:text-primary transition-colors text-left"
        >
          Add a checklist...
        </button>
      )}
    </div>
  );
}

'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import MarkdownContent from '@/components/MarkdownContent';

interface HeartbeatChecklistEditorProps {
  missionId: string;
  checklist: string | null;
}

export default function HeartbeatChecklistEditor({ missionId, checklist }: HeartbeatChecklistEditorProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(checklist || '');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
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
    <div>
      <div className="flex items-center justify-between mb-2">
        <h2 className="section-label">Heartbeat Checklist</h2>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="text-[11px] text-text-secondary hover:text-accent-text transition-colors"
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
            className="w-full px-3 py-2 bg-surface-3 border border-card-border rounded-lg text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/40 resize-y font-mono transition-colors"
            autoFocus
            disabled={disabled}
          />
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={disabled}
              className="px-3 py-1.5 text-[12px] font-medium bg-accent/20 text-accent-text rounded-lg hover:bg-accent/30 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              onClick={handleCancel}
              disabled={disabled}
              className="px-3 py-1.5 text-[12px] text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : checklist ? (
        <div className="p-3 bg-card border border-card-border rounded-lg">
          <MarkdownContent content={checklist} />
        </div>
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="w-full p-3 border border-dashed border-card-border rounded-lg text-[12px] text-text-muted hover:border-accent/40 hover:text-accent-text transition-colors text-left"
        >
          Add a checklist...
        </button>
      )}
    </div>
  );
}

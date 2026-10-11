'use client';

import { useState } from 'react';

interface MaxConcurrentWorkersEditorProps {
  accountId: string;
  value: number;
  onUpdate: (newValue: number) => void;
  canEdit?: boolean;
}

export default function MaxConcurrentWorkersEditor({
  accountId,
  value,
  onUpdate,
  canEdit = false,
}: MaxConcurrentWorkersEditorProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [inputValue, setInputValue] = useState(String(value));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setError(null);
    const newValue = parseInt(inputValue, 10);

    if (!Number.isInteger(newValue) || newValue < 1 || newValue > 50) {
      setError('Must be a number between 1 and 50');
      return;
    }

    if (newValue === value) {
      setIsEditing(false);
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/accounts/${accountId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxConcurrentWorkers: newValue }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to update');
      }

      const data = await res.json();
      onUpdate(data.maxConcurrentWorkers);
      setIsEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setInputValue(String(value));
    setIsEditing(false);
    setError(null);
  };

  if (!isEditing) {
    return (
      <span
        onClick={() => canEdit && setIsEditing(true)}
        className={canEdit ? 'cursor-pointer hover:text-accent' : ''}
      >
        Workers: {value}
      </span>
    );
  }

  return (
    <div className="inline-flex items-center gap-2">
      <span>Workers:</span>
      <input
        type="number"
        min="1"
        max="50"
        value={inputValue}
        onChange={(e) => {
          setInputValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSave();
          if (e.key === 'Escape') handleCancel();
        }}
        autoFocus
        disabled={saving}
        className="w-16 px-2 py-0.5 bg-surface-3 border border-card-border text-meta text-text-primary focus:outline-none focus:border-accent/40 disabled:opacity-50"
      />
      <button
        onClick={handleSave}
        disabled={saving}
        className="btn btn-primary btn-sm"
      >
        {saving ? '…' : '✓'}
      </button>
      <button
        onClick={handleCancel}
        disabled={saving}
        className="px-2 py-0.5 text-chip font-medium bg-surface-3 border border-card-border text-text-secondary hover:bg-surface-4 transition-colors disabled:opacity-50"
      >
        ✕
      </button>
      {error && <span className="text-chip text-status-error ml-1">{error}</span>}
    </div>
  );
}

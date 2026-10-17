'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export default function RaiseBudgetButton({
  missionId,
  currentBudget,
}: {
  missionId: string;
  currentBudget: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentBudget ? parseFloat(currentBudget).toFixed(2) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    const parsed = parseFloat(value);
    if (isNaN(parsed) || parsed <= 0) {
      setError('Enter a valid amount');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ costBudgetUsd: parsed }),
      });
      if (res.ok) {
        setEditing(false);
        startTransition(() => router.refresh());
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to update budget');
      }
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="px-3 py-1 text-[12px] font-medium bg-status-error/10 text-status-error border border-status-error/30 rounded-sm hover:bg-status-error/20 transition-colors"
      >
        Raise budget
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-[12px] text-text-muted">$</span>
      <input
        type="number"
        min={0}
        step={0.01}
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') handleSave();
          if (e.key === 'Escape') setEditing(false);
        }}
        autoFocus
        disabled={saving || isPending}
        className="w-24 px-2 py-1 bg-surface-3 border border-card-border rounded text-[12px] text-text-primary focus:outline-none focus:border-accent/40 tabular-nums disabled:opacity-50"
      />
      <button
        onClick={handleSave}
        disabled={saving || isPending}
        className="px-2.5 py-1 text-[12px] font-medium bg-status-error text-white rounded-sm hover:bg-status-error/80 transition-colors disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button
        onClick={() => { setEditing(false); setError(''); }}
        disabled={saving}
        className="text-[12px] text-text-muted hover:text-text-secondary"
      >
        Cancel
      </button>
      {error && <span className="text-[11px] text-status-error">{error}</span>}
    </div>
  );
}

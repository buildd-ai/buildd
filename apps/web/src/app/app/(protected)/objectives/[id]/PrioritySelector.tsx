'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

const PRIORITIES = [
  { value: 0, label: 'Low' },
  { value: 5, label: 'Medium' },
  { value: 10, label: 'High' },
] as const;

export default function PrioritySelector({
  objectiveId,
  initialPriority,
}: {
  objectiveId: string;
  initialPriority: number;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [priority, setPriority] = useState(initialPriority);
  const [saving, setSaving] = useState(false);

  async function handleChange(value: number) {
    if (value === priority) return;
    setPriority(value);
    setSaving(true);
    try {
      await fetch(`/api/missions/${objectiveId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority: value }),
      });
      startTransition(() => router.refresh());
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      {PRIORITIES.map(p => {
        const isActive = priority === p.value;
        const baseClasses = 'px-2.5 py-1 text-xs font-medium rounded-full transition-colors disabled:opacity-50 cursor-pointer';
        const colorClasses = isActive
          ? p.value === 10
            ? 'bg-status-error/15 text-status-error border border-status-error/30'
            : p.value === 5
              ? 'bg-status-warning/15 text-status-warning border border-status-warning/30'
              : 'bg-surface-3 text-text-primary border border-border-default'
          : 'bg-transparent text-text-muted border border-transparent hover:bg-surface-3 hover:text-text-secondary';

        return (
          <button
            key={p.value}
            onClick={() => handleChange(p.value)}
            disabled={saving}
            className={`${baseClasses} ${colorClasses}`}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

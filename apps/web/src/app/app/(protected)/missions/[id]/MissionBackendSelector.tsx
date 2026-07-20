'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

type Backend = 'claude' | 'codex' | null;

const OPTIONS: { value: Backend; label: string }[] = [
  { value: null, label: 'Auto' },
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
];

/**
 * Per-mission default agent backend. Sets missions.defaultBackend, which every
 * task this mission generates inherits (unless the task sets its own backend).
 * "Auto" clears it, falling back to role/workspace defaults.
 */
export default function MissionBackendSelector({
  missionId,
  initialBackend,
}: {
  missionId: string;
  initialBackend: Backend;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [backend, setBackend] = useState<Backend>(initialBackend);
  const [saving, setSaving] = useState(false);

  async function handleChange(value: Backend) {
    if (value === backend) return;
    setBackend(value);
    setSaving(true);
    try {
      await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ backend: value }),
      });
      startTransition(() => router.refresh());
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-medium text-text-muted">Backend</span>
      <div className="flex items-center gap-1">
        {OPTIONS.map((o) => {
          const isActive = backend === o.value;
          const base = 'px-2 py-0.5 text-[11px] font-medium rounded-full transition-colors disabled:opacity-50 cursor-pointer border';
          const cls = isActive
            ? 'bg-status-info/15 text-status-info border-status-info/30'
            : 'bg-transparent text-text-muted border-transparent hover:bg-surface-3 hover:text-text-secondary';
          return (
            <button key={o.label} onClick={() => handleChange(o.value)} disabled={saving} className={`${base} ${cls}`}>
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

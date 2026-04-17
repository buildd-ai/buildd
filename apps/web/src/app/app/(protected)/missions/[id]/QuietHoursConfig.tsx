'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { formatHour } from '@/lib/heartbeat-helpers';
import { Select } from '@/components/ui/Select';

interface QuietHoursConfigProps {
  missionId: string;
  activeHoursStart: number | null;
  activeHoursEnd: number | null;
  activeHoursTimezone: string | null;
}

export default function QuietHoursConfig({
  missionId,
  activeHoursStart,
  activeHoursEnd,
  activeHoursTimezone,
}: QuietHoursConfigProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);

  const enabled = activeHoursStart !== null && activeHoursEnd !== null;
  const [start, setStart] = useState(activeHoursStart ?? 22);
  const [end, setEnd] = useState(activeHoursEnd ?? 8);
  const [timezone, setTimezone] = useState(activeHoursTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone);

  async function save(body: Record<string, unknown>) {
    setSaving(true);
    try {
      await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      startTransition(() => router.refresh());
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle() {
    if (enabled) {
      await save({ activeHoursStart: null, activeHoursEnd: null, activeHoursTimezone: null });
    } else {
      await save({ activeHoursStart: start, activeHoursEnd: end, activeHoursTimezone: timezone });
    }
  }

  async function handleChange(field: string, value: number | string) {
    const updates: Record<string, unknown> = {};
    if (field === 'start') {
      setStart(value as number);
      updates.activeHoursStart = value;
    } else if (field === 'end') {
      setEnd(value as number);
      updates.activeHoursEnd = value;
    } else if (field === 'timezone') {
      setTimezone(value as string);
      updates.activeHoursTimezone = value;
    }
    await save(updates);
  }

  const disabled = saving || isPending;
  const hours = Array.from({ length: 24 }, (_, i) => i);

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
          </svg>
          <span className="text-[13px] font-medium text-text-primary">Quiet Hours</span>
        </div>
        <button
          onClick={handleToggle}
          disabled={disabled}
          className={`relative w-9 h-5 rounded-full transition-colors ${enabled ? 'bg-status-success/60' : 'bg-surface-3 border border-card-border'}`}
        >
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${enabled ? 'left-[18px]' : 'left-0.5'}`} />
        </button>
      </div>

      <p className="text-[11px] text-text-muted mt-1">
        When enabled, this mission pauses during these hours.
      </p>

      {enabled && (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-3 text-[12px]">
            <label className="text-text-secondary w-12 shrink-0">From</label>
            <Select
              value={String(start)}
              onChange={v => handleChange('start', parseInt(v))}
              disabled={disabled}
              options={hours.map(h => ({ value: String(h), label: formatHour(h) }))}
              size="sm"
            />
            <label className="text-text-secondary w-6 shrink-0">to</label>
            <Select
              value={String(end)}
              onChange={v => handleChange('end', parseInt(v))}
              disabled={disabled}
              options={hours.map(h => ({ value: String(h), label: formatHour(h) }))}
              size="sm"
            />
          </div>
          <div className="flex items-center gap-3 text-[12px]">
            <label className="text-text-secondary w-12 shrink-0">Zone</label>
            <input
              type="text"
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              onBlur={() => handleChange('timezone', timezone)}
              disabled={disabled}
              className="flex-1 px-2 py-1 bg-surface-3 border border-card-border rounded-lg text-[11px] text-text-primary focus:outline-none focus:border-accent/40 font-mono transition-colors"
            />
          </div>
          <p className="text-[11px] text-text-muted">
            Paused from {formatHour(start)} to {formatHour(end)} ({timezone})
          </p>
        </div>
      )}
    </div>
  );
}

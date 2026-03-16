'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { formatHour } from './heartbeat-helpers';

interface ActiveHoursConfigProps {
  objectiveId: string;
  activeHoursStart: number | null;
  activeHoursEnd: number | null;
  activeHoursTimezone: string | null;
}

export default function ActiveHoursConfig({
  objectiveId,
  activeHoursStart,
  activeHoursEnd,
  activeHoursTimezone,
}: ActiveHoursConfigProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);

  const enabled = activeHoursStart !== null && activeHoursEnd !== null;
  const [start, setStart] = useState(activeHoursStart ?? 8);
  const [end, setEnd] = useState(activeHoursEnd ?? 22);
  const [timezone, setTimezone] = useState(activeHoursTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone);

  async function save(body: Record<string, unknown>) {
    setSaving(true);
    try {
      await fetch(`/api/missions/${objectiveId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
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
    <div className="mb-6 p-3 bg-surface-2 rounded-lg border border-border-default">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
          </svg>
          <span className="text-sm font-medium text-text-primary">Active Hours</span>
        </div>
        <button
          onClick={handleToggle}
          disabled={disabled}
          className={`relative w-9 h-5 rounded-full transition-colors ${enabled ? 'bg-primary' : 'bg-surface-3 border border-border-default'}`}
        >
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${enabled ? 'left-[18px]' : 'left-0.5'}`} />
        </button>
      </div>

      {enabled && (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-3 text-sm">
            <label className="text-text-secondary w-12 shrink-0">From</label>
            <select
              value={start}
              onChange={e => handleChange('start', parseInt(e.target.value))}
              disabled={disabled}
              className="px-2 py-1 bg-surface-1 border border-border-default rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {hours.map(h => (
                <option key={h} value={h}>{formatHour(h)}</option>
              ))}
            </select>
            <label className="text-text-secondary w-6 shrink-0">to</label>
            <select
              value={end}
              onChange={e => handleChange('end', parseInt(e.target.value))}
              disabled={disabled}
              className="px-2 py-1 bg-surface-1 border border-border-default rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {hours.map(h => (
                <option key={h} value={h}>{formatHour(h)}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <label className="text-text-secondary w-12 shrink-0">Zone</label>
            <input
              type="text"
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              onBlur={() => handleChange('timezone', timezone)}
              disabled={disabled}
              className="flex-1 px-2 py-1 bg-surface-1 border border-border-default rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-primary font-mono"
            />
          </div>
          <p className="text-xs text-text-muted">
            Active from {formatHour(start)} to {formatHour(end)} ({timezone})
          </p>
        </div>
      )}
    </div>
  );
}

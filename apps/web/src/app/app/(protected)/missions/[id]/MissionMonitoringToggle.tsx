'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { timeAgo } from '@/lib/mission-helpers';

interface MissionMonitoringToggleProps {
  missionId: string;
  initialStatus: string;
  hasSchedule: boolean;
  schedule: { nextRunAt: string | null; lastRunAt: string | null } | null;
  orchestrationMode: 'auto' | 'manual';
}

export default function MissionMonitoringToggle({
  missionId,
  initialStatus,
  hasSchedule,
  schedule,
  orchestrationMode,
}: MissionMonitoringToggleProps) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [loading, setLoading] = useState(false);

  const nextRunAtMs = schedule?.nextRunAt ? new Date(schedule.nextRunAt).getTime() : null;
  const isNextOverdue = status === 'active' && nextRunAtMs != null && nextRunAtMs < Date.now();
  const overdueMinutes = isNextOverdue && nextRunAtMs != null ? Math.floor((Date.now() - nextRunAtMs) / 60000) : 0;

  if (!hasSchedule) return null;

  async function handleToggle() {
    setLoading(true);
    try {
      const res = await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: status === 'active' ? 'paused' : 'active' }),
      });
      if (res.ok) {
        setStatus(status === 'active' ? 'paused' : 'active');
        router.refresh();
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-3">
        <button
          onClick={handleToggle}
          disabled={loading}
          className="group relative flex items-center"
          aria-label={status === 'active' ? 'Pause monitoring' : 'Resume monitoring'}
        >
          <span
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ${
              status === 'active' ? 'bg-status-success/60' : 'bg-surface-3'
            } ${loading ? 'opacity-50' : ''}`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                status === 'active' ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </span>
        </button>
        <div className="min-w-0">
          <span className="text-[12px] text-text-secondary">
            {status === 'active' ? 'Monitoring active' : 'Monitoring paused'}
          </span>
          {status === 'active' && (
            <span className="ml-2 text-[11px] text-text-muted">
              {schedule?.lastRunAt && <span>Last: {timeAgo(schedule.lastRunAt)}</span>}
              {schedule?.nextRunAt && orchestrationMode !== 'manual' && (
                isNextOverdue
                  ? <span className="text-status-warning"> · Overdue by {overdueMinutes}m</span>
                  : <span> · Next: {timeAgo(schedule.nextRunAt)}</span>
              )}
            </span>
          )}
        </div>
      </div>
      <p className="text-[11px] text-text-muted">
        Enables automatic heartbeat checks on the configured schedule.
      </p>
    </div>
  );
}

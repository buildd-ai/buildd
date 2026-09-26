'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { timeAgo } from '@/lib/mission-helpers';
import Switch from '@/components/ui/Switch';

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
        <Switch checked={status === 'active'} onChange={() => handleToggle()} disabled={loading} label="Monitoring" />
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
        Runs heartbeat checks on the configured schedule.
      </p>
    </div>
  );
}

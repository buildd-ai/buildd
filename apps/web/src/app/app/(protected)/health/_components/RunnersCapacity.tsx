'use client';

/**
 * The top of Health › Runners: the shared Capacity block fed by the same
 * /api/fleet/occupancy read the usage chart uses (no new data read), with the
 * shared IdleAlert under it only when slots sat idle while work waited.
 */
import { useEffect, useState } from 'react';
import Capacity, { type CapacityWindow } from '@/components/ui/Capacity';
import IdleAlert from '@/components/ui/IdleAlert';
import type { OccupancySeries } from '@/lib/fleet-occupancy';

export interface RunnersCapacityProps {
  running: number;
  total: number;
  runnersOnline: number;
  totalRunners: number;
  sessions: number;
  workspaceId?: string | null;
  /** Free slots now and tasks that could start on them; the alert renders only when both are above zero. */
  idleSlots?: number;
  queuedTasks?: number;
}

const fmt = (n: number) => Math.round(n * 10) / 10;

export function RunnersCapacity({ running, total, runnersOnline, totalRunners, sessions, workspaceId, idleSlots = 0, queuedTasks = 0 }: RunnersCapacityProps) {
  const [window, setWindow] = useState<CapacityWindow>('24h');
  const [series, setSeries] = useState<OccupancySeries | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const qs = new URLSearchParams({ window, tzOffset: String(-new Date().getTimezoneOffset()) });
    if (workspaceId) qs.set('workspace', workspaceId);
    fetch(`/api/fleet/occupancy?${qs}`, { signal: ctrl.signal })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((s: OccupancySeries) => setSeries(s))
      .catch(() => { if (!ctrl.signal.aborted) setSeries(null); });
    return () => ctrl.abort();
  }, [window, workspaceId]);

  return (
    <div data-testid="health-section-capacity" className="mb-6 flex flex-col gap-3">
      <Capacity
        running={running}
        total={total}
        runnersOnline={runnersOnline}
        totalRunners={totalRunners}
        sessions={sessions}
        peak={series?.summary.runner.peak ?? 0}
        average={fmt(series?.summary.runner.avg ?? 0)}
        chart={series?.buckets.map(b => b.runner.peak) ?? []}
        window={window}
        onWindowChange={setWindow}
      />
      <IdleAlert idleSlots={idleSlots} queuedTasks={queuedTasks} cause="nothing picked it up" />
    </div>
  );
}

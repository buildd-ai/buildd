'use client';

import { useState } from 'react';
import { slotsInUse } from '@buildd/shared';
import Segmented from './Segmented';

export type CapacityWindow = '24h' | '7d' | '30d';

/**
 * Already-computed numbers; nothing here fetches. The Queue Running tile takes
 * the same props (`CapacityProps`) so both read one set of figures.
 */
export interface CapacityProps {
  /** Slots in use now. */
  running: number;
  /** Slots in total. */
  total: number;
  runnersOnline: number;
  totalRunners: number;
  /** Claude Code sessions: separate from slots, never summed into them. */
  sessions: number;
  peak: number;
  average: number;
  /** Busy slots per bucket over the window; 0 is an idle stretch. */
  chart: number[];
  window?: CapacityWindow;
  onWindowChange?: (window: CapacityWindow) => void;
}

const WINDOWS = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
] as const;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** `2 of 3 runners online · plus 2 Claude Code sessions`; sessions are dropped at zero. */
export function runnersLine(online: number, total: number, sessions: number): string {
  const base = `${online} of ${total} ${plural(total, 'runner', 'runners')} online`;
  return sessions > 0 ? `${base} · plus ${sessions} Claude Code ${plural(sessions, 'session', 'sessions')}` : base;
}

/** `Peak 5 · average 3 · over 24h` */
export function peakLine(peak: number, average: number, window: CapacityWindow): string {
  return `Peak ${peak} · average ${average} · over ${window}`;
}

export default function Capacity({
  running,
  total,
  runnersOnline,
  totalRunners,
  sessions,
  peak,
  average,
  chart,
  window = '24h',
  onWindowChange,
}: CapacityProps) {
  const [current, setCurrent] = useState<CapacityWindow>(window);
  const scale = Math.max(total, ...chart, 1);
  const idleStretches = chart.filter(v => v <= 0).length;

  return (
    <div className="flex w-full flex-col gap-3 font-sans text-[var(--text-primary)]" data-testid="capacity">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-mono text-heading font-semibold leading-tight" data-testid="capacity-headline">
            {slotsInUse(running, total)}
          </span>
          <span className="text-body text-[var(--text-secondary)]" data-testid="capacity-runners">
            {runnersLine(runnersOnline, totalRunners, sessions)}
          </span>
          <span className="text-meta text-[var(--text-secondary)]" data-testid="capacity-peak">
            {peakLine(peak, average, current)}
          </span>
        </div>
        <Segmented
          label="Window"
          items={WINDOWS}
          value={current}
          onChange={w => {
            setCurrent(w);
            onWindowChange?.(w);
          }}
        />
      </div>

      <div
        role="img"
        aria-label={`Busy slots over ${current}: peak ${peak}, ${idleStretches} idle ${plural(idleStretches, 'stretch', 'stretches')} with no slot in use`}
        data-testid="capacity-chart"
        className="grid h-12 items-end gap-0.5 border-b border-[var(--border)]"
        style={{ gridTemplateColumns: `repeat(${Math.max(chart.length, 1)}, minmax(0, 1fr))` }}
      >
        {chart.map((value, i) => {
          const idle = value <= 0;
          return idle ? (
            // Idle: a short hatched, outlined stub. Pattern and outline, not colour, set it apart.
            <span
              key={i}
              data-idle="true"
              className="block h-1.5 rounded-t-none border border-dashed border-[var(--border-strong)]"
              style={{
                backgroundImage:
                  'repeating-linear-gradient(45deg, var(--border-strong) 0 1px, transparent 1px 3px)',
              }}
            />
          ) : (
            <span
              key={i}
              data-idle="false"
              className="block rounded-t-none bg-[var(--text-secondary)]"
              style={{ height: `${Math.max((value / scale) * 100, 8)}%` }}
            />
          );
        })}
      </div>
    </div>
  );
}

export { Capacity };

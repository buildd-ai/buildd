'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import type { MissionFlightStripData, WorkLane } from '@buildd/core/mission-helpers';
import { FlightStrip, FLIGHT_STRIP_NOW_COLOR } from '@/components/FlightStrip';

const LANE_LABEL: Record<WorkLane, string> = { think: 'THINK', build: 'BUILD', check: 'CHECK' };

export interface FlightStripNavTask {
  id: string;
  title: string;
  href: string;
  lane: WorkLane | null;
  status: string;
  prNumber: number | null;
  artifacts: Array<{ id: string; type: string; title: string | null }>;
}

export interface FlightStripNavGroup {
  index: number | null;
  label: string | null;
  tasks: FlightStripNavTask[];
}

export interface MissionFlightStripNavProps {
  data: MissionFlightStripData;
  groups: FlightStripNavGroup[];
  orchestratorPlans: number;
  orchestratorTicks: number;
  records: Array<{ id: string; title: string | null; type: string }>;
  recordsHref: string;
  width?: number;
}

/**
 * The flight strip as page navigator (docs/design/mission-flight-strip.md
 * §7): the SVG pinned under the title, and the task list beneath it grouped
 * by stored mission phase and tagged by lane. Tapping a bar scrolls to and
 * outlines its task row, and vice versa — one selection state, two views of
 * the same task.
 */
export default function MissionFlightStripNav({
  data,
  groups,
  orchestratorPlans,
  orchestratorTicks,
  records,
  recordsHref,
  // Wider geometry than the compact card strip (322px) — the
  // design:flight-strip/mission-detail board's viewBox is 358 wide.
  width = 358,
}: MissionFlightStripNavProps) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());

  function selectFromBar(taskId: string) {
    setSelectedTaskId(taskId);
    rowRefs.current.get(taskId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function selectFromRow(taskId: string) {
    setSelectedTaskId(prev => (prev === taskId ? null : taskId));
  }

  const ungrouped = groups.length === 1 && groups[0].index === null && groups[0].label === null;

  return (
    <div className="mb-6">
      <div className="border-y-2 border-border-default bg-surface-2 py-2.5 px-3 -mx-4 md:-mx-10 md:px-10">
        <FlightStrip data={data} width={width} selectedTaskId={selectedTaskId} onBarSelect={selectFromBar} />
      </div>

      {(orchestratorPlans > 0 || records.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[11px] text-text-muted font-mono">
          {orchestratorPlans > 0 && (
            <span>Orchestrator · {orchestratorPlans} plan{orchestratorPlans !== 1 ? 's' : ''}, {orchestratorTicks} tick{orchestratorTicks !== 1 ? 's' : ''}</span>
          )}
          {records.length > 0 && (
            <a href={recordsHref} className="text-accent-text hover:underline">
              Records · {records.length}
            </a>
          )}
        </div>
      )}

      <div className="mt-3">
        {groups.map(group => (
          <div key={group.index ?? 'ungrouped'}>
            {!ungrouped && (
              <div className="flex items-center justify-between min-h-9 text-[11px] tracking-wide text-text-muted uppercase border-t border-border-default pt-2 mt-2 first:border-t-0 first:mt-0 first:pt-0">
                <span>{group.label ?? 'Unphased'}</span>
              </div>
            )}
            {group.tasks.map(task => {
              const isSelected = task.id === selectedTaskId;
              return (
                <div
                  key={task.id}
                  ref={el => {
                    if (el) rowRefs.current.set(task.id, el);
                    else rowRefs.current.delete(task.id);
                  }}
                  onClick={() => selectFromRow(task.id)}
                  className="flex items-start gap-2.5 py-2.5 border-t border-border-default first:border-t-0 cursor-pointer touch-manipulation"
                  style={isSelected ? { outline: `2px solid ${FLIGHT_STRIP_NOW_COLOR}`, outlineOffset: '2px' } : undefined}
                >
                  <span className="shrink-0 w-11 text-[9px] font-mono text-text-muted pt-0.5">
                    {task.lane ? LANE_LABEL[task.lane] : ''}
                  </span>
                  <div className="flex-1 min-w-0">
                    <Link
                      href={task.href}
                      onClick={e => e.stopPropagation()}
                      className="text-[13px] leading-snug text-text-primary hover:text-accent-text transition-colors"
                    >
                      {task.title}
                    </Link>
                    {task.artifacts.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {task.artifacts.map(a => (
                          <span key={a.id} className="text-[10px] font-mono text-text-muted px-1 border border-border-default rounded-sm">
                            {a.title ?? a.type}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {task.prNumber != null && (
                    <span className="shrink-0 text-[11px] font-mono text-status-success">#{task.prNumber}</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

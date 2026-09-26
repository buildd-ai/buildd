'use client';

/**
 * Board · Lanes · Feed. The shell mounts one layout at a time and switches on
 * the client: the tab writes `?layout=` with `replaceState` (never the router,
 * so the `force-dynamic` render does not re-run and the task sheet's own
 * history entries are left alone).
 *
 * Board and Lanes share `MissionBoardHeader`; the Feed keeps its masthead and
 * carries the same tabs in it.
 */
import Link from 'next/link';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { MISSION_LAYOUTS, MISSION_LAYOUT_LABEL, missionLayoutHref, type MissionLayout } from '@/lib/mission-layout';
import type { MastheadChip } from '@/components/missions/MissionMasthead';
import { formatClock } from '@/lib/mission-board';
import { useNow } from './MissionBoardParts';

const LayoutContext = createContext<{ layout: MissionLayout; setLayout: (l: MissionLayout) => void } | null>(null);

export function MissionLayoutTabs({ className = '' }: { className?: string }) {
  const ctx = useContext(LayoutContext);
  if (!ctx) return null;
  return (
    <div role="tablist" aria-label="Mission layout" data-testid="mission-layout-tabs" className={`flex shrink-0 border-[1.5px] border-border-strong ${className}`}>
      {MISSION_LAYOUTS.map(l => {
        const on = ctx.layout === l;
        return (
          <button
            key={l}
            type="button"
            role="tab"
            aria-selected={on}
            data-layout={l}
            onClick={() => ctx.setLayout(l)}
            className={`min-h-8 px-2.5 font-mono text-[11px] font-semibold uppercase tracking-[0.6px] ${on ? 'bg-text-primary text-surface-1' : 'text-text-muted hover:text-text-primary'}`}
          >
            {MISSION_LAYOUT_LABEL[l]}
          </button>
        );
      })}
    </div>
  );
}

export interface MissionLayoutShellProps {
  initial: MissionLayout;
  board: ReactNode;
  lanes: ReactNode;
  feed: ReactNode;
}

export default function MissionLayoutShell({ initial, board, lanes, feed }: MissionLayoutShellProps) {
  const [layout, set] = useState<MissionLayout>(initial);
  const setLayout = useCallback((l: MissionLayout) => {
    set(l);
    try {
      window.history.replaceState(window.history.state, '', missionLayoutHref(window.location.href, l));
    } catch {
      // A sandboxed frame can refuse history writes; the tab still switches.
    }
  }, []);
  const value = useMemo(() => ({ layout, setLayout }), [layout, setLayout]);
  return (
    <LayoutContext.Provider value={value}>
      <div data-testid="mission-layout" data-layout={layout}>
        {layout === 'board' ? board : layout === 'lanes' ? lanes : feed}
      </div>
    </LayoutContext.Provider>
  );
}

export interface MissionBoardHeaderProps {
  back: { label: string; href: string };
  title: string;
  chip: MastheadChip;
  /** The Verified pill (opens goal criteria). */
  verified?: ReactNode;
  actions?: ReactNode;
  /** Plain-text goal line under the title. */
  goal?: string | null;
  serverNow: number;
  startedAt: number;
  /** Set once complete: the clock reads `took` and stops. */
  endedAt?: number | null;
  children?: ReactNode;
}

/** The Board/Lanes header: back, title, state, clock, layout tabs, overflow; the goal line under it. */
export function MissionBoardHeader({ back, title, chip, verified, actions, goal, serverNow, startedAt, endedAt, children }: MissionBoardHeaderProps) {
  const now = useNow(serverNow, 1_000, endedAt == null);
  const done = endedAt != null;
  return (
    <div data-testid="mission-detail" className="px-4 pb-12 pt-4 md:px-8 md:pt-[22px]">
      <header data-testid="mission-board-header" className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
        <Link href={back.href} className="font-mono text-[13px] text-text-muted hover:text-text-primary">{`‹ ${back.label}`}</Link>
        <h1 className="min-w-0 truncate font-mono text-[20px] font-semibold tracking-[-0.2px] text-text-primary md:text-[22px]">{title}</h1>
        <span data-testid="mission-state-chip" className={`inline-flex h-[22px] shrink-0 items-center gap-1.5 border-[1.5px] px-2 font-mono text-[11px] md:text-[10.5px] font-bold uppercase tracking-[1.2px] ${chip.cls}`}>
          {!done && <span aria-hidden="true" className="h-2 w-2 animate-status-pulse bg-current" />}
          {chip.label}
        </span>
        {verified}
        <span className="flex-1" />
        <span data-testid="mission-clock" className="font-mono text-[13px] text-text-secondary">
          {done ? 'took ' : 'T+ '}
          <b className="font-semibold tabular-nums text-text-primary">{formatClock((done ? endedAt! : now) - startedAt)}</b>
        </span>
        <MissionLayoutTabs />
        {actions}
      </header>
      {goal && <p className="mt-1.5 max-w-[90ch] truncate font-mono text-[12.5px] text-text-muted">{goal}</p>}
      {children}
    </div>
  );
}

'use client';

/**
 * Overview · Flow · History. The shell mounts one layout at a time and switches on
 * the client: the tab writes `?layout=` with `replaceState` (never the router,
 * so the `force-dynamic` render does not re-run and the task sheet's own
 * history entries are left alone).
 *
 * Board and Flow share `MissionBoardHeader`; the Feed keeps its masthead and
 * carries the same tabs in it.
 */
import Link from 'next/link';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { MISSION_LAYOUT_TABS, MISSION_LAYOUT_LABEL, missionLayoutHref, type MissionLayout } from '@/lib/mission-layout';
import type { MastheadChip } from '@/components/missions/MissionMasthead';
import { formatClock } from '@/lib/mission-board';
import { describeMissionDuration, formatDuration } from '@/lib/mission-duration';
import { useNow } from './MissionBoardParts';
import MissionSheetRow from './MissionSheetRow';

const LayoutContext = createContext<{ layout: MissionLayout; setLayout: (l: MissionLayout) => void } | null>(null);

export function MissionLayoutTabs({ className = '' }: { className?: string }) {
  const ctx = useContext(LayoutContext);
  if (!ctx) return null;
  return (
    <div role="tablist" aria-label="Mission layout" data-testid="mission-layout-tabs" className={`inline-flex shrink-0 gap-0.5 rounded-[var(--radius-card)] bg-[var(--q-tint)] p-[3px] ${className}`}>
      {MISSION_LAYOUT_TABS.map(l => {
        const on = ctx.layout === l;
        return (
          <button
            key={l}
            type="button"
            role="tab"
            aria-selected={on}
            data-layout={l}
            onClick={() => ctx.setLayout(l)}
            className={`min-h-11 rounded-[var(--radius-pill)] px-3 text-body md:min-h-8 ${on ? 'bg-card font-semibold text-text-primary outline outline-1 outline-[var(--border)]' : 'font-medium text-text-muted hover:text-text-primary'}`}
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
  flow: ReactNode;
  feed: ReactNode;
}

export default function MissionLayoutShell({ initial, board, flow, feed }: MissionLayoutShellProps) {
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
        {layout === 'board' ? board : layout === 'flow' ? flow : feed}
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
  /** Plain-text goal line under the title: one sentence (`missionSummaryLine`). */
  goal?: string | null;
  /** The full description, behind a "Description" control beside the goal line. */
  description?: ReactNode;
  serverNow: number;
  startedAt: number;
  /** Set once complete: the clock stops. */
  endedAt?: number | null;
  /** Wall time agents worked (`MissionBoardModel.activeMs`). Absent: the open span is the work. */
  activeMs?: number | null;
  children?: ReactNode;
}

const DAY_MS = 86_400_000;

/**
 * The header clock. Under a day of a live mission: `T+ 11:50`, ticking. Past
 * that, or once complete, work and open time in readable units — `40m of work
 * · open 35d`, or `took 38m` when the two are about the same.
 */
export function MissionClock({ startedAt, endedAt, activeMs, now }: { startedAt: number; endedAt?: number | null; activeMs?: number | null; now: number }) {
  const done = endedAt != null;
  const openMs = (done ? endedAt! : now) - startedAt;
  if (!done && openMs < DAY_MS) {
    return (
      <span data-testid="mission-clock" className="font-mono text-[13px] text-text-secondary">
        {'T+ '}<b className="font-semibold tabular-nums text-text-primary">{formatClock(openMs)}</b>
      </span>
    );
  }
  const d = describeMissionDuration({ activeMs: activeMs === undefined ? openMs : activeMs, openMs });
  return (
    <span data-testid="mission-clock" title={`Agents worked ${d.work ?? 'no time'}; open ${formatDuration(openMs)}`} className="font-mono text-[13px] text-text-secondary">
      {d.work == null ? (
        <>{'open '}<b className="font-semibold tabular-nums text-text-primary">{d.open}</b></>
      ) : d.showOpen ? (
        <><b className="font-semibold tabular-nums text-text-primary">{d.work}</b>{' of work · open '}<b className="font-semibold tabular-nums text-text-primary">{d.open}</b></>
      ) : (
        <>{'took '}<b className="font-semibold tabular-nums text-text-primary">{d.work}</b></>
      )}
    </span>
  );
}

/** The Board/Flow header: back, title, state, clock, layout tabs, overflow; the goal line under it. */
export function MissionBoardHeader({ back, title, chip, verified, actions, goal, description, serverNow, startedAt, endedAt, activeMs, children }: MissionBoardHeaderProps) {
  const now = useNow(serverNow, 1_000, endedAt == null);
  const done = endedAt != null;
  return (
    <div data-testid="mission-detail" className="max-w-[1120px] px-4 pb-12 pt-4 md:px-8 md:pt-[22px]">
      <header data-testid="mission-board-header" className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
        <Link href={back.href} className="font-mono text-[13px] text-text-muted hover:text-text-primary">{`‹ ${back.label}`}</Link>
        <h1 className="min-w-0 truncate font-mono text-[20px] font-semibold tracking-[-0.2px] text-text-primary md:text-[22px]">{title}</h1>
        <span data-testid="mission-state-chip" className={`inline-flex h-[22px] shrink-0 items-center gap-1.5 border-[1.5px] px-2 font-mono text-[11px] md:text-[10.5px] font-bold uppercase tracking-[1.2px] ${chip.cls}`}>
          {!done && <span aria-hidden="true" className="h-2 w-2 animate-status-pulse bg-current" />}
          {chip.label}
        </span>
        {verified}
        <span className="flex-1" />
        <MissionClock startedAt={startedAt} endedAt={endedAt} activeMs={activeMs} now={now} />
        <MissionLayoutTabs />
        {actions}
      </header>
      {(goal || description) && (
        <div className="mt-1.5 flex min-w-0 max-w-[110ch] flex-wrap items-baseline gap-x-3 gap-y-0.5 md:flex-nowrap">
          {/* Clamped at every width: a full goal on a phone pushes the strip several screens down. The full text is behind Description. */}
          {goal && <p data-testid="mission-goal-line" title={goal} className="min-w-0 break-words font-mono text-[12.5px] text-text-secondary max-md:line-clamp-3 md:truncate">{goal}</p>}
          {description && (
            <MissionSheetRow inline label="Description" title="Description" testId="mission-description-open" sheetTestId="mission-description-sheet">
              {description}
            </MissionSheetRow>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

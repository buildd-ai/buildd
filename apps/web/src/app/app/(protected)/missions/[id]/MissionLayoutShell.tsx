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
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { MISSION_LAYOUT_TABS, MISSION_LAYOUT_LABEL, missionLayoutHref, type MissionLayout } from '@/lib/mission-layout';
import type { MastheadChip } from '@/components/missions/MissionMasthead';
import { formatClock } from '@/lib/mission-board';
import { describeMissionDuration, formatDuration } from '@/lib/mission-duration';
import { useNow } from './MissionBoardParts';
import MissionSheetRow from './MissionSheetRow';

const LayoutContext = createContext<{ layout: MissionLayout; setLayout: (l: MissionLayout) => void } | null>(null);

/** The tab button's id, so the panel can name the tab that shows it. */
const tabId = (l: MissionLayout) => `mission-tab-${l}`;
export const MISSION_LAYOUT_PANEL_ID = 'mission-layout-panel';

/**
 * Underlined tabs on a hairline, as in the refined prototype: no filled
 * segment. One tab stop; ← → / Home / End move between tabs and select.
 */
export function MissionLayoutTabs({ className = '' }: { className?: string }) {
  const ctx = useContext(LayoutContext);
  if (!ctx) return null;
  const tabs = MISSION_LAYOUT_TABS;
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const at = tabs.indexOf(ctx!.layout);
    const to = e.key === 'ArrowRight' ? (at + 1) % tabs.length
      : e.key === 'ArrowLeft' ? (at - 1 + tabs.length) % tabs.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? tabs.length - 1
      : null;
    if (to == null) return;
    e.preventDefault();
    ctx!.setLayout(tabs[to]);
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[to]?.focus();
  }
  return (
    <div role="tablist" aria-label="Mission layout" data-testid="mission-layout-tabs" onKeyDown={onKeyDown} className={`flex min-w-0 gap-5 border-b border-border-default ${className}`}>
      {tabs.map(l => {
        const on = ctx.layout === l;
        return (
          <button
            key={l}
            id={tabId(l)}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={MISSION_LAYOUT_PANEL_ID}
            tabIndex={on ? 0 : -1}
            data-layout={l}
            onClick={() => ctx.setLayout(l)}
            className={`-mb-px min-h-11 border-b-2 text-title md:min-h-10 ${on ? 'border-text-primary font-semibold text-text-primary' : 'border-transparent font-medium text-text-muted hover:text-text-primary'}`}
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
      <span data-testid="mission-clock" className="font-mono text-meta text-text-muted">
        {'T+ '}<b className="font-medium tabular-nums text-text-secondary">{formatClock(openMs)}</b>
      </span>
    );
  }
  const d = describeMissionDuration({ activeMs: activeMs === undefined ? openMs : activeMs, openMs });
  return (
    <span data-testid="mission-clock" title={`Agents worked ${d.work ?? 'no time'}; open ${formatDuration(openMs)}`} className="font-mono text-meta text-text-muted">
      {d.work == null ? (
        <>{'open '}<b className="font-medium tabular-nums text-text-secondary">{d.open}</b></>
      ) : d.showOpen ? (
        <><b className="font-medium tabular-nums text-text-secondary">{d.work}</b>{' of work · open '}<b className="font-medium tabular-nums text-text-secondary">{d.open}</b></>
      ) : (
        <>{'took '}<b className="font-medium tabular-nums text-text-secondary">{d.work}</b></>
      )}
    </span>
  );
}

/**
 * Quiet header actions (Ask; the visual review starts from ⋯): no frame, a 44px target on a
 * phone. The header's one loud thing is the title.
 */
export const MISSION_HEADER_ACTION =
  'inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-card)] px-2 font-mono text-meta text-text-secondary hover:bg-surface-3 hover:text-text-primary md:min-h-9';

/**
 * The mission's name, never cut off for good: three lines on a phone (two
 * from md), and when that clips it, a control beside it opens the rest.
 */
export function MissionTitle({ title }: { title: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [title, open]);
  return (
    <div className="flex min-w-0 items-start gap-1">
      <h1
        ref={ref}
        id="mission-title"
        title={title}
        className={`min-w-0 flex-1 text-heading font-semibold leading-[1.25] tracking-[-0.01em] text-text-primary [overflow-wrap:anywhere] ${open ? '' : 'line-clamp-3 md:line-clamp-2'}`}
      >
        {title}
      </h1>
      {(clipped || open) && (
        <button
          type="button"
          data-testid="mission-title-toggle"
          aria-expanded={open}
          aria-controls="mission-title"
          aria-label={open ? 'Show less of the title' : 'Show the full title'}
          onClick={() => setOpen(o => !o)}
          className="-mr-2 -mt-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-card)] font-mono text-title text-text-muted hover:bg-surface-3 hover:text-text-primary"
        >
          <span aria-hidden="true" className={`transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}>⌄</span>
        </button>
      )}
    </div>
  );
}

/** The shared state labels are caps constants; the header reads them as a sentence: RUNNING → Running. */
const sentenceCase = (label: string) => label.charAt(0) + label.slice(1).toLowerCase();

/**
 * The Board/Flow header, top to bottom (refined prototype `MissionHead`):
 * back and the actions on one row; the title; one quiet line of state,
 * Verified and the clock; the goal line; the layout tabs.
 */
export function MissionBoardHeader({ back, title, chip, verified, actions, goal, description, serverNow, startedAt, endedAt, activeMs, children }: MissionBoardHeaderProps) {
  const now = useNow(serverNow, 1_000, endedAt == null);
  const done = endedAt != null;
  const ctx = useContext(LayoutContext);
  return (
    <div data-testid="mission-detail" className="max-w-[1120px] px-4 pb-12 pt-1 md:px-8 md:pt-3">
      <header data-testid="mission-board-header" className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-h-11 min-w-0 items-center gap-1">
          <Link href={back.href} className="-ml-1 inline-flex min-h-11 min-w-0 items-center truncate px-1 font-mono text-meta text-text-muted hover:text-text-primary">{`‹ ${back.label}`}</Link>
          <span className="flex-1" />
          <div data-testid="mission-header-actions" className="flex shrink-0 items-center gap-0.5">{actions}</div>
        </div>
        <MissionTitle title={title} />
        <div data-testid="mission-state-line" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span data-testid="mission-state-chip" className={`inline-flex shrink-0 items-center gap-1.5 text-meta font-semibold ${chip.cls}`}>
            {!done && <span aria-hidden="true" className="h-1.5 w-1.5 animate-status-pulse rounded-full bg-current" />}
            {sentenceCase(chip.label)}
          </span>
          {verified}
          <MissionClock startedAt={startedAt} endedAt={endedAt} activeMs={activeMs} now={now} />
        </div>
      </header>
      {(goal || description) && (
        <div className="mt-2 flex min-w-0 max-w-[110ch] flex-wrap items-baseline gap-x-3 gap-y-0.5 md:flex-nowrap">
          {/* Clamped at every width: a full goal on a phone pushes the strip several screens down. The full text is behind Description. */}
          {goal && <p data-testid="mission-goal-line" title={goal} className="min-w-0 break-words text-body text-text-secondary max-md:line-clamp-2 md:truncate">{goal}</p>}
          {description && (
            <MissionSheetRow inline label="Description" title="Description" testId="mission-description-open" sheetTestId="mission-description-sheet">
              {description}
            </MissionSheetRow>
          )}
        </div>
      )}
      <MissionLayoutTabs className="mt-3" />
      {ctx ? (
        <div id={MISSION_LAYOUT_PANEL_ID} role="tabpanel" aria-labelledby={tabId(ctx.layout)}>{children}</div>
      ) : children}
    </div>
  );
}

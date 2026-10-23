'use client';

/**
 * Overview, Flow and History: one layout mounted at a time, switched on the
 * client from the ⋯ menu (spec d25d923d R-3: no tab bar). A switch writes
 * `?layout=` with `replaceState` (never a router navigation). The server
 * builds only the layout the URL names; one it has not built yet is fetched
 * with one `router.refresh()`, and one shown before switches back at once.
 * Flow is a desktop view: a Flow link opened below md lands on the mission
 * page (R-2).
 *
 * Board and Flow share `MissionBoardHeader`; the Feed keeps its masthead.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MISSION_LAYOUT_TABS, MISSION_LAYOUT_LABEL, missionLayoutHref, type MissionLayout } from '@/lib/mission-layout';
import MissionSheetRow from './MissionSheetRow';
import { nativeHistoryData } from '@/lib/native-history';

const LayoutContext = createContext<{ layout: MissionLayout; setLayout: (l: MissionLayout) => void } | null>(null);

export const MISSION_LAYOUT_PANEL_ID = 'mission-layout-panel';

/**
 * The layout on screen and the one way to switch it (the ⋯ menu's History
 * and Flow rows). Null outside the shell.
 */
export function useMissionLayout(): { layout: MissionLayout; setLayout: (l: MissionLayout) => void } | null {
  return useContext(LayoutContext);
}

export interface MissionLayoutShellProps {
  initial: MissionLayout;
  /** Only the layout on screen is built by the server (spec 3ef37387 R-18); the others are null. */
  board: ReactNode;
  flow: ReactNode;
  feed: ReactNode;
}

/** Tailwind's `md` is 768px: below it, Flow opens as the mission page. */
export const BELOW_MD = '(max-width: 767.98px)';

export default function MissionLayoutShell({ initial, board, flow, feed }: MissionLayoutShellProps) {
  const [layout, set] = useState<MissionLayout>(initial);
  // The last render of each layout the server sent, so a tab shown before
  // switches back at once; the live refresh brings it up to date.
  const shown = useRef<Partial<Record<MissionLayout, ReactNode>>>({});
  const sent: Record<MissionLayout, ReactNode> = { board, flow, feed };
  for (const l of MISSION_LAYOUT_TABS) if (sent[l] != null) shown.current[l] = sent[l];
  const setLayout = useCallback((l: MissionLayout) => {
    set(l);
    try {
      // Without Next's markers, or the router never sees the URL (its patch
      // skips a write carrying `__NA`) and the refresh rebuilds the old layout.
      window.history.replaceState(nativeHistoryData(window.history.state), '', missionLayoutHref(window.location.href, l));
    } catch {
      // A sandboxed frame can refuse history writes; the tab still switches.
    }
  }, []);
  // On arrival only: a Flow link opened on a phone shows the mission page.
  const arrival = useRef(initial);
  useEffect(() => {
    if (arrival.current === 'flow' && window.matchMedia?.(BELOW_MD).matches) setLayout('board');
  }, [setLayout]);
  const value = useMemo(() => ({ layout, setLayout }), [layout, setLayout]);
  const content = shown.current[layout];
  return (
    <LayoutContext.Provider value={value}>
      <div data-testid="mission-layout" data-layout={layout}>
        {content ?? <LayoutLoading layout={layout} />}
      </div>
    </LayoutContext.Provider>
  );
}

/** How long a layout may take before the panel says it did not load. */
export const LAYOUT_LOAD_TIMEOUT_MS = 15_000;

/**
 * A layout the server has not built: it builds it for the URL that now names
 * it (one refresh when this mounts), and the way back to Overview stays
 * usable meanwhile. A refresh that brings nothing within the timeout says so,
 * with a retry.
 */
function LayoutLoading({ layout }: { layout: MissionLayout }) {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const ctx = useContext(LayoutContext);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  // One refresh per layout and per retry, whatever the router's identity.
  useEffect(() => {
    setFailed(false);
    routerRef.current.refresh();
    const t = setTimeout(() => setFailed(true), LAYOUT_LOAD_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [layout, attempt]);
  const label = MISSION_LAYOUT_LABEL[layout];
  return (
    <div className="py-10">
      {layout !== 'board' && ctx && (
        <button type="button" data-testid="mission-layout-back" onClick={() => ctx.setLayout('board')} className="-ml-1 inline-flex min-h-11 items-center px-1 font-mono text-meta text-text-muted hover:text-text-primary">
          ‹ {MISSION_LAYOUT_LABEL.board}
        </button>
      )}
      {failed ? (
        <div data-testid="mission-layout-error" role="alert" className="mt-6 flex flex-wrap items-center gap-3">
          <p className="text-body text-text-secondary">{label} didn’t load.</p>
          <button
            type="button"
            data-testid="mission-layout-retry"
            onClick={() => setAttempt(a => a + 1)}
            className="btn h-11 md:h-8"
          >
            Try again
          </button>
        </div>
      ) : (
        <p data-testid="mission-layout-loading" className="mt-6 text-body text-text-muted">Loading {label}…</p>
      )}
    </div>
  );
}

export interface MissionBoardHeaderProps {
  back: { label: string; href: string };
  title: string;
  /** The goal criteria sheet: no chip in the header (R-3); `?criteria=open` and criteria links open it. */
  verified?: ReactNode;
  actions?: ReactNode;
  /** Plain-text goal line under the title: one sentence (`missionSummaryLine`). */
  goal?: string | null;
  /** The full description, behind a `More` control beside the goal line (Navigation R-3). */
  description?: ReactNode;
  /** The one spec line under the goal, `Spec <name>` (R-3). */
  spec?: ReactNode;
  children?: ReactNode;
}

/**
 * Quiet header actions (the ⋯ menu): no frame, a 44px target on a phone. The
 * header's one loud thing is the title.
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

/**
 * The Board/Flow header, top to bottom (Navigation d25d923d R-3): back and
 * the one ⋯ menu on one row; the title; the goal as one sentence with the
 * rest behind `More`; one spec line. No state word, criteria chip or clock,
 * no tab bar, no legend, no page-level Ask link. The column keeps the
 * reading width (`--content-measure`, R-21).
 */
export function MissionBoardHeader({ back, title, verified, actions, goal, description, spec, children }: MissionBoardHeaderProps) {
  const ctx = useContext(LayoutContext);
  return (
    <div data-testid="mission-detail" className="mx-auto w-full max-w-[var(--content-measure)] px-4 pb-12 pt-1 md:px-8 md:pt-3">
      <header data-testid="mission-board-header" className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-h-11 min-w-0 items-center gap-1">
          <Link href={back.href} className="-ml-1 inline-flex min-h-11 min-w-0 items-center truncate px-1 font-mono text-meta text-text-muted hover:text-text-primary">{`‹ ${back.label}`}</Link>
          <span className="flex-1" />
          <div data-testid="mission-header-actions" className="flex shrink-0 items-center gap-0.5">{actions}</div>
        </div>
        <MissionTitle title={title} />
        {verified}
      </header>
      {(goal || description) && (
        <div className="mt-2 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          {/* One sentence, clamped at every width: a long goal runs to a paragraph and pushes the bar down. The rest is behind More. */}
          {goal && <p data-testid="mission-goal-line" title={goal} className="min-w-0 break-words text-lede text-text-secondary line-clamp-2">{goal}</p>}
          {description && (
            <MissionSheetRow inline label="More" title="Description" testId="mission-description-open" sheetTestId="mission-description-sheet">
              {description}
            </MissionSheetRow>
          )}
        </div>
      )}
      {spec && <div data-testid="mission-spec-line" className="mt-1.5">{spec}</div>}
      {ctx ? (
        <div id={MISSION_LAYOUT_PANEL_ID} data-layout-panel={ctx.layout} className="mt-5">{children}</div>
      ) : <div className="mt-5">{children}</div>}
    </div>
  );
}

'use client';

/**
 * TaskSheet: a mission task opened over the mission, which never unmounts
 * behind it (docs/design/mission-feed-mobile-continuity.md W4/W5, "Desktop
 * adaptation").
 *
 * - Mobile: `BottomSheet` at 88% height, locking `<main>` (the app shell's
 *   scroller) rather than `body`. Drag the handle down, tap ✕ or the backdrop,
 *   or press Back to close.
 * - md+: the same body docked at ~420px on the right, no backdrop, no lock.
 *
 * The header is the `micro` masthead (mission, chip, context pulse ringed on
 * this task, `n / N · PHASE`, ‹ ›). The body renders a skeleton synchronously
 * and fills from `/api/tasks/:id/summary`. Every task opens here — a completed
 * task with no PR still shows its summary, records and origin.
 *
 * It owns no history: ‹ ›, "Next needing you" and close call back into
 * TaskPanelWrapper, which writes the URL (task-sheet-history.ts).
 */
import Link from 'next/link';
import { useCallback, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import BottomSheet from '@/components/BottomSheet';
import MissionMasthead, { type MastheadChip } from '@/components/missions/MissionMasthead';
import type { PulseSegment } from '@/lib/mission-pulse';
import { missionTaskHref, taskPageHref, type MissionOrigin } from '@/lib/mission-task-href';
import TaskPanelBody, { TaskPanelSkeleton, useTaskSummary, type TaskPanelData } from './TaskPanel';
import type { TaskSheetNav } from './task-sheet-nav';

/** md breakpoint: at and above it the sheet docks instead of sliding up. */
export const TASK_SHEET_DOCK_QUERY = '(min-width: 768px)';
/** A downward drag on the handle past this closes the sheet. */
export const DRAG_CLOSE_PX = 80;

export function shouldDragClose(dy: number): boolean {
  return dy > DRAG_CLOSE_PX;
}

export interface TaskSheetMission {
  id: string;
  title: string;
  chip: MastheadChip;
  segments: readonly PulseSegment[];
  from?: MissionOrigin | null;
  initiativeId?: string | null;
}

export interface TaskSheetViewProps {
  taskId: string;
  layout: 'sheet' | 'docked';
  mission: TaskSheetMission | null;
  nav: TaskSheetNav;
  summary: { data: TaskPanelData | null; loading: boolean; error: string | null };
  onChanged: () => void | Promise<void>;
  onClose: () => void;
  /** Step to another task in place (replaceState). */
  onStep: (taskId: string) => void;
}

/** `<main>` — the element that actually scrolls in the app shell. */
const mainScroller = () => (typeof document === 'undefined' ? null : document.querySelector('main'));

function DragHandle({ onClose }: { onClose: () => void }) {
  const startY = useRef<number | null>(null);
  return (
    <div
      data-testid="task-sheet-handle"
      aria-hidden="true"
      className="-mt-2 mb-1 flex h-6 cursor-grab touch-none items-center justify-center"
      onPointerDown={e => {
        startY.current = e.clientY;
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      }}
      onPointerUp={e => {
        const from = startY.current;
        startY.current = null;
        if (from !== null && shouldDragClose(e.clientY - from)) onClose();
      }}
      onPointerCancel={() => { startY.current = null; }}
    >
      <span className="h-1 w-10 bg-border-strong" />
    </div>
  );
}

function SheetContent({ taskId, layout, mission, nav, summary, onChanged, onClose, onStep }: TaskSheetViewProps) {
  const { data, loading, error } = summary;
  const stepTo = (id: string | null) => (id ? () => onStep(id) : undefined);
  const sheetHref = (id: string) =>
    mission
      ? missionTaskHref({ missionId: mission.id, taskId: id, from: mission.from, initiativeId: mission.initiativeId, mode: 'sheet' })
      : taskPageHref({ taskId: id });
  const next = nav.nextNeedingYou;

  return (
    <div className="space-y-4">
      {layout === 'sheet' && <DragHandle onClose={onClose} />}

      {mission && (
        <MissionMasthead
          size="micro"
          title={mission.title}
          chip={mission.chip}
          segments={mission.segments}
          selectedTaskId={taskId}
          position={nav.position}
          onStep={dir => {
            const id = dir === 'prev' ? nav.prevTaskId : nav.nextTaskId;
            stepTo(id)?.();
          }}
          className="border-b border-border-default pb-1"
        />
      )}

      {loading && !data && <TaskPanelSkeleton />}
      {error && !data && (
        <p className="py-6 text-center font-mono text-[13px] text-status-error">{error}</p>
      )}
      {data && <TaskPanelBody data={data} onChanged={onChanged} />}

      <nav className="border-t border-border-default">
        {next && (
          <a
            data-testid="task-sheet-next-needing-you"
            href={sheetHref(next.taskId)}
            onClick={e => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              onStep(next.taskId);
            }}
            className="flex min-h-11 items-center gap-2 border-b border-border-default font-mono text-[12px] text-accent-text hover:underline"
          >
            <span className="shrink-0 text-text-muted">Next needing you:</span>
            <span className="min-w-0 flex-1 truncate">{next.title}</span>
            <span aria-hidden="true">›</span>
          </a>
        )}
        <Link
          data-testid="task-sheet-full-page"
          href={taskPageHref({ taskId, missionId: mission?.id ?? data?.missionId ?? null })}
          className="flex min-h-11 items-center justify-between font-mono text-[12px] text-text-secondary hover:text-text-primary"
        >
          <span>Open full page</span>
          <span aria-hidden="true">›</span>
        </Link>
      </nav>
    </div>
  );
}

function DockedShell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside
      role="dialog"
      aria-label={title}
      data-testid="mission-task-sheet"
      data-layout="docked"
      className="fixed bottom-0 right-0 top-0 z-40 flex w-[420px] max-w-full flex-col border-l-2 border-border-strong bg-surface-1"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border-default px-4 py-2">
        <h2 className="min-w-0 truncate font-mono text-[13px] font-semibold text-text-primary">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center text-text-muted hover:text-text-primary"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">{children}</div>
    </aside>
  );
}

/** Presentational: the shell for `layout` around the header + body. */
export function TaskSheetView(props: TaskSheetViewProps) {
  const title = props.summary.data?.title ?? 'Task';
  if (props.layout === 'docked') {
    return (
      <DockedShell title={title} onClose={props.onClose}>
        <SheetContent {...props} />
      </DockedShell>
    );
  }
  return (
    <BottomSheet
      open
      onClose={props.onClose}
      title={title}
      height="tall"
      lockTarget={mainScroller}
      testId="mission-task-sheet"
    >
      <SheetContent {...props} />
    </BottomSheet>
  );
}

function subscribeDock(onChange: () => void) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(TASK_SHEET_DOCK_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
const readDock = () => typeof window !== 'undefined' && !!window.matchMedia?.(TASK_SHEET_DOCK_QUERY).matches;

/** Mobile-first: `sheet` on the server and below md, `docked` at md+. */
export function useTaskSheetLayout(): 'sheet' | 'docked' {
  return useSyncExternalStore(subscribeDock, readDock, () => false) ? 'docked' : 'sheet';
}

export interface TaskSheetProps {
  taskId: string;
  mission: TaskSheetMission | null;
  nav: TaskSheetNav;
  workspaceId?: string | null;
  onClose: () => void;
  onStep: (taskId: string) => void;
}

export default function TaskSheet({ taskId, mission, nav, workspaceId, onClose, onStep }: TaskSheetProps) {
  const layout = useTaskSheetLayout();
  const summary = useTaskSummary(taskId, { workspaceId });
  const { refetch } = summary;
  const onChanged = useCallback(() => refetch(), [refetch]);
  return (
    <TaskSheetView
      taskId={taskId}
      layout={layout}
      mission={mission}
      nav={nav}
      summary={summary}
      onChanged={onChanged}
      onClose={onClose}
      onStep={onStep}
    />
  );
}

'use client';

/**
 * TaskSheet: a mission task opened over the mission, which never unmounts
 * behind it (knowledge-base: buildd/design/mission-feed-mobile-continuity.md W4/W5, "Desktop
 * adaptation").
 *
 * It renders in the shared `SideSheet`, so Records, Notes or goal criteria
 * opened over it stack in the same place with Back, never a modal on top.
 *
 * - Mobile: a bottom sheet at 88% height, locking `<main>` (the app shell's
 *   scroller) rather than `body`. The drag handle sits above the header, out
 *   of the scrolling body. Drag it down, tap ✕ or the backdrop, or press Back
 *   to close. It is modal: focus moves in on open and Tab stays inside.
 * - md+: the same body docked at 420px on the right, no backdrop, no lock.
 *   Focus moves into it on open. On close TaskPanelWrapper returns focus to
 *   the task's row.
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
import { useCallback, useRef, useSyncExternalStore } from 'react';
import SideSheet from '@/components/SideSheet';
import MissionMasthead, { type MastheadChip } from '@/components/missions/MissionMasthead';
import type { PulseSegment } from '@/lib/mission-pulse';
import { missionTaskHref, taskPageHref, type MissionOrigin } from '@/lib/mission-task-href';
import TaskPanelBody, { TaskPanelSkeleton, useTaskSummary, type TaskPanelData } from './TaskPanel';
import type { TaskSheetNav } from './task-sheet-nav';
import { taskHeading } from '@/app/app/(protected)/tasks/[id]/task-header';
import AuditRoundTrays from '@/app/app/(protected)/tasks/[id]/AuditRoundTrays';

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

function DragHandle({ onClose }: { onClose: () => void }) {
  const startY = useRef<number | null>(null);
  return (
    <div
      data-testid="task-sheet-handle"
      aria-hidden="true"
      className="flex h-6 shrink-0 cursor-grab touch-none items-center justify-center"
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

function SheetContent({ taskId, mission, nav, summary, onChanged, onStep }: TaskSheetViewProps) {
  const { data, loading, error } = summary;
  const stepTo = (id: string | null) => (id ? () => onStep(id) : undefined);
  const sheetHref = (id: string) =>
    mission
      ? missionTaskHref({ missionId: mission.id, taskId: id, from: mission.from, initiativeId: mission.initiativeId, mode: 'sheet' })
      : taskPageHref({ taskId: id });
  const next = nav.nextNeedingYou;

  return (
    <div className="space-y-4">
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
      {/* A visual audit's screens: its round's Tray (the deck opens inline,
          in the sheet), not the shots as title links. */}
      {data?.visual && (
        <section data-testid="task-sheet-visual" className="border-t border-border-default pt-3">
          <h3 className="section-label mb-2">Screens</h3>
          <AuditRoundTrays key={data.id} visual={data.visual} layout="sheet" columns="one" />
        </section>
      )}

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

/** Presentational: the task in the shared side sheet (docked at md+, a bottom sheet below). */
export function TaskSheetView(props: TaskSheetViewProps) {
  // The sentence the task page heads with, not the raw "feat(scope): …" title.
  const title = props.summary.data ? taskHeading(props.summary.data, null).heading : 'Task';
  return (
    <SideSheet
      open
      onClose={props.onClose}
      title={title}
      layout={props.layout}
      testId="mission-task-sheet"
      handle={<DragHandle onClose={props.onClose} />}
      frontKey={props.taskId}
    >
      <SheetContent {...props} />
    </SideSheet>
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
